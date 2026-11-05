'use strict'
// The reader page. The host posts `{ type: 'doc', title, parts, assets }`, then the html in `parts`
// messages `{ type: 'html', i, part }` (a page message has a size limit), then one
// `{ type: 'asset', id, dataUrl }` per picture. A button answers `{ result: { action } }`, which
// closes the overlay and lets the host act; Esc closes it with no action. A link click is posted as
// `{ open: href }` (the host opens http(s) in the system browser with ctx.openExternal).
//
// The html is the host's own, rebuilt from the mail by dist/lib/sanitize.js (allow-listed tags,
// every text escaped); the page still keeps only the tags and attributes that builder writes (a
// second line of defence; the page CSP runs no inline script either), and an image only ever gets a
// data: URL of a picture. (From bronos.jira's issue.js.)

const TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BR', 'HR', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'IMG', 'STRONG', 'EM', 'S', 'U', 'SUB', 'SUP', 'SPAN', 'DIV', 'DETAILS', 'SUMMARY', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD'])
const ATTRS = new Set(['class', 'colspan', 'rowspan', 'alt', 'title', 'data-asset', 'href'])
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/

let doc = null
let parts = []
const assets = new Map()

function clean(root) {
  for (const n of [...root.querySelectorAll('*')]) {
    if (!TAGS.has(n.tagName)) {
      n.replaceWith(document.createTextNode(n.textContent || ''))
      continue
    }
    for (const a of [...n.attributes]) {
      if (!ATTRS.has(a.name) || (a.name === 'href' && n.tagName !== 'A')) n.removeAttribute(a.name)
    }
    if (n.tagName === 'A' && !/^(https?:|mailto:)/i.test(n.getAttribute('href') || '')) n.removeAttribute('href')
  }
}

function showAsset(id) {
  const url = assets.get(id)
  if (!url) return
  for (const img of document.querySelectorAll('img[data-asset]')) if (img.dataset.asset === id) img.src = url
}

// ready: 'manual' on the overlay: the app's loader stays until the page says it has drawn, so it
// is told once, after the first render put the mail in the DOM (not at load: the loader would go
// before the doc and html messages, leaving an empty page meanwhile).
let drawn = false

function render() {
  const t = document.createElement('template')
  t.innerHTML = parts.join('')
  clean(t.content)
  document.getElementById('doc').replaceChildren(t.content)
  for (const id of assets.keys()) showAsset(id)
  if (!drawn) {
    drawn = true
    ccPanel.ready()
  }
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'doc') {
    doc = m
    // Filled, not sparse: every() skips holes, so a sparse array drew (and said ready) after part 0.
    parts = new Array(Math.max(0, Number(m.parts) || 0)).fill(null)
    document.title = String(m.title || 'Mail')
    if (!parts.length) render()
  } else if (m.type === 'html' && doc && Number.isInteger(m.i) && m.i >= 0 && m.i < parts.length && typeof m.part === 'string') {
    parts[m.i] = m.part
    if (parts.every((p) => typeof p === 'string')) render()
  } else if (m.type === 'asset' && typeof m.id === 'string' && typeof m.dataUrl === 'string' && IMAGE_URL.test(m.dataUrl)) {
    assets.set(m.id, m.dataUrl)
    showAsset(m.id)
  }
})

document.getElementById('doc').addEventListener('click', (ev) => {
  const a = ev.target.closest && ev.target.closest('a[href]')
  if (!a) return
  ev.preventDefault()
  ccPanel.post({ open: a.href })
})

for (const [id, action] of [['discuss', 'discuss'], ['new', 'newSession'], ['browser', 'browser']]) {
  document.getElementById(id).addEventListener('click', () => ccPanel.post({ result: { action } }))
}
