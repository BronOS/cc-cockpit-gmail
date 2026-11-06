'use strict'
// Mail HTML made safe and plain for the reviewer's HTML mode (and the plugin's own reader page).
//
// Mail HTML is hostile input: anyone can send the person a mail. So nothing of it is passed on as
// markup. It is tokenized and built into a small tree here (no dependency: a plain tokenizer of the
// HTML syntax and a tree builder with the implicit-close rules mail needs), and the output is
// written fresh from that tree: only the tags of the reviewer's allow-list, every text and every
// attribute value escaped, and only the few attributes this file sets itself:
//
// - tags: h1-h6, p, br, hr, ul, ol, li, pre, code, blockquote, table, thead, tbody, tr, th, td, a,
//   img, strong, em, s, u, sub, sup, span, div, details, summary, figure, figcaption, dl, dt, dd
//   (`ccc guide plugins`, "The reviewer service"). b/i/strike/... are renamed to their kin; any
//   other tag is unwrapped (its text kept) or, for code, styles, embedded documents, forms' controls
//   and media, dropped with everything inside.
// - attributes: `href` on a link (http, https or mailto only, normalised by URL; a link inside a
//   link loses its own), `data-asset` + `alt` + `title` on an image, `colspan` / `rowspan` on a
//   data table's cells, `title` (cut). No class, id, style, event handler or anything else of the
//   mail's survives.
// - images: never loaded from here. A `cid:` image (a part of the mail itself) becomes a reviewer
//   asset when the caller downloaded it (`o.cid`). An http(s) image (0.6.0) is never a link: in the
//   mail layout (`o.remote.mode` 'placeholder') it is `<img data-asset="r…" class="mail-remote">`
//   naming the asset the host may load later (images.remoteAssetId of its URL), which the reviewer
//   shows as a dashed chip with the alt text until the asset comes; elsewhere ('label') it is the
//   "[image: alt]" text, or the picture when the host loaded it already (`o.remote.loaded`). A 1x1
//   one is a tracking pixel and dropped altogether; a logo, an avatar or a tiny one is `mail-minor`
//   (hidden until loaded) or, as a label, dropped; a tiny one whose alt is a symbol (Jira's "→") is
//   that symbol as text. Any other src is its alt text. The remote ones are listed in the result
//   (`remote`), for the host's loader.
// - the sender's footer (0.6.0): boilerplate after the last content block (unsubscribe, privacy
//   policy, "this email was sent by", app-store badges, manage preferences) is folded into a
//   `<details class="mail-footer">` "Sender's footer" (foldFooter: conservative, see there).
// - a lone "View …" / "Open …" link (the call to action of a notification) gets `mail-cta` with
//   `o.mail`, so the mail layout draws it as a button.
// - alt and title: decoded once more when a decoded value still holds a character reference
//   (senders that escape twice, such as Jira's `alt="&amp;#x2192;"`, showed `&#x2192;` literally).
// - quoted history (Gmail's `gmail_quote`, Apple Mail's `blockquote type=cite`, Outlook's
//   `divRplyFwdMsg` and what follows it, Yahoo's `yahoo_quoted`) is folded into `<details>`.
// - hidden content (`display:none`, `visibility:hidden`, `hidden`): the preheader text marketing
//   mail hides is dropped, since without the mail's styles it would show.
// - layout tables (most HTML mail is tables in tables) are unwrapped into divs; a data table (more
//   than one column, no table inside, not role=presentation) stays a table.
//
// Safety does not depend on this parser agreeing with a browser's: whatever it makes of the input,
// the output holds only allow-listed elements and escaped text, so a browser's parse of the output
// cannot differ from what was meant (the parser differential behind mutation XSS has nothing to work
// on). The reviewer sanitizes again (a second wall), and its page runs no inline script.
//
// Bounded: at most 2,000,000 characters of input (the rest is cut, with a line saying so), 200
// levels of nesting (deeper elements are flattened, their text kept), 100,000 nodes.

const { esc, decode } = require('./entities')
const { sha } = require('./util')

/**
 * The reviewer asset id of a remote picture: `r` and a hash of its URL (letters and digits, as the
 * reviewer's ids are). The same URL twice in a mail is one asset; the host's loader names the
 * picture it fetched with the same id, so it fills every placeholder of that URL.
 */
const remoteAssetId = (url) => `r${sha(url, 20)}`

const MAX_INPUT = 2000000
const MAX_DEPTH = 200
const MAX_NODES = 100000
const MAX_ATTRS = 100
const MAX_TITLE = 300
const MAX_HREF = 2048
const MAX_REMOTE = 200 // remote pictures listed per body (the loader takes 30 a mail at most anyway)

const ALLOWED = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'strong', 'em', 's', 'u', 'sub', 'sup',
  'span', 'div', 'details', 'summary', 'figure', 'figcaption', 'dl', 'dt', 'dd',
])
// Kin of allowed tags: the meaning stays, the tag is one the reviewer keeps.
const RENAME = {
  b: 'strong', i: 'em', strike: 's', del: 's', ins: 'u', tt: 'code', kbd: 'code', samp: 'code', var: 'em', cite: 'em',
  dfn: 'em', mark: 'strong', center: 'div', section: 'div', article: 'div', header: 'div', footer: 'div', main: 'div',
  nav: 'div', aside: 'div', address: 'div', tfoot: 'tbody', listing: 'pre',
}
// Dropped with everything inside them. Raw-text elements (script, style, ...) are swallowed by the
// tokenizer itself; the others are skipped by the tree builder until their end tag.
const DROP = new Set([
  'script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'noscript', 'noembed',
  'noframes', 'svg', 'math', 'input', 'button', 'select', 'textarea', 'datalist', 'output', 'meter',
  'progress', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area', 'link', 'meta', 'base', 'title', 'head', 'portal',
  'slot', 'dialog', 'xmp', 'plaintext', 'marquee', 'colgroup', 'col', 'basefont', 'bgsound', 'keygen', 'image',
])
// Content up to `</name` is raw text in HTML: the tokenizer must not see tags in it (`<style>` with
// `<p>` inside is one style element). `plaintext` runs to the end of the document.
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'title', 'textarea'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'basefont', 'bgsound', 'frame', 'image'])
// A start tag of one of these closes an open <p> (HTML's "close a p element"), within a table cell.
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'ul', 'listing', 'plaintext', 'xmp', 'li', 'dd', 'dt',
])
const SCOPE = new Set(['td', 'th', 'table', 'caption', 'html', 'template', 'object', 'marquee', 'applet', 'button'])
const IN_HEAD = new Set(['meta', 'link', 'style', 'script', 'title', 'base', 'noscript', 'template', 'basefont', 'bgsound', 'head'])

// ---- tokenizer ----

const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f'

/**
 * Tokens of an HTML string, in order: `{ type: 'text', text }` (entities not decoded yet),
 * `{ type: 'start', name, attrs: Map, selfClosing }`, `{ type: 'end', name }`, and `{ type: 'raw',
 * name, text }` for a raw-text element's content. Comments, doctypes, CDATA and processing
 * instructions produce nothing (Outlook's conditional comments carry markup that must not show).
 * Linear in the input: every step moves forward.
 */
function tokenize(s) {
  const out = []
  const n = s.length
  let i = 0
  const text = (t) => {
    if (t) out.push({ type: 'text', text: t })
  }
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      text(s.slice(i))
      break
    }
    if (lt > i) text(s.slice(i, lt))
    i = lt
    const c = s[i + 1]
    if (c === '!') {
      if (s.startsWith('<!--', i)) {
        // `<!-->` and `<!--->` end at once (HTML's abrupt-closing comment); else `-->` or `--!>`.
        if (s.startsWith('<!-->', i)) {
          i += 5
          continue
        }
        if (s.startsWith('<!--->', i)) {
          i += 6
          continue
        }
        const a = s.indexOf('-->', i + 4)
        const b = s.indexOf('--!>', i + 4)
        if (a < 0 && b < 0) {
          i = n // an unclosed comment runs to the end
        } else if (b >= 0 && (a < 0 || b < a)) i = b + 4
        else i = a + 3
        continue
      }
      // A doctype, CDATA (a bogus comment in HTML content) or another bogus comment: up to `>`.
      const gt = s.indexOf('>', i + 2)
      i = gt < 0 ? n : gt + 1
      continue
    }
    if (c === '?') {
      const gt = s.indexOf('>', i + 2)
      i = gt < 0 ? n : gt + 1
      continue
    }
    if (c === '/') {
      if (isAlpha(s[i + 2] || '')) {
        let j = i + 2
        while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++
        const name = s.slice(i + 2, j).toLowerCase()
        // An end tag's attributes are parsed (a quoted `>` does not end it) and thrown away.
        const r = attributes(s, j)
        if (!r) break // EOF inside the tag: HTML drops it
        out.push({ type: 'end', name })
        i = r.end
        continue
      }
      if (s[i + 2] === '>') {
        i += 3
        continue
      }
      if (i + 2 >= n) {
        text('</')
        break
      }
      const gt = s.indexOf('>', i + 2)
      i = gt < 0 ? n : gt + 1
      continue
    }
    if (isAlpha(c || '')) {
      let j = i + 1
      while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++
      const name = s.slice(i + 1, j).toLowerCase()
      const r = attributes(s, j)
      if (!r) break
      out.push({ type: 'start', name, attrs: r.attrs, selfClosing: r.selfClosing })
      i = r.end
      if (name === 'plaintext') {
        out.push({ type: 'raw', name, text: s.slice(i) })
        i = n
      } else if (RAW_TEXT.has(name)) {
        const close = findRawEnd(s, i, name)
        out.push({ type: 'raw', name, text: s.slice(i, close < 0 ? n : close) })
        if (close < 0) {
          i = n
        } else {
          out.push({ type: 'end', name })
          const gt = s.indexOf('>', close)
          i = gt < 0 ? n : gt + 1
        }
      }
      continue
    }
    // `<` not starting a tag (`a < b`, `<3`): text.
    text('<')
    i += 1
  }
  return out
}

/** Where `</name` (any case, then a space, `/` or `>`) starts at or after `from`, or -1. */
function findRawEnd(s, from, name) {
  let at = from
  for (;;) {
    const k = s.indexOf('</', at)
    if (k < 0) return -1
    const after = s[k + 2 + name.length]
    if (s.slice(k + 2, k + 2 + name.length).toLowerCase() === name && (after === undefined || isSpace(after) || after === '/' || after === '>')) return k
    at = k + 2
  }
}

/**
 * The attributes of a tag from `i` (just past its name) to its `>`: `{ attrs, selfClosing, end }`,
 * or null when the input ends inside the tag. Names are lower-cased; a repeated name keeps the first
 * value (as browsers do); values are raw (entities decoded later).
 */
function attributes(s, i) {
  const n = s.length
  const attrs = new Map()
  let selfClosing = false
  for (;;) {
    while (i < n && (isSpace(s[i]) || s[i] === '/')) {
      selfClosing = s[i] === '/'
      i++
    }
    if (i >= n) return null
    if (s[i] === '>') return { attrs, selfClosing, end: i + 1 }
    selfClosing = false
    // A name: anything up to a space, `/`, `>` or `=` (a leading `=` belongs to the name).
    let j = i + 1
    while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++
    const name = s.slice(i, j).toLowerCase()
    i = j
    while (i < n && isSpace(s[i])) i++
    let value = ''
    if (s[i] === '=') {
      i++
      while (i < n && isSpace(s[i])) i++
      const q = s[i]
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, i + 1)
        if (e < 0) return null
        value = s.slice(i + 1, e)
        i = e + 1
      } else {
        let k = i
        while (k < n && !isSpace(s[k]) && s[k] !== '>') k++
        value = s.slice(i, k)
        i = k
      }
    }
    if (name && !attrs.has(name) && attrs.size < MAX_ATTRS) attrs.set(name, value)
  }
}

// ---- tree ----

function el(name, attrs, parent) {
  return { name, attrs: attrs || new Map(), children: [], parent }
}

/**
 * The document tree of an HTML string: elements `{ name, attrs, children, parent }` and text
 * `{ text }` (decoded). Dropped elements never enter it. Implicit closes as HTML does them for the
 * cases mail relies on (an unclosed <p>, <li>, <td>, <tr>, a link inside a link).
 */
function parse(html) {
  let s = String(html == null ? '' : html)
  let truncated = false
  if (s.length > MAX_INPUT) {
    s = s.slice(0, MAX_INPUT)
    truncated = true
  }
  // NUL is never a character in an HTML document (browsers drop it or make it U+FFFD).
  s = s.replace(/\0/g, '�')
  const root = el('#root', null, null)
  const stack = [root]
  let nodes = 0
  let skip = null // { name, depth } while inside a dropped element that is not raw text
  const top = () => stack[stack.length - 1]
  const has = (name, stopAt) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].name === name) return k
      if (stopAt && stopAt.has(stack[k].name)) return -1
    }
    return -1
  }
  const closeTo = (k) => {
    if (k > 0) stack.length = k
  }
  for (const t of tokenize(s)) {
    if (skip) {
      // A <head> left open ends where the body starts, as browsers end it: at <body> or at the first
      // tag that cannot be in a head. Without this, a mail with an unclosed head would show nothing.
      if (skip.name === 'head' && t.type === 'start' && !IN_HEAD.has(t.name)) skip = null
      else {
        if (t.type === 'start' && t.name === skip.name && !t.selfClosing) skip.depth++
        else if (t.type === 'end' && t.name === skip.name && --skip.depth === 0) skip = null
        continue
      }
    }
    if (t.type === 'text') {
      if (nodes++ > MAX_NODES) {
        truncated = true
        continue
      }
      const parent = top()
      const last = parent.children[parent.children.length - 1]
      const decoded = decode(t.text)
      if (last && last.text !== undefined) last.text += decoded
      else parent.children.push({ text: decoded })
      continue
    }
    if (t.type === 'raw') continue // the content of a dropped raw-text element
    if (t.type === 'end') {
      if (t.name === 'br') {
        top().children.push(el('br', null, top()))
        continue
      }
      // An end tag closes its element only within the same table cell (a stray </div> in a cell does
      // not end the table around it, as in a browser).
      const k = has(t.name, SCOPE.has(t.name) ? null : SCOPE)
      if (k > 0) closeTo(k)
      continue
    }
    // A start tag.
    const name = t.name
    // A bare <option> outside a <select> (whose content is dropped anyway) is only its text: its end
    // tag is often left out, and skipping to it would swallow the rest of the mail.
    if (name === 'option' || name === 'optgroup') continue
    if (DROP.has(name)) {
      if (!VOID.has(name) && !RAW_TEXT.has(name) && !t.selfClosing && name !== 'plaintext') skip = { name, depth: 1 }
      continue
    }
    // Past the node cap the rest of the mail is left out and said to be (sanitizeHtml's note).
    if (nodes++ > MAX_NODES) {
      truncated = true
      continue
    }
    // Implicit closes.
    if (CLOSES_P.has(name)) {
      const k = has('p', SCOPE)
      if (k > 0) closeTo(k)
    }
    if (name === 'li') {
      const k = has('li', new Set(['ul', 'ol', ...SCOPE]))
      if (k > 0) closeTo(k)
    } else if (name === 'dt' || name === 'dd') {
      const k = Math.max(has('dt', new Set(['dl', ...SCOPE])), has('dd', new Set(['dl', ...SCOPE])))
      if (k > 0) closeTo(k)
    } else if (name === 'td' || name === 'th') {
      const k = Math.max(has('td', new Set(['tr', 'table'])), has('th', new Set(['tr', 'table'])))
      if (k > 0) closeTo(k)
    } else if (name === 'tr') {
      const stop = new Set(['table', 'tbody', 'thead', 'tfoot'])
      const k = Math.max(has('tr', stop), has('td', stop), has('th', stop))
      if (k > 0) closeTo(k)
    } else if (name === 'tbody' || name === 'thead' || name === 'tfoot') {
      const stop = new Set(['table'])
      const k = Math.max(has('tbody', stop), has('thead', stop), has('tfoot', stop))
      if (k > 0) closeTo(k)
    } else if (name === 'a') {
      const k = has('a')
      if (k > 0) closeTo(k)
    } else if (/^h[1-6]$/.test(name) && /^h[1-6]$/.test(top().name)) {
      stack.pop()
    }
    const node = el(name, t.attrs, top())
    top().children.push(node)
    // Deeper than MAX_DEPTH: the element is kept (empty) but not entered, so its text lands in the
    // parent; the walk below never recurses past this depth.
    if (!VOID.has(name) && !t.selfClosing && stack.length < MAX_DEPTH) stack.push(node)
    else if (!VOID.has(name) && !t.selfClosing) node.flattened = true
  }
  return { root, truncated }
}

// ---- output ----

/**
 * The href a link may keep: an absolute http(s) or mailto address, normalised by URL; null for
 * javascript:, data:, file:, a relative link (it has nowhere to go from the reviewer's page), a
 * user:password one, and anything with a control character (`java\tscript:` is read past by
 * browsers).
 */
function safeHref(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > MAX_HREF || /[\x00-\x1f\x7f]/.test(v)) return null
  let u
  try {
    u = new URL(v)
  } catch {
    return null
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.username || u.password ? null : u.href
  if (u.protocol === 'mailto:') return u.href
  return null
}

function classes(node) {
  return String(node.attrs.get('class') || '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** Hidden by the mail itself: a preheader or tracking text that only its styles keep out of sight. */
function isHidden(node) {
  if (node.attrs.has('hidden')) return true
  const style = decode(node.attrs.get('style') || '').toLowerCase().replace(/\s+/g, '')
  return /(^|;)display:none(!important)?(;|$)/.test(style) || /(^|;)visibility:hidden(!important)?(;|$)/.test(style) || /(^|;)max-height:0(px)?(!important)?(;|$)/.test(style) && /overflow:hidden/.test(style)
}

/** Gmail's, Apple Mail's and Yahoo's quoted history: the element itself is the quote. */
function isQuote(node) {
  const cls = classes(node)
  if (cls.includes('gmail_quote') || cls.includes('gmail_quote_container') || cls.includes('yahoo_quoted') || cls.includes('protonmail_quote')) return true
  return node.name === 'blockquote' && String(node.attrs.get('type') || '').toLowerCase() === 'cite'
}

/** Outlook's reply header: it and everything after it (in its parent) is the quoted mail. */
function isOutlookQuoteStart(node) {
  const id = String(node.attrs.get('id') || '').toLowerCase()
  return node.name !== undefined && (id === 'divrplyfwdmsg' || id === 'appendonsend' || id === 'mail-editor-reference-message-container')
}

/** A whole number from an attribute or a CSS length (`1`, `1px`), else NaN. */
function px(v) {
  const m = /^\s*(\d{1,6})(?:px)?\s*$/i.exec(decode(String(v || '')))
  return m ? Number(m[1]) : NaN
}

/** A 1x1 (or 0, 2, 3 px) remote picture: a tracking pixel, never content. */
function isPixel(node) {
  const style = decode(node.attrs.get('style') || '').toLowerCase()
  const sw = /(?:^|;)\s*width\s*:\s*(\d+)px/.exec(style)
  const sh = /(?:^|;)\s*height\s*:\s*(\d+)px/.exec(style)
  const w = node.attrs.has('width') ? px(node.attrs.get('width')) : sw ? Number(sw[1]) : NaN
  const h = node.attrs.has('height') ? px(node.attrs.get('height')) : sh ? Number(sh[1]) : NaN
  return (Number.isFinite(w) && w <= 3) || (Number.isFinite(h) && h <= 3)
}

/** The width and height an <img> declares (attribute first, then its style), NaN when not given. */
function dims(node) {
  const style = decode(node.attrs.get('style') || '').toLowerCase()
  const sw = /(?:^|;)\s*width\s*:\s*(\d+)px/.exec(style)
  const sh = /(?:^|;)\s*height\s*:\s*(\d+)px/.exec(style)
  const w = node.attrs.has('width') ? px(node.attrs.get('width')) : sw ? Number(sw[1]) : NaN
  const h = node.attrs.has('height') ? px(node.attrs.get('height')) : sh ? Number(sh[1]) : NaN
  return { w, h }
}

// A picture that is chrome, not content: the sender's logo, a person's avatar, a social or
// app-store badge, a spacer or an icon. Read from its alt, title and file name.
const MINOR_NAME = /(?:^|[^a-z])(?:logo|logos|avatar|icon|icons|badge|spacer|divider|signature|facebook|twitter|linkedin|instagram|youtube|tiktok|app ?store|google ?play|get it on|download on)(?:[^a-z]|$)/i

/**
 * Whether a remote picture is minor (hidden in the mail layout until the pictures are loaded, and
 * left out of a label): tiny by its declared size (both sides at most 48 px, or one at most 24) or
 * named like a logo, an avatar or a badge.
 */
function isMinor(node, src, alt) {
  const { w, h } = dims(node)
  if (Number.isFinite(w) && Number.isFinite(h) && w <= 48 && h <= 48) return true
  if ((Number.isFinite(w) && w <= 24) || (Number.isFinite(h) && h <= 24)) return true
  let file = ''
  try {
    file = decodeURIComponent(new URL(src).pathname.split('/').pop() || '')
  } catch {
    // Not a URL we can read a name from: the alt alone decides.
  }
  return MINOR_NAME.test(alt) || MINOR_NAME.test(String(node.attrs.get('title') || '')) || MINOR_NAME.test(file.replace(/[_-]/g, ' '))
}

/** An alt that is a symbol standing for a word (Jira's status arrow "→"): at most 3 characters, no letter or digit. */
const isSymbolAlt = (alt) => alt.length > 0 && alt.length <= 3 && !/[\p{L}\p{N}]/u.test(alt)

/**
 * An attribute value as text: entities decoded, and decoded once more when the result still holds a
 * character reference. HTML decodes an attribute once; some senders escape twice (Jira writes
 * `alt="&amp;#x2192;"` for an arrow), and a person never means `&#x2192;` as the text of an alt.
 */
function attrText(v) {
  const once = decode(v)
  return /&(?:#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{1,31});/.test(once) ? decode(once) : once
}

/** Whether a table is for layout (unwrapped) rather than data (kept as a table). */
function isLayoutTable(table) {
  // Decided once, before foldFooter moves rows out of a table (fewer rows could change the answer).
  if (table.layout !== undefined) return table.layout
  const role = String(table.attrs.get('role') || '').toLowerCase()
  if (role === 'presentation' || role === 'none') return true
  let maxCells = 0
  let nested = false
  const walk = (n, depth) => {
    if (depth > MAX_DEPTH || nested) return
    for (const c of n.children || []) {
      if (c.name === 'table') {
        nested = true
        return
      }
      if (c.name === 'tr') {
        const cells = c.children.filter((x) => x.name === 'td' || x.name === 'th').length
        if (cells > maxCells) maxCells = cells
      }
      if (c.children) walk(c, depth + 1)
    }
  }
  walk(table, 0)
  table.layout = nested || maxCells < 2
  return table.layout
}

const HEADING = /^h[1-6]$/

/**
 * Sanitized HTML of a mail body.
 *
 * @param {string} html the text/html part, decoded to a string
 * @param {object} [o]
 * @param {(cid: string) => string | null} [o.cid] the asset id of an inline image (`cid:` part) the
 *   caller has, else null (then the image is its alt text)
 * @param {number} [o.headingShift] added to heading levels (default 2: a message card sits under the
 *   thread's h1 and the message's h2)
 * @param {{ mode?: 'placeholder' | 'label', loaded?: (id: string) => boolean }} [o.remote] how a
 *   remote picture is written: 'placeholder' (the reviewer's mail layout: an asset image that shows as
 *   a chip until loaded) or 'label' (the default: its alt as text, unless `loaded(id)` says the host
 *   has it, then the picture)
 * @param {boolean} [o.mail] mark call-to-action links `mail-cta` (the mail layout's button)
 * @param {boolean} [o.foldFooter] fold the sender's footer (default true)
 * @returns {{ html: string, usedCids: Set<string>, remoteImages: number, remote: { id: string, url: string, alt: string, minor: boolean }[], footer: boolean, truncated: boolean }}
 *   `remoteImages`: the remote pictures not shown (not loaded); `remote`: each remote picture once
 */
function sanitizeHtml(html, o = {}) {
  const { root, truncated } = parse(html)
  const r = o.remote || {}
  const c = {
    cid: typeof o.cid === 'function' ? o.cid : () => null,
    shift: Number.isInteger(o.headingShift) ? o.headingShift : 2,
    usedCids: new Set(),
    remoteImages: 0,
    remote: new Map(),
    placeholder: r.mode === 'placeholder',
    loaded: typeof r.loaded === 'function' ? r.loaded : () => false,
    mail: Boolean(o.mail),
  }
  const footer = o.foldFooter === false ? false : foldFooter(root)
  let out = children(root, { folded: false, inLink: false, table: null, pre: false }, c, 0)
  if (truncated) out += '<p><em>(This mail is too long to show in full here; Gmail has the rest.)</em></p>'
  return { html: out, usedCids: c.usedCids, remoteImages: c.remoteImages, remote: [...c.remote.values()], footer, truncated }
}

// ---- the sender's footer ----

// What a sender's boilerplate says: unsubscribe, a privacy policy, "this email was sent by", the
// app-store badges, managing preferences. Read in a block's text and its pictures' alt texts.
const FOOTER_SIGNAL = new RegExp(
  [
    '\\bunsubscrib',
    '\\bprivacy (?:policy|notice|statement)\\b',
    '\\bthis (?:e-?mail|message|notification) (?:was|is|has been) sent (?:to|by|from)\\b',
    '\\bmanage (?:your )?(?:e-?mail |notification |subscription |communication )?(?:preferences|settings|subscriptions)\\b',
    '\\b(?:update|change) your (?:e-?mail |notification )?preferences\\b',
    '\\b(?:e-?mail|notification) preferences\\b',
    '\\bapp store\\b',
    '\\bgoogle play\\b',
    "\\byou(?:'re| are)? receiv(?:ed|ing) this (?:e-?mail|message|notification)\\b",
    '\\bopt[ -]out\\b',
  ].join('|'),
  'i',
)
const FOOTER_SHORT = 200 // a block after the footer starts may be boilerplate this long without a signal of its own
const FOOTER_SIGNAL_MAX = 600 // a block with a signal but longer than this mixes content in: not a footer start
const FOOTER_CONTENT_MIN = 40 // the mail must have this much text before its footer
// Blocks for the footer's walk: an element whose own text is one unit (a table cell counts: layout
// tables put each line of a footer in a cell).
const TEXT_BLOCK = new Set(['p', 'div', 'td', 'th', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'dd', 'dt', 'center', 'section', 'article', 'header', 'footer', 'main', 'address', 'figure', 'figcaption', 'table', 'tr', 'ul', 'ol', 'dl', 'aside', 'nav'])
// The fold never cuts through one of these: it would split a link, a list, preformatted text or a
// data table, which the reader then sees broken.
const NO_CUT = new Set(['a', 'pre', 'ul', 'ol', 'dl', 'li', 'dt', 'dd', 'blockquote', 'details', 'summary', 'figure', 'figcaption'])

/**
 * Folds the sender's footer into a `#footer` node at the end of `root` (written as `<details
 * class="mail-footer"><summary>Sender's footer</summary>…</details>`); true when it did.
 *
 * The walk lists the text blocks in document order (innermost block owns its text; a picture adds
 * its alt). The footer starts at the first block that has a signal (FOOTER_SIGNAL) and is at most
 * FOOTER_SIGNAL_MAX characters, such that every later block has a signal or is short boilerplate
 * (FOOTER_SHORT). Conservative: nothing is folded when the region has no link (a personal mail's
 * last line that says "unsubscribe" stays), when less than FOOTER_CONTENT_MIN characters of text
 * come before it, when quoted history comes after it (the walk stops at a quote: a reply's footer
 * belongs to the quote, which is folded anyway), or when the cut would pass through a link, a list,
 * preformatted text or a data table.
 *
 * The cut is lifted to the outermost element that starts with the footer's first block, then that
 * element, its later siblings and the later siblings of each ancestor move, in order, into the fold.
 */
function foldFooter(root) {
  const blocks = [] // { node, text, links }
  const byNode = new Map()
  let barrier = false
  const add = (owner, text, links = 0) => {
    let b = byNode.get(owner)
    if (!b) {
      b = { node: owner, text: '', links: 0 }
      byNode.set(owner, b)
      blocks.push(b)
    }
    b.text += text
    b.links += links
  }
  const walk = (n, owner, depth) => {
    if (barrier || depth > MAX_DEPTH) return
    for (const k of n.children || []) {
      if (barrier) return
      if (k.text !== undefined) {
        if (k.text.trim()) add(owner, k.text)
        continue
      }
      if (isHidden(k)) continue
      if (isQuote(k) || isOutlookQuoteStart(k)) {
        barrier = true
        return
      }
      if (k.name === 'img') {
        const alt = attrText(k.attrs.get('alt') || k.attrs.get('title') || '').trim()
        if (alt) add(owner, ` ${alt} `)
        continue
      }
      if (k.name === 'a' && safeHref(decode(k.attrs.get('href') || ''))) add(owner, '', 1)
      walk(k, TEXT_BLOCK.has(RENAME[k.name] || k.name) ? k : owner, depth + 1)
    }
  }
  walk(root, root, 0)
  const len = (b) => b.text.replace(/\s+/g, ' ').trim().length
  let start = -1
  let before = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const t = b.text.replace(/\s+/g, ' ')
    if (FOOTER_SIGNAL.test(t) && len(b) <= FOOTER_SIGNAL_MAX && before >= FOOTER_CONTENT_MIN && b.node !== root) {
      const rest = blocks.slice(i + 1)
      if (!barrier && rest.every((x) => FOOTER_SIGNAL.test(x.text.replace(/\s+/g, ' ')) || len(x) <= FOOTER_SHORT) && [b, ...rest].some((x) => x.links > 0)) {
        start = i
        break
      }
    }
    before += len(b)
  }
  if (start < 0) return false
  // A block that also holds earlier content (its text runs on around a nested block that came first)
  // is no footer start: its node would carry that content into the fold.
  let cut = blocks[start].node
  if (blocks.slice(0, start).some((b) => contains(cut, b.node))) return false
  // Lift: while the cut is the first child with anything in it of its parent, the parent starts with
  // the footer too.
  while (cut.parent && cut.parent !== root && firstMeaningful(cut.parent) === cut && !NO_CUT.has(cut.parent.name) && !isDataTablePart(cut.parent)) cut = cut.parent
  for (let a = cut.parent; a && a !== root; a = a.parent) {
    if (NO_CUT.has(RENAME[a.name] || a.name) || isDataTablePart(a)) return false
  }
  if (NO_CUT.has(cut.name) && cut.name !== 'blockquote') return false
  // Tables on the way decide their layout now, while they still have all their rows.
  for (let a = cut; a && a !== root; a = a.parent) if (a.name === 'table') isLayoutTable(a)
  const moved = []
  let node = cut
  let first = true
  while (node && node !== root) {
    const parent = node.parent
    const at = parent.children.indexOf(node)
    moved.push(...parent.children.splice(first ? at : at + 1))
    first = false
    node = parent
  }
  const fold = { name: '#footer', attrs: new Map(), children: moved, parent: root }
  for (const m of moved) if (m.name !== undefined) m.parent = fold
  root.children.push(fold)
  return true
}

/** Whether `node` is `inner` or one of its ancestors. */
function contains(node, inner) {
  for (let n = inner; n; n = n.parent) if (n === node) return true
  return false
}

/** The first child that has text or an element in it (whitespace text skipped). */
function firstMeaningful(node) {
  return (node.children || []).find((k) => (k.text !== undefined ? k.text.trim() !== '' : true)) || null
}

/** A data table or a part of one (its rows and cells): never cut through. */
function isDataTablePart(node) {
  for (let n = node; n && n.name !== '#root'; n = n.parent) {
    if (n.name === 'table') return !isLayoutTable(n)
    if (!['tr', 'td', 'th', 'tbody', 'thead', 'tfoot'].includes(n.name)) return false
  }
  return false
}

// ---- call-to-action links ----

const CTA = /^(?:view|open)\b/i
const INLINE_WRAP = new Set(['span', 'strong', 'b', 'em', 'i', 'font', 'u'])

/** The text of a tree node (hidden parts left out), bounded by depth. */
function textOf(n, depth = 0) {
  if (n.text !== undefined) return n.text
  if (depth > MAX_DEPTH || isHidden(n)) return ''
  let t = ''
  for (const k of n.children || []) t += textOf(k, depth + 1)
  return t
}

/**
 * A lone "View …" / "Open …" link: its text starts so and is short (a call to action, not a
 * sentence), and it is all its block holds (wrappers like <strong> or <font> around it count as the
 * link), as notification mails put their main button.
 */
function isCta(a) {
  const text = textOf(a).replace(/\s+/g, ' ').trim()
  if (!CTA.test(text) || text.length > 40) return false
  let block = a.parent
  while (block && INLINE_WRAP.has(block.name)) block = block.parent
  if (!block || block.name === '#root') return false
  return textOf(block).replace(/\s+/g, ' ').trim() === text
}

function children(node, x, c, depth) {
  const kids = node.children || []
  // Outlook: fold from the reply header to the end of its parent.
  if (!x.folded) {
    let k = kids.findIndex((n) => n.name !== undefined && isOutlookQuoteStart(n))
    if (k >= 0) {
      // The <hr> Outlook puts right before the header goes into the fold too.
      let h = k - 1
      while (h >= 0 && kids[h].text !== undefined && !kids[h].text.trim()) h--
      if (h >= 0 && kids[h].name === 'hr') k = h
      const before = kids.slice(0, k).map((n) => one(n, x, c, depth)).join('')
      const inner = kids.slice(k).map((n) => one(n, { ...x, folded: true }, c, depth)).join('')
      return before + (inner.trim() ? fold(inner) : '')
    }
  }
  let s = ''
  for (const n of kids) s += one(n, x, c, depth)
  return s
}

function fold(inner) {
  return `<details><summary>Quoted text</summary>${inner}</details>`
}

function footerFold(inner) {
  return `<details class="mail-footer"><summary>Sender's footer</summary>${inner}</details>`
}

function one(n, x, c, depth) {
  if (n.text !== undefined) return esc(n.text)
  if (depth > MAX_DEPTH) return ''
  if (isHidden(n)) return ''
  if (n.name === '#footer') {
    const inner = children(n, x, c, depth + 1)
    return inner.trim() ? footerFold(inner) : ''
  }
  const name = RENAME[n.name] || n.name
  if (!x.folded && isQuote(n)) {
    const inner = children(n, { ...x, folded: true }, c, depth + 1)
    if (!inner.trim()) return ''
    return fold(n.name === 'blockquote' ? `<blockquote>${inner}</blockquote>` : inner)
  }
  if (name === 'img') return image(n, x, c)
  if (name === 'br') return '<br>'
  if (name === 'hr') return '<hr>'
  if (name === 'wbr') return ''
  if (name === 'table') {
    const layout = isLayoutTable(n)
    const inner = children(n, { ...x, table: layout ? 'layout' : 'data' }, c, depth + 1)
    if (layout) return inner
    return inner.trim() ? `<table>${inner}</table>` : ''
  }
  if (name === 'thead' || name === 'tbody' || name === 'tr' || name === 'td' || name === 'th') {
    const inner = children(n, x, c, depth + 1)
    if (x.table !== 'data') {
      // A layout table's cell is a block; its rows and sections are nothing of their own.
      if (name === 'td' || name === 'th') return inner.trim() ? `<div>${inner}</div>` : ''
      return inner
    }
    if (name === 'td' || name === 'th') return `<${name}${span(n)}>${inner}</${name}>`
    return `<${name}>${inner}</${name}>`
  }
  if (name === 'a') {
    const href = x.inLink ? null : safeHref(decode(n.attrs.get('href') || ''))
    const inner = children(n, { ...x, inLink: x.inLink || Boolean(href) }, c, depth + 1)
    if (!href) return inner
    if (!inner.trim()) return ''
    return `<a href="${esc(href)}"${title(n)}${c.mail && isCta(n) ? ' class="mail-cta"' : ''}>${inner}</a>`
  }
  if (HEADING.test(name)) {
    const level = Math.min(6, Number(name[1]) + c.shift)
    const inner = children(n, x, c, depth + 1)
    return inner.trim() ? `<h${level}>${inner}</h${level}>` : ''
  }
  if (name === 'pre') {
    const inner = children(n, { ...x, pre: true }, c, depth + 1)
    return inner ? `<pre>${inner}</pre>` : ''
  }
  const inner = children(n, x, c, depth + 1)
  if (!ALLOWED.has(name)) return inner // unwrapped: html, body, font, form, o:p, an unknown tag
  // An element with nothing in it is a spacer (newsletters are full of them): left out.
  if (!inner.trim() && name !== 'td' && name !== 'th') return ''
  if (name === 'div' || name === 'span' || name === 'p') return `<${name}${title(n)}>${inner}</${name}>`
  return `<${name}>${inner}</${name}>`
}

function title(n) {
  const t = n.attrs.get('title')
  if (!t) return ''
  const v = attrText(t).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
  return v ? ` title="${esc(v)}"` : ''
}

function span(n) {
  let s = ''
  for (const k of ['colspan', 'rowspan']) {
    const v = px(n.attrs.get(k))
    if (Number.isInteger(v) && v > 1 && v <= 1000) s += ` ${k}="${v}"`
  }
  return s
}

/** An <img>: an inline part as an asset, a remote picture as a placeholder or its label, anything else as its alt. */
function image(n, x, c) {
  const src = decode(n.attrs.get('src') || '').trim()
  const alt = attrText(n.attrs.get('alt') || n.attrs.get('title') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
  const label = alt ? `[image: ${alt}]` : '[image]'
  if (/^cid:/i.test(src)) {
    const key = cidKey(src.slice(4))
    const asset = key ? c.cid(key) : null
    if (asset && /^[A-Za-z0-9._-]{1,100}$/.test(asset)) {
      c.usedCids.add(key)
      const a = esc(alt || 'image')
      return `<img data-asset="${esc(asset)}" alt="${a}" title="${a}">`
    }
    return esc(label)
  }
  const href = safeHref(src)
  if (href && !href.startsWith('mailto:')) {
    if (isPixel(n)) return ''
    const minor = isMinor(n, href, alt)
    // A tiny picture standing for a symbol (an arrow between two statuses) reads as that symbol.
    // Spaces around it (HTML collapses doubles): "Backlog → Ready", not "Backlog→Ready".
    if (minor && isSymbolAlt(alt)) return ` ${esc(alt)} `
    const id = remoteAssetId(href)
    if (!c.remote.has(id) && c.remote.size < MAX_REMOTE) c.remote.set(id, { id, url: href, alt, minor })
    const loaded = c.remote.has(id) && c.loaded(id)
    if (!loaded) c.remoteImages++
    if (c.placeholder) {
      // The reviewer draws an image whose asset it has not got as a chip with its alt text, and fills
      // it in place when update() brings the asset (no link: the picture is not the sender's page).
      const a = esc(alt || 'image')
      return `<img data-asset="${esc(id)}" alt="${a}" title="${a}" class="mail-remote${minor ? ' mail-minor' : ''}">`
    }
    if (loaded) {
      const a = esc(alt || 'image')
      return `<img data-asset="${esc(id)}" alt="${a}" title="${a}">`
    }
    if (minor) return ''
    // Inside a link the label is that link's text; elsewhere a muted text, never a link of its own.
    return x.inLink ? esc(label) : `<span class="muted">${esc(label)}</span>`
  }
  return alt ? esc(label) : ''
}

/** A Content-ID as the lookup key: without its angle brackets, URL-decoded, lower case. */
function cidKey(raw) {
  let s = String(raw || '').trim()
  try {
    s = decodeURIComponent(s)
  } catch {
    // A stray % stays as written.
  }
  s = s.replace(/^<|>$/g, '').trim().toLowerCase()
  return s && s.length <= 500 ? s : null
}

// ---- plain text ----

const BLOCK = new Set(['p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'hr', 'pre', 'ul', 'ol', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'center', 'address', 'figure', 'figcaption', 'details', 'summary'])

/**
 * A mail's HTML as plain text (the reviewer's text mode, `ccc gmail show`, Discuss): blocks on their
 * own lines, list items with "- ", a link as `text <url>` when the text is not the address, hidden
 * parts and images left out (with `o.alts`, an image is its alt text), quoted history kept but marked.
 */
function htmlToText(html, o = {}) {
  const { root } = parse(html)
  const parts = []
  const walk = (n, depth, inLink) => {
    if (n.text !== undefined) {
      parts.push(n.text)
      return
    }
    if (depth > MAX_DEPTH || isHidden(n)) return
    const name = n.name
    if (name === 'br') return void parts.push('\n')
    if (name === 'img') {
      // `o.alts`: a picture's alt as text (the Jira card reads "Backlog → Ready" where the arrow is a picture).
      if (o.alts) {
        const alt = attrText(n.attrs.get('alt') || '').replace(/\s+/g, ' ').trim()
        if (alt) parts.push(` ${alt} `)
      }
      return
    }
    if (name === 'li') parts.push('\n- ')
    else if (BLOCK.has(name)) parts.push('\n')
    if (name === 'td' || name === 'th') parts.push(' ')
    const quote = isQuote(n) || isOutlookQuoteStart(n)
    if (quote) parts.push('\n[quoted]\n')
    const start = parts.length
    for (const k of n.children || []) walk(k, depth + 1, inLink || name === 'a')
    if (name === 'a' && !inLink) {
      const href = safeHref(decode(n.attrs.get('href') || ''))
      const shown = parts.slice(start).join('').trim()
      if (href && !href.startsWith('mailto:') && shown && shown !== href && shown.replace(/^https?:\/\//, '') !== href.replace(/^https?:\/\//, '').replace(/\/$/, '')) parts.push(` <${href}>`)
    }
    if (BLOCK.has(name) && name !== 'li') parts.push('\n')
  }
  walk(root, 0, false)
  return parts
    .join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const LINK = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g

/** Plain text as HTML: escaped, its http(s) links made links (each checked like any href). */
function linkify(text) {
  let out = ''
  let at = 0
  for (const m of String(text).matchAll(LINK)) {
    const href = safeHref(m[0])
    out += esc(text.slice(at, m.index))
    out += href ? `<a href="${esc(href)}">${esc(m[0])}</a>` : esc(m[0])
    at = m.index + m[0].length
  }
  return out + esc(text.slice(at))
}

function paragraphs(text) {
  const t = String(text).trim()
  if (!t) return ''
  return t
    .split(/\n[ \t]*\n+/)
    .map((p) => `<p>${linkify(p.replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/**
 * A text/plain body as HTML paragraphs, with its trailing quoted history (`>` lines, an
 * "On ... wrote:" line before them, or Outlook's "-----Original Message-----") folded.
 */
function textToHtml(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  if (!t.trim()) return ''
  const lines = t.split('\n')
  let q = -1
  const orig = lines.findIndex((l) => /^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(l))
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k]
    if (/^\s*>/.test(l)) q = k
    else if (l.trim()) break
  }
  if (q > 0) {
    // The attribution line(s) right before the quote: "On Mon, Ann <a@x> wrote:" (wrapped onto two lines at most).
    let k = q - 1
    while (k >= 0 && !lines[k].trim()) k--
    if (k >= 0 && /wrote:\s*$|schrieb:\s*$|a écrit\s*:\s*$|escribió:\s*$/i.test(lines[k])) q = k > 0 && /^on\s/i.test(lines[k - 1]) && !/^on\s/i.test(lines[k]) ? k - 1 : k
  }
  if (orig >= 0 && (q < 0 || orig < q)) q = orig
  if (q <= 0) return paragraphs(t)
  const body = lines.slice(0, q).join('\n')
  const rest = lines.slice(q)
  // The attribution ("On ... wrote:", the Original Message line) stays a line of its own above the quote.
  let a = rest.findIndex((l) => /^\s*>/.test(l))
  if (a < 0) a = Math.min(1, rest.length)
  const attribution = rest.slice(0, a).join('\n')
  const quoted = rest
    .slice(a)
    .map((l) => l.replace(/^\s*> ?/, ''))
    .join('\n')
  const inner = paragraphs(attribution) + (quoted.trim() ? `<blockquote>${paragraphs(quoted)}</blockquote>` : '')
  return paragraphs(body) + (inner ? `\n${fold(inner)}` : '')
}

module.exports = { tokenize, parse, sanitizeHtml, htmlToText, textToHtml, linkify, safeHref, cidKey, isLayoutTable, remoteAssetId, attrText, isMinor, ALLOWED, RENAME, DROP, MAX_INPUT, MAX_DEPTH, FOOTER_SIGNAL }
