'use strict'
// HTML character references, decoded to text: the mail sanitizer decodes every text and attribute
// value and escapes it again on output (so `&lt;script&gt;` stays text and nothing is escaped
// twice), and Gmail's snippets come with references in them (`it&#39;s`).
//
// Numeric references follow the HTML rules that matter for safety: 0, surrogates and anything past
// U+10FFFF become U+FFFD, and the C1 range (0x80-0x9F) maps to windows-1252 as browsers do. Named
// references: the ones mail actually uses (the full HTML table has 2,231 and would be a dependency
// in all but name). An unknown name stays as written, which is what a browser shows for it too.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Text or an attribute value, escaped for HTML (quotes too, so it is safe inside "..."). */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c])
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', shy: '­',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  bull: '•', middot: '·', prime: '′', Prime: '″', dagger: '†', Dagger: '‡', permil: '‰',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', dollar: '$',
  times: '×', divide: '÷', plusmn: '±', deg: '°', micro: 'µ', para: '¶', sect: '§', ordf: 'ª', ordm: 'º',
  sup1: '¹', sup2: '²', sup3: '³', frac14: '¼', frac12: '½', frac34: '¾', not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨',
  iexcl: '¡', iquest: '¿', brvbar: '¦',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', check: '✓', hearts: '♥', star: '☆', starf: '★',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Omega: 'Ω', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', mu: 'μ', sigma: 'σ', omega: 'ω',
}

// windows-1252 for the C1 range of numeric references (`&#150;` is an en dash in every browser).
const C1 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 }

function codePoint(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�'
  if (n >= 0x80 && n <= 0x9f) return String.fromCodePoint(C1[n] || n)
  return String.fromCodePoint(n)
}

/** `s` with its character references decoded. */
function decode(s) {
  const t = String(s == null ? '' : s)
  if (!t.includes('&')) return t
  return t.replace(/&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,10});?|([A-Za-z][A-Za-z0-9]{1,31});)/g, (m, hex, dec, name) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16))
    if (dec !== undefined) return codePoint(parseInt(dec, 10))
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m
  })
}

module.exports = { esc, decode, NAMED }
