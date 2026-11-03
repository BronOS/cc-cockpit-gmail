'use strict'
// The thread view's pictures (design "The thread view"): which image parts are downloaded and
// inlined, the size budget, the on-disk cache, and the bounded wait when a thread is opened. Ported
// from bronos.jira's images.js; the budgets are the same.
//
// The reviewer's HTML mode takes images as `assets` at call time only (`[{ id, name, mime, dataUrl
// }]`: png, jpeg, gif, webp; each dataUrl at most 1,000,000 chars, all of them at most 8 MiB, at
// most 30). The plugin stays under that with room to spare:
// - at most 15 images a thread, inline (`cid:`) pictures of the newest messages first, then the
//   attached ones (an inline picture is part of what the mail says; attachments are extra);
// - each at most 700 KiB raw (716,800 bytes, so its base64 dataUrl is at most 955,759 chars); a
//   bigger one is listed with its size (no image scaling in a plain JS host);
// - all dataUrls together at most 7.5 MiB (7,864,320 chars), below the 8 MiB cap;
// - the wait for downloads is bounded (10 s an open): what is not there by then is listed by name
//   this time. Downloads already running finish in the background into the cache, so the next open
//   has them; none starts after the wait.
// The bytes are checked against the image formats themselves (magic numbers), not the type the mail
// claims: an SVG or an HTML page sent as `x.png` is never handed on as a picture.
//
// Gmail's attachment ids are not stable (each read of a message gives new ones), so the cache key
// is the message id and the part id, hashed: `<account hash>-<sha256(messageId:partId) 24>.img`.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES = 15
const MAX_IMAGE_BYTES = 700 * 1024
const MAX_TOTAL_CHARS = 7.5 * 1024 * 1024
const MAX_DATAURL_CHARS = 1000000 // the reviewer's cap for one asset
const WAIT_MS = 10000
const CONCURRENCY = 3
const CACHE_MAX_FILES = 300
const CACHE_MAX_BYTES = 64 * 1024 * 1024

/** The length of the dataUrl a picture of `bytes` bytes becomes (`data:<mime>;base64,` + base64). */
function dataUrlLength(bytes, mime = 'image/jpeg') {
  return `data:${mime};base64,`.length + 4 * Math.ceil(bytes / 3)
}

/** The stable key of an image part: its message and part ids. */
function partKey(img) {
  return crypto.createHash('sha256').update(`${img.messageId}:${img.partId}`).digest('hex').slice(0, 24)
}

/** The asset id the reviewer's `data-asset` names (letters and digits only). */
function assetId(img) {
  return `img${partKey(img).slice(0, 16)}`
}

/**
 * Which image parts to fetch: `wanted` (in the order above) and `skipped` (over the per-image
 * size, past the count or past the total budget). A part whose size Gmail did not give is budgeted
 * at the per-image maximum (the download enforces it).
 *
 * @param {{ messageId: string, partId: string, mime: string, size: number|null, at: number, inline: boolean }[]} images
 */
function selectImages(images, o = {}) {
  const max = o.max || MAX_IMAGES
  const maxBytes = o.maxBytes || MAX_IMAGE_BYTES
  const budget = o.totalChars || MAX_TOTAL_CHARS
  const pics = (images || []).filter((i) => RASTER.has(i.mime)).sort((x, y) => Number(y.inline) - Number(x.inline) || (y.at || 0) - (x.at || 0))
  const wanted = []
  const skipped = []
  let total = 0
  for (const a of pics) {
    const bytes = a.size === null || a.size === undefined ? maxBytes : a.size
    const chars = dataUrlLength(bytes, a.mime)
    if (bytes > maxBytes || wanted.length >= max || total + chars > budget) {
      skipped.push(a)
      continue
    }
    wanted.push(a)
    total += chars
  }
  return { wanted, skipped }
}

/** The image type of the bytes (png, jpeg, gif, webp), or null for anything else. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  const head = buf.toString('latin1', 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** `{ mime, dataUrl }` of the bytes when they are a picture, else null. */
function toDataUrl(buf) {
  const mime = sniff(buf)
  if (!mime) return null
  return { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
}

/**
 * The downloaded originals, one file per image part under `dir`, for one account (the data folder
 * is per project, whose account can change). Bounded: at most 300 files and 64 MiB; the least
 * recently used go first. A read refreshes the file's time.
 */
function imageCache(dir, account, limits = {}) {
  const prefix = crypto.createHash('sha256').update(String(account)).digest('hex').slice(0, 12)
  const maxFiles = limits.maxFiles || CACHE_MAX_FILES
  const maxBytes = limits.maxBytes || CACHE_MAX_BYTES
  const fileOf = (key) => {
    if (!/^[a-f0-9]{24}$/.test(String(key))) throw new Error('an image key is 24 hex digits')
    return path.join(dir, `${prefix}-${key}.img`)
  }
  let chain = Promise.resolve()
  return {
    dir,
    async get(key) {
      const file = fileOf(key)
      try {
        const buf = await fs.promises.readFile(file)
        const t = new Date()
        await fs.promises.utimes(file, t, t).catch(() => {})
        return buf
      } catch {
        return null
      }
    },
    put(key, buf) {
      const file = fileOf(key)
      chain = chain
        .then(async () => {
          await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
          const tmp = `${file}.${process.pid}.tmp`
          await fs.promises.writeFile(tmp, buf, { mode: 0o600 })
          await fs.promises.rename(tmp, file)
          await prune(dir, maxFiles, maxBytes)
        })
        .catch(() => {})
      return chain
    },
    flush: () => chain,
  }
}

/** The oldest files go until at most `maxFiles` and `maxBytes` are left. */
async function prune(dir, maxFiles, maxBytes) {
  const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.img'))
  const files = []
  for (const n of names) {
    try {
      const st = await fs.promises.stat(path.join(dir, n))
      files.push({ file: path.join(dir, n), size: st.size, at: st.mtimeMs })
    } catch {
      // Gone meanwhile.
    }
  }
  files.sort((a, b) => b.at - a.at)
  let total = 0
  for (let i = 0; i < files.length; i++) {
    total += files[i].size
    if (i >= maxFiles || total > maxBytes) await fs.promises.unlink(files[i].file).catch(() => {})
  }
}

/**
 * The assets of an open: cached images at once, inline data at once, the others downloaded (at
 * most 3 at a time) until `waitMs` passes. Resolves with `{ assets, byKey, late, failed }`:
 * `assets` in `wanted`'s order within the total budget, `byKey` part key -> asset id, `late` how
 * many were not there in time, `failed` `[{ name, message }]`. Never rejects.
 *
 * @param {object} o
 * @param {object[]} o.wanted selectImages' `wanted`
 * @param {((img: object, signal: AbortSignal) => Promise<Buffer>) | null} o.download
 * @param {ReturnType<typeof imageCache>} o.cache
 * @param {number} [o.waitMs]
 * @param {AbortSignal} [o.signal] the host's stop
 */
async function gatherImages(o) {
  const waitMs = o.waitMs === undefined ? WAIT_MS : o.waitMs
  const got = new Map() // part key -> Buffer
  const failed = []
  const todo = []
  for (const a of o.wanted) {
    const key = partKey(a)
    if (a.data) {
      // Small parts come inline in format=full: no download, no cache.
      const buf = Buffer.from(a.data, 'base64url')
      if (buf.length <= MAX_IMAGE_BYTES && sniff(buf)) got.set(key, buf)
      else failed.push({ name: a.name, message: sniff(buf) ? 'too big' : 'not a png, jpeg, gif or webp picture' })
      continue
    }
    const buf = await o.cache.get(key)
    if (buf) got.set(key, buf)
    else if (a.attachmentId) todo.push(a)
  }
  let late = false
  if (todo.length && o.download) {
    let next = 0
    const worker = async () => {
      while (next < todo.length && !late && !(o.signal && o.signal.aborted)) {
        const a = todo[next++]
        const key = partKey(a)
        try {
          const buf = await o.download(a, o.signal)
          if (!sniff(buf)) throw new Error('not a png, jpeg, gif or webp picture')
          await o.cache.put(key, buf)
          if (!late) got.set(key, buf)
        } catch (e) {
          if (!late) failed.push({ name: a.name, message: e && e.message ? e.message : String(e) })
        }
      }
    }
    const all = Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
    let timer
    const wait = new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
    await Promise.race([all, wait])
    clearTimeout(timer)
    late = true
  }
  const assets = []
  const byKey = new Map()
  let total = 0
  for (const a of o.wanted) {
    const key = partKey(a)
    const buf = got.get(key)
    if (!buf) continue
    const d = toDataUrl(buf)
    if (!d || d.dataUrl.length > MAX_DATAURL_CHARS || total + d.dataUrl.length > MAX_TOTAL_CHARS) continue
    total += d.dataUrl.length
    const id = assetId(a)
    assets.push({ id, name: a.name, mime: d.mime, dataUrl: d.dataUrl })
    byKey.set(key, id)
  }
  const missing = todo.filter((a) => !got.has(partKey(a)) && !failed.some((f) => f.name === a.name)).length
  return { assets, byKey, late: o.download ? missing : 0, failed }
}

module.exports = {
  RASTER,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_CHARS,
  MAX_DATAURL_CHARS,
  WAIT_MS,
  dataUrlLength,
  partKey,
  assetId,
  selectImages,
  sniff,
  toDataUrl,
  imageCache,
  gatherImages,
}
