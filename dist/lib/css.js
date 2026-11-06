'use strict'
// A mail's own CSS made safe for the reviewer's Original view (0.6.0, sanitize.js `sanitizeOriginal`):
// the `<style>` blocks and `style` attributes of a designed mail (a Jira notification's card, its old
// value struck through in red, the new one on green), kept for what they draw and stripped of
// everything that could load, run or escape:
//
// - `url(...)` of anything but a data: image (png, jpeg, gif, webp), and the other functions that
//   take a URL or a string as one (`image-set()`, `image()`, `src()`, `element()`, `cross-fade()`,
//   `paint()`): the declaration goes. A remote background picture would tell the sender the mail was
//   opened, like a remote <img>, and is not worth a loader of its own.
// - `@import`, `@font-face` (fonts load from URLs), `@charset`, `@namespace` and every other at-rule
//   but `@media` and `@supports` (whose rules are cleaned the same way).
// - `expression()`, `behavior`, `-moz-binding`, `javascript:`: old script hooks of IE and Firefox.
// - `position: fixed` and `sticky`: a mail drawing over the page (or pinning itself) is not reading.
// - A backslash anywhere (CSS escapes, `\75 rl(` is `url(`) and a `<` anywhere (it could end the
//   <style> element early): the declaration or the rule goes, rather than decoding escapes right.
//
// The checks run on what is written out, not on what was read: a declaration is kept only as the
// text that passed them, and the whole output is checked once more (no backslash, no `<`, no url()
// but data: images), so a parse of ours that differs from the browser's cannot let one through.
// This is the second wall: the reviewer's frame (no script, its own CSP with `img-src data:` and no
// network) is the first, and holds without this.

const MAX_CSS = 200000 // characters of <style> text in one message; past it the Original view is not offered
const MAX_STYLE_ATTR = 8000 // one style attribute; a longer one is dropped
const MAX_DEPTH = 8 // @media inside @supports inside ...: deeper blocks are dropped

const DATA_IMAGE_URL = /url\(\s*(["']?)data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}\1\s*\)/gi
const URL_TAKERS = /(?:^|[^a-z0-9_-])(?:url|image-set|-webkit-image-set|image|src|element|-moz-element|cross-fade|-webkit-cross-fade|paint|expression)\s*\(/i
const BANNED = /javascript:|vbscript:|-moz-binding|@import|\\|</i
// `behavior` as a property (IE's script hook), not `scroll-behavior`.
const BEHAVIOR = /(?:^|[;{\s])-?(?:ms-)?behavior\s*:/i
const PROPERTY = /^(?:-?[a-z][a-z0-9-]*|--[a-z0-9_-]+)$/i
const DROP_PROPERTY = new Set(['behavior', '-ms-behavior', '-moz-binding'])
const KEEP_AT = new Set(['media', 'supports'])

/** Text without comments (a comment inside a string is the string's text and stays). */
function stripComments(s) {
  let out = ''
  let q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      out += ch
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") {
      q = ch
      out += ch
      continue
    }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/**
 * The index of the first of `stops` at or after `i` outside strings, parentheses and (unless `{` is a
 * stop) braces; s.length when none. A block's `{...}` is skipped whole, so a `;` inside it is not a stop.
 */
function scan(s, i, stops) {
  let paren = 0
  let brace = 0
  let q = null
  for (; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") q = ch
    else if (ch === '(') paren++
    else if (ch === ')') paren = Math.max(0, paren - 1)
    else if (paren === 0 && brace === 0 && stops.includes(ch)) return i
    else if (ch === '{') brace++
    else if (ch === '}') {
      if (brace === 0) {
        if (stops.includes('}')) return i
      } else brace--
    }
  }
  return s.length
}

/** One declaration (`prop: value`), as written out, or null when it goes. */
function declaration(raw) {
  const colon = raw.indexOf(':')
  if (colon < 0) return null
  const prop = raw.slice(0, colon).trim()
  let value = raw.slice(colon + 1).trim().replace(/\s+/g, ' ')
  if (!PROPERTY.test(prop) || !value) return null
  const lower = prop.toLowerCase()
  if (DROP_PROPERTY.has(lower)) return null
  if (/[{}]/.test(value) || BANNED.test(value)) return null
  // url() of a data: image is the one URL kept; any other function that takes a URL is not.
  if (URL_TAKERS.test(value.replace(DATA_IMAGE_URL, ''))) return null
  if (lower === 'position' && /fixed|sticky/i.test(value)) return null
  return `${prop}:${value}`
}

/** A declaration list (a style attribute, or a rule's block), cleaned; '' when nothing is left. */
function declarations(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    const end = scan(s, i, [';'])
    const d = declaration(s.slice(i, end))
    if (d) out.push(d)
    i = end + 1
  }
  return out.join(';')
}

/** The rules of a stylesheet (or of an @media block) from `s`, cleaned. */
function rules(s, depth) {
  let out = ''
  let i = 0
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++
    if (i >= s.length) break
    const open = scan(s, i, ['{', ';'])
    const prelude = s.slice(i, open).trim()
    if (open >= s.length) break // a rule with no block at the end: nothing to keep
    if (s[open] === ';') {
      i = open + 1 // an at-statement (@import, @charset, @namespace) or junk: dropped
      continue
    }
    const close = scan(s, open + 1, ['}'])
    const block = s.slice(open + 1, close)
    i = close + 1
    if (!prelude || /[\\<]/.test(prelude) || /url\s*\(|javascript:/i.test(prelude)) continue
    if (prelude[0] === '@') {
      const name = (/^@([a-z-]+)/i.exec(prelude) || [])[1]
      if (!name || !KEEP_AT.has(name.toLowerCase()) || depth >= MAX_DEPTH) continue
      const inner = rules(block, depth + 1)
      if (inner) out += `${prelude.replace(/\s+/g, ' ')}{${inner}}`
      continue
    }
    if (/[{}@;]/.test(prelude)) continue
    const decls = declarations(block)
    if (decls) out += `${prelude.replace(/\s+/g, ' ')}{${decls}}`
  }
  return out
}

/** The last check, on the text written out: nothing that can load or end the element. */
function safeOutput(css) {
  if (/[\\<]/.test(css) || BANNED.test(css) || BEHAVIOR.test(css)) return false
  return !URL_TAKERS.test(css.replace(DATA_IMAGE_URL, ''))
}

/** A stylesheet (a <style> element's text), cleaned; '' when nothing safe is left. */
function sanitizeStylesheet(text) {
  const css = rules(stripComments(String(text || '').replace(/\0/g, '')), 0)
  return safeOutput(css) ? css : ''
}

/** A style attribute's value (entities already decoded), cleaned; '' when nothing safe is left or it is too long. */
function sanitizeStyle(text) {
  const s = String(text || '')
  if (s.length > MAX_STYLE_ATTR) return ''
  const css = declarations(stripComments(s.replace(/\0/g, '')))
  return safeOutput(css) ? css : ''
}

module.exports = { sanitizeStylesheet, sanitizeStyle, stripComments, MAX_CSS, MAX_STYLE_ATTR }
