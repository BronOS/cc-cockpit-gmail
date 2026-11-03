'use strict'
// The opened thread as one HTML document (the reviewer's HTML mode, and the plugin's own reader
// page; design "The thread view"): the subject, then each message oldest first as a card (sender,
// address, date, To and Cc, then the body as sanitize.js makes it, then its attachments), and the
// details column (`aside`): from, to, cc, date, labels, the message count, the Gmail link. Unread
// messages get `.new`. This file writes only fixed markup around the sanitized bodies, with the
// classes the reviewer's allow-list keeps (card, card-header, meta, new, lozenge, lozenge-<tone>,
// facts, person, attachment-list, muted), and escapes every value it puts in.
//
// Size: the reviewer takes at most 2 MiB of html and 100,000 characters of aside. A message body
// over 1 MB of markup becomes its plain text (cut); when the cards do not fit, the oldest messages
// give way first, with a line that says how many are left out (the newest are what matters).

const { esc } = require('./entities')
const { sanitizeHtml, textToHtml, htmlToText } = require('./sanitize')
const { walkMessage } = require('./mime')
const { compactMessage, parseAddressList, displayName } = require('./model')
const { partKey } = require('./images')
const { stamp, cut } = require('./util')

const HTML_MAX_BYTES = 2000000 // below the reviewer's 2 MiB (2,097,152), counted in UTF-8 bytes
const BODY_MAX_BYTES = 1000000
const ASIDE_MAX = 90000 // below the reviewer's 100,000 characters

const SYSTEM_LABELS = {
  INBOX: 'Inbox', UNREAD: 'Unread', STARRED: 'Starred', IMPORTANT: 'Important', SENT: 'Sent', DRAFT: 'Draft', SPAM: 'Spam', TRASH: 'Trash',
  CATEGORY_PERSONAL: 'Personal', CATEGORY_SOCIAL: 'Social', CATEGORY_PROMOTIONS: 'Promotions', CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums',
}
const LABEL_TONE = { UNREAD: 'info', IMPORTANT: 'warning', STARRED: 'warning', SPAM: 'danger', TRASH: 'danger' }

/** `412 KB`, `3.1 MB`: an attachment's size for a person. */
function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')

/** Label names a person reads: system labels by their Gmail names, user labels by `names`, the rest left out. */
function labelNames(ids, names = {}) {
  const out = []
  for (const id of ids || []) {
    if (SYSTEM_LABELS[id]) out.push({ id, name: SYSTEM_LABELS[id] })
    else if (names[id]) out.push({ id, name: names[id] })
  }
  return out
}

/**
 * @param {object} o
 * @param {string} o.title the thread's subject (or the alert group's title)
 * @param {object[]} o.messages raw format=full messages, any order (sorted here, oldest first)
 * @param {Map<string, string>} [o.assets] images.partKey -> asset id of the pictures downloaded
 * @param {Map<string, { html?: string, plain?: string }>} [o.bodies] bodies fetched apart (a big
 *   text part Gmail did not send inline), by message id
 * @param {string} [o.url] the Gmail link
 * @param {Record<string,string>} [o.labels] label id -> name
 * @param {string} [o.note] a line shown above the messages (an alert group, a cut)
 * @param {boolean} [o.aside] build the details column
 * @param {string} [o.tail] html that follows the messages (the "Jira issue" section, 0.2.0); its bytes
 *   count against the budget first, so the oldest messages give way rather than the cut falling in it
 * @param {string} [o.asideTail] html added to the end of the details column (the issue's facts)
 * @returns {{ html: string, aside?: string, omitted: number, remoteImages: number }}
 */
function threadDocument(o) {
  const assets = o.assets || new Map()
  const msgs = [...o.messages].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0))
  const facts = msgs.map(compactMessage)
  let remoteImages = 0
  const cards = msgs.map((raw, i) => {
    const r = messageCard(raw, facts[i], assets, o.bodies)
    remoteImages += r.remoteImages
    return r.html
  })
  const parts = []
  const head = o.aside
    ? `<div class="card"><h1>${esc(o.title || '(no subject)')}</h1></div>`
    : headerCard(o.title, facts, o.labels)
  parts.push(head)
  if (o.note) parts.push(`<p class="muted"><em>${esc(o.note)}</em></p>`)
  if (remoteImages) parts.push(`<p class="muted">${remoteImages} remote picture${remoteImages === 1 ? ' is' : 's are'} shown as a link: the plugin never loads pictures from the web (they can tell the sender you read the mail).</p>`)
  const tail = typeof o.tail === 'string' && o.tail ? o.tail : ''
  const fixed = bytes(parts.join('\n')) + bytes(tail) + 2000
  let room = HTML_MAX_BYTES - fixed
  const kept = []
  for (let i = cards.length - 1; i >= 0; i--) {
    const b = bytes(cards[i]) + 1
    if (b > room) break
    room -= b
    kept.unshift(cards[i])
  }
  const omitted = cards.length - kept.length
  if (omitted) parts.push(`<p><em>${omitted} earlier message${omitted === 1 ? ' is' : 's are'} not shown here (too long together); Gmail has ${omitted === 1 ? 'it' : 'them'}.</em></p>`)
  parts.push(...kept)
  if (tail) parts.push(tail)
  const out = { html: parts.join('\n'), omitted, remoteImages }
  if (o.aside) {
    out.aside = threadDetails(facts, o.url, o.labels)
    if (o.asideTail && out.aside.length + o.asideTail.length <= ASIDE_MAX) out.aside += o.asideTail
  }
  return out
}

/** One message as a card: header (sender, address, date, unread), To / Cc, body, attachments. */
function messageCard(raw, m, assets, bodies) {
  const w = walkMessage(raw)
  const extra = bodies && bodies.get(String(raw.id))
  const html = w.html || (extra && extra.html) || null
  const plain = w.plain || (extra && extra.plain) || null
  // The cid -> asset map of this message's inline pictures.
  const cidAsset = new Map()
  for (const img of w.images) {
    const asset = assets.get(partKey({ messageId: String(raw.id), partId: img.partId }))
    if (img.cid && asset) cidAsset.set(img.cid, asset)
  }
  let body = ''
  let used = new Set()
  let remoteImages = 0
  if (html) {
    const r = sanitizeHtml(html, { cid: (k) => cidAsset.get(k) || null })
    body = r.html
    used = r.usedCids
    remoteImages = r.remoteImages
    if (bytes(body) > BODY_MAX_BYTES) {
      body = `<p><em>This mail is too big to show formatted; its text follows.</em></p>\n${textToHtml(cut(plain || htmlToText(html), 300000))}`
      used = new Set()
    }
    if (!body.trim() && plain) body = textToHtml(plain)
  } else if (plain) {
    body = textToHtml(plain)
  }
  if (!body.trim()) body = m.snippet ? `<p>${esc(m.snippet)}</p>` : '<p><em>(no text)</em></p>'

  const who = `<strong>${esc(m.from || m.address || 'unknown')}</strong>${m.address && m.address !== m.from ? ` <span class="muted">&lt;${esc(m.address)}&gt;</span>` : ''}`
  const head = `<div class="card-header">${who} · ${esc(stamp(m.at))}${m.unread ? ' · <span class="lozenge lozenge-info">unread</span>' : ''}</div>`
  const meta = [m.to ? `To: ${esc(m.to)}` : '', m.cc ? `Cc: ${esc(m.cc)}` : ''].filter(Boolean).join(' · ')
  const files = attachmentsHtml(raw, w, used, assets)
  return { html: `<div class="card${m.unread ? ' new' : ''}">${head}${meta ? `\n<div class="meta">${meta}</div>` : ''}\n${body}${files ? `\n${files}` : ''}</div>`, remoteImages }
}

/**
 * The attachments of a message: a picture shown in the body is not listed again; a downloaded
 * picture that the body does not show is a figure; every other one (and a picture over the
 * budget) is its name and size. No download links in v1 (design "Left out of v1").
 */
function attachmentsHtml(raw, w, used, assets) {
  const items = []
  for (const img of w.images) {
    if (img.cid && used.has(img.cid)) continue
    const asset = assets.get(partKey({ messageId: String(raw.id), partId: img.partId }))
    const meta = [fmtSize(img.size)].filter(Boolean).join(' · ')
    if (asset) items.push(`<li><figure><img data-asset="${esc(asset)}" alt="${esc(img.name)}" title="${esc(img.name)}"><figcaption>${esc(img.name)}${meta ? ` · ${esc(meta)}` : ''}</figcaption></figure></li>`)
    else if (!img.inline || !img.cid) items.push(`<li>${esc(img.name)}${meta ? ` · ${esc(meta)}` : ''}</li>`)
  }
  for (const f of w.files) items.push(`<li>${esc(f.name)}${f.size ? ` · ${esc(fmtSize(f.size))}` : ''}</li>`)
  if (!items.length) return ''
  return `<div class="meta">Attachments (${items.length})</div><ul class="attachment-list">${items.join('')}</ul>`
}

/** People of a To / Cc header as name chips, at most `max`, the rest counted. */
function people(header, max = 12) {
  const list = parseAddressList(header)
  const shown = list.slice(0, max).map((a) => `<span class="person" title="${esc(a.address)}">${esc(displayName(a))}</span>`)
  if (list.length > max) shown.push(`<span class="muted">+${list.length - max} more</span>`)
  return shown.join(' ')
}

/** The details column (reviewer `aside`, cc-cockpit 0.9.1+). */
function threadDetails(facts, url, labelMap) {
  const first = facts[0] || {}
  const latest = facts[facts.length - 1] || {}
  const row = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '')
  const labels = labelNames([...new Set(facts.flatMap((m) => m.labels || []))], labelMap)
  const pills = labels.map((l) => `<span class="lozenge lozenge-${LABEL_TONE[l.id] || 'neutral'}">${esc(l.name)}</span>`).join(' ')
  const unread = facts.filter((m) => m.unread).length
  const from = [...new Set(facts.map((m) => m.from || m.address).filter(Boolean))]
  let html = [
    '<dl class="facts">',
    row('From', from.slice(0, 8).map((x) => `<span class="person">${esc(x)}</span>`).join(' ') + (from.length > 8 ? ` <span class="muted">+${from.length - 8} more</span>` : '')),
    row('To', people(latest.to)),
    row('Cc', people(latest.cc)),
    row('Date', esc(stamp(latest.at))),
    row('Started', facts.length > 1 ? esc(stamp(first.at)) : ''),
    row('Labels', pills),
    row('Messages', `${facts.length}${unread ? ` (${unread} unread)` : ''}`),
    row('Mailing list', latest.listId ? esc(latest.listId) : ''),
    row('Gmail', url ? `<a href="${esc(url)}">Open in Gmail</a>` : ''),
    '</dl>',
  ].join('')
  if (html.length > ASIDE_MAX) html = `<dl class="facts">${row('Messages', String(facts.length))}${row('Gmail', url ? `<a href="${esc(url)}">Open in Gmail</a>` : '')}</dl>`
  return html
}

/** The header card for our own reader page (no details column there). */
function headerCard(title, facts, labelMap) {
  const latest = facts[facts.length - 1] || {}
  const labels = labelNames([...new Set(facts.flatMap((m) => m.labels || []))], labelMap)
  const meta = [`${facts.length} message${facts.length === 1 ? '' : 's'}`, latest.at ? `latest ${esc(stamp(latest.at))}` : '', labels.map((l) => esc(l.name)).join(', ')].filter(Boolean)
  return `<div class="card"><h1>${esc(title || '(no subject)')}</h1>\n<div class="meta">${meta.join(' · ')}</div></div>`
}

module.exports = { threadDocument, threadDetails, messageCard, labelNames, fmtSize, HTML_MAX_BYTES, SYSTEM_LABELS }
