'use strict'
// A mail's remote pictures (0.6.0, design "Remote images"): fetched by this host, never by a page,
// only when the person allows it (Remote images "Always", a sender on the always-show list, or Show
// images on this mail), and handed to the reviewer as assets, as the mail's own `cid:` pictures are.
//
// Remote pictures are how senders learn that a mail was opened (a unique URL per recipient), and a
// URL in a mail is hostile input that can name any address, the person's router or a service on
// their own machine included. So every request:
// - is a GET of an http(s) URL with no user:password, no cookie (Node's http keeps none), no
//   Referer, `Accept-Encoding: identity` and one fixed generic User-Agent;
// - resolves its host here and refuses it when any address is loopback, private, link-local,
//   CGNAT, multicast, reserved or documentation space, IPv4 and IPv6 alike (IPv4-mapped, NAT64,
//   6to4 and IPv4-compatible forms are read as the IPv4 address they carry; Teredo is refused);
//   the connection then goes to the address that was checked (the lookup is pinned), so a DNS
//   answer that changes between the check and the connect (rebinding) cannot reach another one;
// - follows at most 3 redirects, each checked the same way;
// - takes only image/png, jpeg, gif or webp, by the Content-Type and by the bytes themselves (SVG
//   can carry script and is refused);
// - is capped: 700 KiB a picture (the reviewer takes 1,000,000 characters of data URL per asset, and
//   each asset is one page message), 5.5 MiB and 30 pictures a mail within what the reviewer's 8 MiB
//   leave beside the mail's other pictures, 10 s a picture and 15 s for all of them.
//
// Image proxy (the setting `imageProxy`, empty by default; no public proxy is built in): a template
// such as `https://img.example.com/?url={url}`, `{url}` replaced by the picture's URL encoded. The
// proxy's own host (scheme, host and port of the template) is exempt from the address check: the
// person chose it, and a proxy on their own network is the usual set-up. The picture's URL is then
// checked without a DNS lookup (scheme, no credentials, no private or loopback IP literal, no
// localhost, .local, .internal or single-label name): resolving it here would tell the sender's DNS
// that the mail was opened, which a proxy is there to avoid. A redirect the proxy answers is checked
// like any other request (exempt again only back on the proxy's host).

const dns = require('node:dns')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const { sniff, RASTER, MAX_IMAGE_BYTES, MAX_DATAURL_CHARS, MAX_TOTAL_CHARS } = require('./images')

const USER_AGENT = 'Mozilla/5.0 (compatible)'
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
const MAX_REDIRECTS = 3
const MAX_IMAGES = 30 // the reviewer's cap of assets a document has
const MAX_MAIL_BYTES = 5.5 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10000
const WAIT_MS = 15000
const CONCURRENCY = 4
const MAX_URL = 2048
const MAX_SENDERS = 500 // the always-show list

// ---- addresses ----

/** Why an IPv4 address (four numbers) is refused, or null when it is a public one. */
function ipv4Blocked([a, b, c]) {
  if (a === 0) return 'this-network'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
  if (a === 127) return 'loopback'
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved'
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  return null
}

function parseV4(s) {
  const p = s.split('.')
  if (p.length !== 4) return null
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN))
  return n.every((x) => x >= 0 && x <= 255) ? n : null
}

/** An IPv6 address as its 8 groups (numbers), or null. Handles `::`, a zone id and an IPv4 tail. */
function parseV6(s) {
  let t = s.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t)
  if (tail) {
    const v4 = parseV4(tail[1])
    if (!v4) return null
    t = t.slice(0, tail.index) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = t.split('::')
  if (halves.length > 2) return null
  const part = (x) => (x ? x.split(':') : [])
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : []
  const fill = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

const v4Of = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]

/** Why an IPv6 address (8 groups) is refused, or null when it is a public one. */
function ipv6Blocked(g) {
  const zeroTo = (n) => g.slice(0, n).every((x) => x === 0)
  if (zeroTo(8)) return 'unspecified'
  if (zeroTo(7) && g[7] === 1) return 'loopback'
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the IPv4 address decides.
  if (zeroTo(5) && g[5] === 0xffff) return ipv4Blocked(v4Of(g[6], g[7]))
  if (zeroTo(6)) return ipv4Blocked(v4Of(g[6], g[7])) || 'reserved'
  // NAT64 (64:ff9b::/96) carries an IPv4 address; its local-use range (64:ff9b:1::/48) is private.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Blocked(v4Of(g[6], g[7]))
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'private'
  if (g[0] === 0x2002) return ipv4Blocked(v4Of(g[1], g[2])) // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return 'Teredo' // carries an obfuscated IPv4 address
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'documentation'
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return 'discard'
  if ((g[0] & 0xfe00) === 0xfc00) return 'private' // unique local, fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local'
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local'
  if ((g[0] & 0xff00) === 0xff00) return 'multicast'
  return null
}

/** Why an address is refused (`loopback`, `private`, …), or null for a public one. Not an IP: refused. */
function blockedAddress(address) {
  const a = String(address || '')
  if (net.isIPv4(a)) return ipv4Blocked(parseV4(a))
  if (net.isIPv6(a.replace(/^\[|\]$/g, '').replace(/%.*$/, ''))) {
    const g = parseV6(a)
    return g ? ipv6Blocked(g) : 'not an address'
  }
  return 'not an address'
}

/** A name that only means something on the person's own network or machine (checked without DNS). */
function localName(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || /\.(?:localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(h)) return true
  return !h.includes('.') && !h.includes(':') // a single label: a LAN host name
}

// ---- URLs ----

/** An http(s) URL with no credentials and no control characters, as a URL; throws why not. */
function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL || /[\x00-\x1f\x7f\s]/.test(raw)) throw new Error('not a usable URL')
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('not a usable URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https URLs are loaded')
  if (u.username || u.password) throw new Error('a URL with a user name or password is refused')
  if (!u.hostname) throw new Error('not a usable URL')
  return u
}

const hostKey = (u) => `${u.protocol}//${u.host.toLowerCase()}`

/**
 * The image proxy setting: null when empty, `{ template, hostKey }` when usable, `{ error }` when not
 * (shown as a problem; pictures are then not loaded at all rather than fetched directly behind the
 * person's back). One `{url}`, http(s), no credentials.
 */
function parseProxy(template) {
  const t = typeof template === 'string' ? template.trim() : ''
  if (!t) return null
  if (t.split('{url}').length !== 2) return { error: 'the image proxy URL must contain {url} exactly once' }
  let u
  try {
    u = checkUrl(t.replace('{url}', 'x'))
  } catch (e) {
    return { error: `the image proxy URL: ${e.message}` }
  }
  return { template: t, hostKey: hostKey(u) }
}

/** The URL to request for a picture: through the proxy (its `{url}` encoded) or the picture's own. */
function requestUrl(url, proxy) {
  return proxy && proxy.template ? proxy.template.replace('{url}', encodeURIComponent(url)) : url
}

// ---- requests ----

/** The real DNS: every address of a name (an IP literal answers itself). */
async function systemResolve(hostname) {
  return dns.promises.lookup(hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true })
}

/**
 * One GET with node:http(s), connected to `address` (the lookup is pinned to the address that was
 * checked). Resolves `{ status, location }` for a redirect, `{ status, type, body }` for a picture;
 * rejects for anything else: another status, a type that is not a picture, more than `maxBytes`,
 * `timeoutMs` passed.
 */
function nodeSend({ url, address, family, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    let done = false
    const finish = (fn, v) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      fn(v)
    }
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT, 'Accept-Encoding': 'identity' },
        agent: false, // no pooled connection, no state kept between requests
        lookup: (hostname, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        signal,
      },
      (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return finish(resolve, { status, location: String(res.headers.location) })
        }
        if (status !== 200) {
          res.resume()
          return finish(reject, new Error(`the server answered ${status}`))
        }
        const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        if (!RASTER.has(type)) {
          res.resume()
          return finish(reject, new Error(`not a png, jpeg, gif or webp picture (${type || 'no type'})`))
        }
        const length = Number(res.headers['content-length'])
        if (Number.isFinite(length) && length > maxBytes) {
          res.resume()
          return finish(reject, new Error('too big'))
        }
        const chunks = []
        let got = 0
        res.on('data', (c) => {
          got += c.length
          if (got > maxBytes) {
            req.destroy()
            finish(reject, new Error('too big'))
          } else chunks.push(c)
        })
        res.on('end', () => finish(resolve, { status, type, body: Buffer.concat(chunks) }))
        res.on('error', (e) => finish(reject, e))
      },
    )
    const deadline = setTimeout(() => {
      req.destroy()
      finish(reject, new Error('timed out'))
    }, timeoutMs)
    if (deadline.unref) deadline.unref()
    req.on('error', (e) => finish(reject, e))
    req.end()
  })
}

/**
 * The bytes of one remote picture, checked as the header says (SSRF, redirects, type, size).
 * Resolves `{ mime, body }` (mime from the bytes); rejects with why not.
 *
 * @param {string} url the picture's URL, as the mail has it
 * @param {object} o
 * @param {{ template: string, hostKey: string } | null} [o.proxy] parseProxy's answer
 * @param {(host: string) => Promise<{ address: string, family: number }[]>} [o.resolve] DNS (tests fake it)
 * @param {(req: object) => Promise<object>} [o.send] one request (tests fake it): nodeSend's contract
 * @param {number} [o.maxBytes] @param {number} [o.timeoutMs] @param {AbortSignal} [o.signal]
 */
async function fetchImage(url, o = {}) {
  const resolve = o.resolve || systemResolve
  const send = o.send || nodeSend
  const proxy = o.proxy && o.proxy.template ? o.proxy : null
  const maxBytes = o.maxBytes || MAX_IMAGE_BYTES
  const timeoutMs = o.timeoutMs || IMAGE_TIMEOUT_MS
  const target = checkUrl(url)
  if (proxy) {
    // Checked without DNS (see the header): an IP literal by its address, a local name by its name.
    const host = target.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host) ? blockedAddress(host) : localName(host)) throw new Error(`refused: ${target.hostname} is a local or private address`)
  }
  let current = requestUrl(target.href, proxy)
  for (let hop = 0; ; hop++) {
    const u = checkUrl(current)
    const exempt = proxy !== null && hostKey(u) === proxy.hostKey
    let addrs
    try {
      addrs = await resolve(u.hostname)
    } catch (e) {
      throw new Error(`cannot resolve ${u.hostname}: ${e && e.code ? e.code : e && e.message ? e.message : e}`)
    }
    if (!Array.isArray(addrs) || !addrs.length) throw new Error(`cannot resolve ${u.hostname}`)
    if (!exempt) {
      // Every address, not only the first: the connection may go to any of them.
      for (const a of addrs) {
        const why = blockedAddress(a.address)
        if (why) throw new Error(`refused: ${u.hostname} is a ${why} address`)
      }
    }
    const first = addrs[0]
    const r = await send({ url: u.href, address: first.address, family: first.family || (net.isIPv6(first.address) ? 6 : 4), timeoutMs, maxBytes, signal: o.signal })
    if (r && r.location !== undefined) {
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
      let next
      try {
        next = new URL(r.location, u).href
      } catch {
        throw new Error('a redirect to an unusable URL')
      }
      current = next
      continue
    }
    if (!r || !Buffer.isBuffer(r.body)) throw new Error('no picture in the answer')
    if (!RASTER.has(r.type)) throw new Error(`not a png, jpeg, gif or webp picture (${r.type || 'no type'})`)
    if (r.body.length > maxBytes) throw new Error('too big')
    // The bytes decide, not the header: an SVG or a page served as image/png is no picture here.
    const mime = sniff(r.body)
    if (!mime) throw new Error('not a png, jpeg, gif or webp picture (by its bytes)')
    return { mime, body: r.body }
  }
}

/**
 * The pictures of `refs` (`[{ id, url, alt }]`, in document order, ids unique), as reviewer assets.
 * At most `maxCount` (default 30) are tried, CONCURRENCY at a time, each at most 700 KiB, all within
 * `budgetChars` of data URL (what the reviewer's budget leaves) and MAX_MAIL_BYTES; what is not there
 * after `waitMs` is given up (its requests aborted). Never rejects.
 *
 * @returns {Promise<{ assets: { id, name, mime, dataUrl }[], failed: { url: string, message: string }[], skipped: number }>}
 */
async function loadRemote(refs, o = {}) {
  const maxCount = Math.max(0, Math.min(MAX_IMAGES, o.maxCount === undefined ? MAX_IMAGES : o.maxCount))
  const budgetChars = Math.max(0, o.budgetChars === undefined ? MAX_TOTAL_CHARS : o.budgetChars)
  const mailBytes = Math.min(MAX_MAIL_BYTES, Math.floor((budgetChars * 3) / 4))
  const list = (refs || []).slice(0, maxCount)
  let skipped = (refs || []).length - list.length
  const abort = new AbortController()
  const onStop = () => abort.abort()
  if (o.signal) o.signal.addEventListener('abort', onStop, { once: true })
  const got = new Map()
  const failed = []
  let reserved = 0
  let inflight = 0
  let next = 0
  let over = false
  // Each request reserves the most it may take; a worker that finds too little room left waits for a
  // request in flight to end (it gives back what its picture did not use) before giving up: else a
  // tight budget went to the first request alone and the others skipped pictures that fit.
  let waiters = []
  const settled = () => new Promise((r) => waiters.push(r))
  const worker = async () => {
    while (next < list.length && !over && !abort.signal.aborted) {
      const ref = list[next++]
      let allow = Math.min(MAX_IMAGE_BYTES, mailBytes - reserved)
      while (allow < 1024 && inflight > 0 && !over && !abort.signal.aborted) {
        await settled()
        allow = Math.min(MAX_IMAGE_BYTES, mailBytes - reserved)
      }
      if (allow < 1024 || over || abort.signal.aborted) {
        skipped++
        continue
      }
      reserved += allow
      inflight++
      try {
        const r = await fetchImage(ref.url, { ...o, maxBytes: allow, signal: abort.signal })
        reserved -= allow - r.body.length
        if (!over) got.set(ref.id, r)
      } catch (e) {
        reserved -= allow
        if (!over) failed.push({ url: ref.url, message: e && e.message ? e.message : String(e) })
      } finally {
        inflight--
        const w = waiters
        waiters = []
        for (const f of w) f()
      }
    }
  }
  const all = Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker))
  let timer
  const wait = new Promise((r) => {
    timer = setTimeout(r, o.waitMs === undefined ? WAIT_MS : o.waitMs)
    if (timer.unref) timer.unref()
  })
  await Promise.race([all, wait])
  clearTimeout(timer)
  over = true
  abort.abort() // whatever still runs is given up: nothing starts or lands after the wait
  if (o.signal) o.signal.removeEventListener('abort', onStop)
  const assets = []
  let total = 0
  for (const ref of list) {
    const r = got.get(ref.id)
    if (!r) continue
    const dataUrl = `data:${r.mime};base64,${r.body.toString('base64')}`
    if (dataUrl.length > MAX_DATAURL_CHARS || total + dataUrl.length > budgetChars) {
      skipped++
      continue
    }
    total += dataUrl.length
    assets.push({ id: ref.id, name: ref.alt || 'image', mime: r.mime, dataUrl })
  }
  const late = list.filter((ref) => !got.has(ref.id) && !failed.some((f) => f.url === ref.url)).length
  return { assets, failed, skipped: skipped + late }
}

// ---- the policy ----

/**
 * Whether a message's remote pictures are loaded when it opens: always with Remote images "Always",
 * for a sender on the always-show list, for a mail the person asked Show images on this run; else
 * they wait for the person (the bar).
 */
function showRemote({ mode, senders, address, shown }) {
  if (shown) return true
  if (mode === 'always') return true
  const a = String(address || '').toLowerCase()
  return Boolean(a) && Array.isArray(senders) && senders.includes(a)
}

/** The always-show list as stored: lower-case addresses, each once, at most MAX_SENDERS. */
function cleanSenders(list) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const a = typeof x === 'string' ? x.trim().toLowerCase() : ''
    if (/^[^\s@<>"]{1,64}@[^\s@<>"]{1,253}$/.test(a) && !out.includes(a)) out.push(a)
    if (out.length >= MAX_SENDERS) break
  }
  return out
}

module.exports = {
  blockedAddress,
  parseV6,
  localName,
  checkUrl,
  parseProxy,
  requestUrl,
  fetchImage,
  loadRemote,
  nodeSend,
  showRemote,
  cleanSenders,
  USER_AGENT,
  MAX_REDIRECTS,
  MAX_IMAGES,
  MAX_MAIL_BYTES,
  MAX_SENDERS,
  IMAGE_TIMEOUT_MS,
  WAIT_MS,
}
