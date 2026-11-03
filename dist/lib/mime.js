'use strict'
// The MIME tree of a message as Gmail's format=full gives it (`payload` with `parts`, each with
// `mimeType`, `filename`, `headers` and `body: { data?, attachmentId?, size }`): which part is the
// HTML body, which the plain one, which parts are pictures (inline by Content-ID, or attached) and
// which are other attachments (listed, not downloaded in v1).
//
// Bodies are base64url; their charset comes from the part's Content-Type (TextDecoder knows the
// WHATWG labels: utf-8, iso-8859-x, windows-125x, koi8-r, shift_jis, gb18030, ...; an unknown one
// falls back to utf-8 with replacement characters, never an error).

const MAX_PARTS = 500 // a hostile message can nest parts without end; the walk stops here
const MAX_DEPTH = 30

/** A part's header by name (any case), '' when absent. */
function partHeader(part, name) {
  const hs = part && Array.isArray(part.headers) ? part.headers : []
  const want = name.toLowerCase()
  const h = hs.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === want)
  return h && typeof h.value === 'string' ? h.value : ''
}

/** The charset of a Content-Type value (`text/html; charset="ISO-8859-1"`), default utf-8. */
function charsetOf(contentType) {
  const m = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(String(contentType || ''))
  return m ? m[1].toLowerCase() : 'utf-8'
}

/** base64url bytes as text in `charset`. */
function decodeText(data, charset) {
  const buf = Buffer.from(String(data || ''), 'base64url')
  let dec
  try {
    dec = new TextDecoder(charset || 'utf-8', { fatal: false })
  } catch {
    dec = new TextDecoder('utf-8', { fatal: false })
  }
  return dec.decode(buf)
}

/** The image type Gmail claims for a part, normalised (`image/jpg` is common and means jpeg). */
function imageMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg'
  return m
}

/**
 * What a message holds: `{ html, plain, htmlPart, plainPart, images, files }`.
 * - `html` / `plain`: the first text/html and text/plain part that is not an attachment, decoded;
 *   null when absent, or when its body is not inline (`htmlPart` / `plainPart` then name it, so the
 *   caller can fetch it as an attachment).
 * - `images`: `{ partId, name, mime, size, cid, attachmentId, data, inline }` for every image part
 *   (cid: its Content-ID without the brackets, lower case, or '').
 * - `files`: `{ partId, name, mime, size }` of every other attachment.
 */
function walkMessage(m) {
  const out = { html: null, plain: null, htmlPart: null, plainPart: null, images: [], files: [] }
  let count = 0
  const visit = (part, depth) => {
    if (!part || typeof part !== 'object' || depth > MAX_DEPTH || ++count > MAX_PARTS) return
    const mime = String(part.mimeType || '').toLowerCase()
    const name = typeof part.filename === 'string' ? part.filename : ''
    const disposition = partHeader(part, 'Content-Disposition').toLowerCase()
    const body = part.body && typeof part.body === 'object' ? part.body : {}
    const isAttachment = Boolean(name) || disposition.startsWith('attachment')
    if (Array.isArray(part.parts) && part.parts.length) {
      for (const p of part.parts) visit(p, depth + 1)
      return
    }
    if (mime.startsWith('image/')) {
      const cid = partHeader(part, 'Content-ID').trim().replace(/^<|>$/g, '').trim().toLowerCase()
      out.images.push({
        partId: String(part.partId == null ? '' : part.partId),
        name: name || (cid ? cid.split('@')[0] : 'image'),
        mime: imageMime(mime),
        size: Number.isFinite(body.size) ? body.size : null,
        cid,
        attachmentId: typeof body.attachmentId === 'string' ? body.attachmentId : null,
        data: typeof body.data === 'string' ? body.data : null,
        inline: Boolean(cid) && !disposition.startsWith('attachment'),
      })
      return
    }
    if (!isAttachment && mime === 'text/html' && out.html === null && out.htmlPart === null) {
      if (typeof body.data === 'string') out.html = decodeText(body.data, charsetOf(partHeader(part, 'Content-Type')))
      else if (body.attachmentId) out.htmlPart = { attachmentId: body.attachmentId, charset: charsetOf(partHeader(part, 'Content-Type')), size: body.size }
      return
    }
    if (!isAttachment && mime === 'text/plain' && out.plain === null && out.plainPart === null) {
      if (typeof body.data === 'string') out.plain = decodeText(body.data, charsetOf(partHeader(part, 'Content-Type')))
      else if (body.attachmentId) out.plainPart = { attachmentId: body.attachmentId, charset: charsetOf(partHeader(part, 'Content-Type')), size: body.size }
      return
    }
    if (isAttachment || body.attachmentId) {
      out.files.push({ partId: String(part.partId == null ? '' : part.partId), name: name || '(unnamed)', mime, size: Number.isFinite(body.size) ? body.size : null })
    }
  }
  visit(m && m.payload, 0)
  return out
}

module.exports = { walkMessage, partHeader, charsetOf, decodeText, imageMime, MAX_PARTS }
