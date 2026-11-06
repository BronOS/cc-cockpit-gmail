'use strict'
// Remote pictures (0.6.0): which addresses a picture URL may reach (SSRF), redirects, the picture
// types and sizes, the image proxy, the loader's budget, and when a mail's pictures load at all.
// DNS and the request are faked (resolve / send) except in the nodeSend tests, which talk to a local
// server on 127.0.0.1 directly (nodeSend itself connects where it is told; fetchImage decides where).
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const R = require('../dist/lib/remote')
const { readAppSettings } = require('../dist/lib/settings')
const { picture } = require('./fakes')

test('blockedAddress: loopback, private, link-local, CGNAT, multicast and reserved, IPv4 and IPv6 alike', () => {
  const table = {
    // IPv4
    '127.0.0.1': 'loopback',
    '127.255.0.9': 'loopback',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.31.255.255': 'private',
    '192.168.1.10': 'private',
    '169.254.169.254': 'link-local', // the cloud metadata address
    '100.64.0.1': 'CGNAT',
    '100.127.255.254': 'CGNAT',
    '0.0.0.0': 'this-network',
    '224.0.0.1': 'multicast',
    '239.255.255.250': 'multicast',
    '255.255.255.255': 'reserved',
    '192.0.2.1': 'reserved',
    '198.18.0.1': 'reserved',
    '172.32.0.1': null,
    '100.128.0.1': null,
    '93.184.216.34': null,
    '8.8.8.8': null,
    // IPv6
    '::1': 'loopback',
    '::': 'unspecified',
    'fe80::1': 'link-local',
    'fe80::1%eth0': 'link-local',
    'fd12:3456::1': 'private',
    'fc00::1': 'private',
    'ff02::1': 'multicast',
    'fec0::1': 'site-local',
    '2001:db8::1': 'documentation',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2': 'Teredo',
    // IPv6 forms that carry an IPv4 address: that address decides.
    '::ffff:127.0.0.1': 'loopback',
    '::ffff:7f00:1': 'loopback',
    '::ffff:10.0.0.1': 'private',
    '::ffff:169.254.169.254': 'link-local',
    '::ffff:93.184.216.34': null,
    '::127.0.0.1': 'loopback',
    '64:ff9b::a00:1': 'private', // NAT64 of 10.0.0.1
    '64:ff9b::5db8:d822': null, // NAT64 of 93.184.216.34
    '64:ff9b:1::1': 'private',
    '2002:c0a8:0101::1': 'private', // 6to4 of 192.168.1.1
    '2002:5db8:d822::1': null,
    '[::1]': 'loopback',
    '2606:4700:4700::1111': null,
    // Not an address at all.
    'example.com': 'not an address',
    '': 'not an address',
  }
  for (const [a, why] of Object.entries(table)) assert.equal(R.blockedAddress(a), why, a)
})

test('checkUrl: http(s) only, no credentials, no control characters', () => {
  for (const bad of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'ftp://example.com/a.png', 'https://ann:pw@example.com/a.png', 'https://example.com/a b.png', 'https://example.com/\n', '', 'x'.repeat(3000)]) {
    assert.throws(() => R.checkUrl(bad), undefined, bad)
  }
  assert.equal(R.checkUrl('https://cdn.example.com/a.png?x=1').hostname, 'cdn.example.com')
  assert.ok(R.localName('localhost') && R.localName('printer') && R.localName('nas.local') && R.localName('git.internal') && R.localName('box.home.arpa'))
  assert.ok(!R.localName('cdn.example.com'))
})

const PUBLIC = '93.184.216.34'
const PNG = picture('png', 2000)

/**
 * A fake world: `names` host -> addresses (an IP literal resolves to itself), `routes` URL -> what
 * the server answers ({ location } | { type, body }). Records every resolve and request.
 */
function world(names = {}, routes = {}) {
  const w = { resolved: [], sent: [] }
  w.resolve = async (host) => {
    w.resolved.push(host)
    const h = host.replace(/^\[|\]$/g, '')
    if (require('node:net').isIP(h)) return [{ address: h, family: h.includes(':') ? 6 : 4 }]
    if (!names[h]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    return names[h].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  w.send = async (req) => {
    w.sent.push(req)
    const r = routes[req.url]
    if (!r) throw new Error(`the server answered 404`)
    if (r.location) return { status: 302, location: r.location }
    if (r.body.length > req.maxBytes) throw new Error('too big')
    return { status: 200, type: r.type || 'image/png', body: r.body }
  }
  return w
}

test('fetchImage: a public picture, connected to the address that was checked', async () => {
  const w = world({ 'cdn.example.com': [PUBLIC] }, { 'https://cdn.example.com/a.png': { body: PNG } })
  const r = await R.fetchImage('https://cdn.example.com/a.png', w)
  assert.equal(r.mime, 'image/png')
  assert.equal(r.body.length, 2000)
  assert.equal(w.sent[0].address, PUBLIC, 'the lookup is pinned')
  assert.equal(w.sent[0].family, 4)
})

test('fetchImage: every resolved address is checked, IP literals included', async () => {
  const w = world({ 'mixed.example.com': [PUBLIC, '10.0.0.7'], 'rebind.example.com': ['127.0.0.1'], 'v6.example.com': ['::ffff:192.168.0.1'] }, {})
  await assert.rejects(R.fetchImage('https://mixed.example.com/a.png', w), /refused: mixed\.example\.com is a private address/)
  await assert.rejects(R.fetchImage('https://rebind.example.com/a.png', w), /loopback/)
  await assert.rejects(R.fetchImage('https://v6.example.com/a.png', w), /private/)
  await assert.rejects(R.fetchImage('http://169.254.169.254/latest/meta-data', w), /link-local/)
  await assert.rejects(R.fetchImage('http://[::1]:8080/a.png', w), /loopback/)
  await assert.rejects(R.fetchImage('http://100.64.1.1/a.png', w), /CGNAT/)
  await assert.rejects(R.fetchImage('http://nowhere.example.com/a.png', w), /cannot resolve nowhere\.example\.com: ENOTFOUND/)
  assert.equal(w.sent.length, 0, 'no request left the machine')
})

test('fetchImage: redirects are checked like the first request, at most 3', async () => {
  const names = { 'cdn.example.com': [PUBLIC], 'evil.example.com': [PUBLIC], 'inside.example.com': ['192.168.1.1'] }
  const routes = {
    'https://evil.example.com/a.png': { location: 'http://127.0.0.1:631/admin' },
    'https://evil.example.com/b.png': { location: 'https://inside.example.com/x.png' },
    'https://evil.example.com/c.png': { location: 'file:///etc/passwd' },
    'https://cdn.example.com/1': { location: '/2' },
    'https://cdn.example.com/2': { location: '/3' },
    'https://cdn.example.com/3': { location: '/4' },
    'https://cdn.example.com/4': { location: '/5' },
    'https://cdn.example.com/5': { body: PNG },
  }
  const w = world(names, routes)
  await assert.rejects(R.fetchImage('https://evil.example.com/a.png', w), /loopback/)
  await assert.rejects(R.fetchImage('https://evil.example.com/b.png', w), /inside\.example\.com is a private address/)
  await assert.rejects(R.fetchImage('https://evil.example.com/c.png', w), /only http and https/)
  await assert.rejects(R.fetchImage('https://cdn.example.com/1', w), /more than 3 redirects/)
  assert.equal((await R.fetchImage('https://cdn.example.com/2', w)).mime, 'image/png', 'three redirects are fine')
  assert.ok(!w.sent.some((s) => s.address === '127.0.0.1' || s.address === '192.168.1.1'))
})

test('fetchImage: png, jpeg, gif and webp only, by the type and by the bytes; SVG refused; the size capped', async () => {
  const names = { 'cdn.example.com': [PUBLIC] }
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  const routes = {
    'https://cdn.example.com/a.svg': { type: 'image/svg+xml', body: svg },
    'https://cdn.example.com/fake.png': { type: 'image/png', body: svg },
    'https://cdn.example.com/page': { type: 'text/html', body: Buffer.from('<html>') },
    'https://cdn.example.com/big.png': { body: picture('png', 800 * 1024) },
    'https://cdn.example.com/a.jpg': { type: 'image/jpeg', body: picture('jpeg', 100) },
    'https://cdn.example.com/a.gif': { type: 'image/gif', body: picture('gif', 100) },
    'https://cdn.example.com/a.webp': { type: 'image/webp', body: picture('webp', 100) },
  }
  const w = world(names, routes)
  await assert.rejects(R.fetchImage('https://cdn.example.com/a.svg', w), /not a png, jpeg, gif or webp picture \(image\/svg\+xml\)/)
  await assert.rejects(R.fetchImage('https://cdn.example.com/fake.png', w), /by its bytes/)
  await assert.rejects(R.fetchImage('https://cdn.example.com/page', w), /text\/html/)
  await assert.rejects(R.fetchImage('https://cdn.example.com/big.png', w), /too big/, 'over 700 KiB')
  for (const [u, mime] of [['a.jpg', 'image/jpeg'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp']]) assert.equal((await R.fetchImage(`https://cdn.example.com/${u}`, w)).mime, mime)
  assert.equal(w.sent[0].maxBytes, 700 * 1024)
})

test('image proxy: {url} encoded, the proxy host exempt, the target checked without DNS, redirects checked', async () => {
  const proxy = R.parseProxy('http://img.example.com:8080/fetch?u={url}')
  assert.deepEqual(proxy, { template: 'http://img.example.com:8080/fetch?u={url}', hostKey: 'http://img.example.com:8080' })
  const target = 'https://cdn.example.com/a.png?id=Ann Example&x=1'.replace(' ', '%20')
  const via = R.requestUrl(target, proxy)
  assert.equal(via, `http://img.example.com:8080/fetch?u=${encodeURIComponent(target)}`)
  // The proxy runs on the person's own network: its private address is fine.
  const names = { 'img.example.com': ['192.168.1.20'], 'cdn.example.com': [PUBLIC] }
  const routes = { [via]: { body: PNG }, [R.requestUrl('https://cdn.example.com/r.png', proxy)]: { location: 'http://10.0.0.1/x.png' } }
  const w = world(names, routes)
  assert.equal((await R.fetchImage(target, { ...w, proxy })).mime, 'image/png')
  assert.deepEqual(w.resolved, ['img.example.com'], 'the picture host is never resolved: its DNS would learn of the open')
  assert.equal(w.sent[0].address, '192.168.1.20')
  // The target is still checked, statically: a private literal or a local name never goes to the proxy.
  for (const bad of ['http://127.0.0.1/a.png', 'http://[::ffff:10.0.0.1]/a.png', 'http://intranet/a.png', 'http://router.local/a.png', 'file:///etc/passwd']) {
    await assert.rejects(R.fetchImage(bad, { ...w, proxy }), /refused|only http/, bad)
  }
  // A redirect the proxy answers goes where any request goes: checked.
  await assert.rejects(R.fetchImage('https://cdn.example.com/r.png', { ...w, proxy }), /10\.0\.0\.1 is a private address/)
  // A bad template is a problem, and no picture is loaded rather than fetched directly.
  assert.match(R.parseProxy('https://img.example.com/').error, /\{url\} exactly once/)
  assert.match(R.parseProxy('https://img.example.com/{url}/{url}').error, /exactly once/)
  assert.match(R.parseProxy('ftp://img.example.com/{url}').error, /only http and https/)
  assert.equal(R.parseProxy('  '), null)
  const s = readAppSettings({ remoteImages: 'always', imageProxy: 'nope {url}' })
  assert.equal(s.proxyBroken, true)
  assert.equal(s.proxy, null)
  assert.match(s.problems[0], /^imageProxy: .*remote pictures are not loaded until it is fixed/)
  assert.deepEqual(readAppSettings({}), { remoteImages: 'ask', proxy: null, proxyBroken: false, problems: [], defaultView: 'original' })
  assert.equal(readAppSettings({ remoteImages: 'weird' }).remoteImages, 'ask')
  assert.equal(readAppSettings({ defaultView: 'reader' }).defaultView, 'reader')
  assert.equal(readAppSettings({ defaultView: 'raw' }).defaultView, 'original')
})

test('showRemote: Ask waits for the person; Always, a listed sender or Show images on this mail load', () => {
  const senders = R.cleanSenders([' Ann@Example.com ', 'ann@example.com', 'not an address', 7, 'bob@example.com'])
  assert.deepEqual(senders, ['ann@example.com', 'bob@example.com'])
  assert.equal(R.showRemote({ mode: 'ask', senders, address: 'carol@example.com', shown: false }), false)
  assert.equal(R.showRemote({ mode: 'ask', senders, address: 'ANN@example.com', shown: false }), true)
  assert.equal(R.showRemote({ mode: 'ask', senders, address: 'carol@example.com', shown: true }), true)
  assert.equal(R.showRemote({ mode: 'always', senders: [], address: '', shown: false }), true)
  assert.equal(R.showRemote({ mode: 'ask', senders, address: '', shown: false }), false)
  assert.equal(R.cleanSenders(Array.from({ length: 600 }, (_, i) => `u${i}@example.com`)).length, R.MAX_SENDERS)
})

test('loadRemote: at most maxCount pictures within the budget; failures listed; the slow ones given up', async () => {
  const names = { 'cdn.example.com': [PUBLIC], 'lan.example.com': ['10.0.0.9'] }
  const routes = {}
  const refs = []
  for (let i = 0; i < 6; i++) {
    routes[`https://cdn.example.com/${i}.png`] = { body: picture('png', 30000) }
    refs.push({ id: `r${i}`, url: `https://cdn.example.com/${i}.png`, alt: `pic ${i}` })
  }
  refs.push({ id: 'rlan', url: 'https://lan.example.com/x.png', alt: 'lan' })
  const w = world(names, routes)
  const r = await R.loadRemote(refs, { ...w, maxCount: 7 })
  assert.deepEqual(r.assets.map((a) => a.id), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
  assert.match(r.assets[0].dataUrl, /^data:image\/png;base64,/)
  assert.equal(r.assets[0].name, 'pic 0')
  assert.deepEqual(r.failed.map((f) => f.message), ['refused: lan.example.com is a private address'])
  // The count: three tried, the rest skipped.
  const few = await R.loadRemote(refs, { ...world(names, routes), maxCount: 3 })
  assert.equal(few.assets.length, 3)
  assert.equal(few.skipped, 4)
  // The budget in data URL characters: two pictures of 30000 bytes are about 80000 characters.
  const tight = await R.loadRemote(refs.slice(0, 6), { ...world(names, routes), budgetChars: 85000 })
  assert.equal(tight.assets.length, 2)
  assert.equal(tight.skipped + tight.failed.length, 4, 'the rest skipped, or too big for what was left')
  assert.ok(tight.assets.reduce((n, a) => n + a.dataUrl.length, 0) <= 85000)
  // Never more than MAX_IMAGES, whatever is asked.
  assert.equal((await R.loadRemote([], { maxCount: 99 })).assets.length, 0)
  // A server that never answers: given up after waitMs, its request aborted.
  let aborted = 0
  const hang = { resolve: w.resolve, send: (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => (aborted++, rej(new Error('aborted'))))) }
  const slow = await R.loadRemote(refs.slice(0, 2), { ...hang, waitMs: 30 })
  assert.equal(slow.assets.length, 0)
  assert.equal(slow.skipped, 2)
  assert.equal(aborted, 2)
})

// ---- nodeSend, against a real server on 127.0.0.1 ----

function server(handler) {
  return new Promise((resolve) => {
    const seen = []
    const s = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers })
      handler(req, res)
    })
    s.listen(0, '127.0.0.1', () => resolve({ s, seen, base: `http://pictures.example.com:${s.address().port}` }))
  })
}

test('nodeSend: the pinned address, a fixed User-Agent and no cookie; redirects, types and the size cap', async () => {
  const { s, seen, base } = await server((req, res) => {
    if (req.url === '/a.png') return res.writeHead(200, { 'Content-Type': 'image/png', 'Set-Cookie': 'id=1' }).end(PNG)
    if (req.url === '/moved') return res.writeHead(302, { Location: '/a.png' }).end()
    if (req.url === '/page') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>')
    if (req.url === '/declared-big') return res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(5000) }).end(picture('png', 5000))
    if (req.url === '/streamed-big') {
      // No Content-Length: the cap is enforced while the bytes come in.
      res.writeHead(200, { 'Content-Type': 'image/png' })
      for (let i = 0; i < 10; i++) res.write(picture('png', 1000))
      return res.end()
    }
    if (req.url === '/slow') return setTimeout(() => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG), 500)
    res.writeHead(404).end()
  })
  try {
    // The name does not resolve anywhere: the pinned lookup sends it to 127.0.0.1 all the same.
    const req = (path, o = {}) => R.nodeSend({ url: `${base}${path}`, address: '127.0.0.1', family: 4, timeoutMs: 2000, maxBytes: 4096, ...o })
    const ok = await req('/a.png')
    assert.equal(ok.type, 'image/png')
    assert.equal(ok.body.length, PNG.length)
    assert.equal(seen[0].headers['user-agent'], R.USER_AGENT)
    assert.equal(seen[0].headers.cookie, undefined)
    assert.equal(seen[0].headers.referer, undefined)
    assert.match(seen[0].headers.host, /^pictures\.example\.com:/)
    await req('/a.png')
    assert.equal(seen[1].headers.cookie, undefined, 'a cookie set before is never sent back')
    assert.deepEqual(await req('/moved'), { status: 302, location: '/a.png' })
    await assert.rejects(req('/page'), /text\/html/)
    await assert.rejects(req('/declared-big'), /too big/)
    await assert.rejects(req('/streamed-big'), /too big/)
    await assert.rejects(req('/nothing'), /answered 404/)
    await assert.rejects(req('/slow', { timeoutMs: 50 }), /timed out/)
  } finally {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
})
