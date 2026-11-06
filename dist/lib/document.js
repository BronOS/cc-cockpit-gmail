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
//
// The mail layout (0.6.0, `o.mail`, for a reviewer with the 'mail' feature: app 0.13.0): the subject
// as the page's h1, then each message as a `mail-msg` with its own header row (`mail-head`: avatar
// initials, sender name and address, "to …", the time at the right with an Unread chip under it),
// no card and no tint on unread mail (the overlay is neutral; the source's colour is the toolbar's).
// A related item's card (`o.related`, the Jira issue a mail is about) and the remote-images bar
// (`o.images`) come under the subject. Remote pictures are placeholders the reviewer fills later
// (sanitize.js), so a mail's html does not depend on whether its pictures were loaded: buildCards
// runs once, the host loads what it may, and threadDocument assembles. Without `o.mail` the layout is
// the one before 0.6.0 (cards), for an older reviewer and the plugin's own reader page.

const { esc } = require('./entities')
const { sanitizeHtml, textToHtml, htmlToText } = require('./sanitize')
const { walkMessage } = require('./mime')
const { compactMessage, parseAddressList, displayName } = require('./model')
const { partKey } = require('./images')
const { stamp, cut } = require('./util')

const REMOTE_BAR_PART = 'images-bar' // the bar's data-part: hidden by update() once the pictures are in
const ACTION_SHOW = 'show-images'
const ACTION_ALWAYS = 'always-sender'

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
 * @param {boolean} [o.mail] the mail layout (see the header); remote pictures as placeholders
 * @param {{ loaded?: (id: string) => boolean }} [o.remote] which remote pictures the host loaded (their
 *   assets go with the annotate): those are not counted in the bar (and, outside the mail layout, are
 *   written as pictures instead of their labels)
 * @param {{ actions?: boolean, address?: string }} [o.images] the bar's buttons and the sender they name
 * @param {string} [o.related] the related item's card (jira.js relatedCard), under the subject
 * @param {number} [o.now] the clock, for "Today 09:09"
 * @param {object} [o.built] buildCards' answer for these options, when the host already built it
 * @returns {{ html: string, aside?: string, omitted: number, remoteImages: number, remote: object[] }}
 */
function threadDocument(o) {
  const built = o.built || buildCards(o)
  const { facts, cards } = built
  const loaded = o.remote && typeof o.remote.loaded === 'function' ? o.remote.loaded : () => false
  // Not shown: each remote picture once, the ones the host did not load. A minor one (a logo, an
  // avatar, a tiny spacer) is not counted: it is hidden either way, and a bar for a lone logo is noise.
  const remoteImages = built.remote.filter((r) => !loaded(r.id) && !r.minor).length
  const parts = []
  let head
  if (o.mail) head = `<h1>${esc(o.title || '(no subject)')}</h1>`
  else head = o.aside ? `<div class="card"><h1>${esc(o.title || '(no subject)')}</h1></div>` : headerCard(o.title, facts, o.labels)
  parts.push(head)
  if (o.mail && typeof o.related === 'string' && o.related) parts.push(o.related)
  if (o.note) parts.push(o.mail ? `<p class="mail-note"><em>${esc(o.note)}</em></p>` : `<p class="muted"><em>${esc(o.note)}</em></p>`)
  if (remoteImages) parts.push(o.mail ? imagesBar(remoteImages, o.images || {}) : `<p class="muted">${remoteImages} remote picture${remoteImages === 1 ? ' is' : 's are'} not shown: senders can tell when you open a mail by them. Settings › Plugins › Gmail can show them.</p>`)
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
  const out = { html: parts.join('\n'), omitted, remoteImages, remote: built.remote }
  if (o.aside) {
    out.aside = threadDetails(facts, o.url, o.labels)
    if (o.asideTail && out.aside.length + o.asideTail.length <= ASIDE_MAX) out.aside += o.asideTail
  }
  return out
}

/**
 * The messages as html, oldest first, before they are put together: `{ facts, cards, remote,
 * remoteImages }`. `remote`: each remote picture of the thread once (sanitize.js), with the message
 * and the sender it came from (the always-show list is per sender). Options as threadDocument's.
 */
function buildCards(o) {
  const assets = o.assets || new Map()
  const msgs = [...o.messages].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0))
  const facts = msgs.map(compactMessage)
  let remoteImages = 0
  const remote = new Map()
  const cards = msgs.map((raw, i) => {
    const r = messageCard(raw, facts[i], assets, o.bodies, { mail: Boolean(o.mail), remote: o.remote, now: o.now })
    remoteImages += r.remoteImages
    for (const x of r.remote) if (!remote.has(x.id)) remote.set(x.id, { ...x, messageId: String(raw.id), address: facts[i].address })
    return r.html
  })
  return { facts, cards, remote: [...remote.values()], remoteImages }
}

/**
 * The remote-images bar of the mail layout: how many are not shown and why, and (`actions`: a
 * reviewer with the 'actions' and 'update' features) Show images and Always show from <sender>. The
 * reviewer turns each `data-action` span into a button and tells the host of a click; the bar is a
 * `data-part`, so update() hides it once the pictures are in.
 */
function imagesBar(n, o) {
  const text = `${n} remote image${n === 1 ? ' is' : 's are'} not shown (senders can track when you open mail).`
  const buttons = []
  if (o.actions) {
    buttons.push(`<span data-action="${ACTION_SHOW}">Show images</span>`)
    const a = typeof o.address === 'string' ? o.address : ''
    if (a) buttons.push(`<span data-action="${ACTION_ALWAYS}" title="${esc(`Always show the pictures of mail from ${a}`)}">${esc(cut(`Always show from ${a}`, 60))}</span>`)
  }
  return `<div class="mail-images-bar" data-part="${REMOTE_BAR_PART}"><span class="mail-images-text">${esc(text)}</span>${buttons.length ? ` ${buttons.join(' ')}` : ''}</div>`
}

/** "AE" for Ann Example (a "(Jira)" or "via …" part left out); the address's first letter without a name. */
function initials(name, address) {
  const words = String(name || '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\bvia\b.*$/i, ' ')
    .split(/[\s,._-]+/)
    .map((w) => [...w].find((ch) => /\p{L}|\p{N}/u.test(ch)))
    .filter(Boolean)
  if (words.length >= 2) return (words[0] + words[words.length - 1]).toUpperCase()
  if (words.length === 1) return words[0].toUpperCase()
  const first = [...String(address || '')].find((ch) => /\p{L}|\p{N}/u.test(ch))
  return first ? first.toUpperCase() : '?'
}

/** "Today 09:09" for a time of today, else the date and time (stamp). */
function when(ms, now) {
  if (!ms) return ''
  const t = stamp(ms)
  return now && stamp(now).slice(0, 10) === t.slice(0, 10) ? `Today ${t.slice(11)}` : t
}

/** The names of an address header for "to …": at most `max`, the rest counted. */
function names(header, max = 4) {
  const list = parseAddressList(header)
  const shown = list.slice(0, max).map((a) => esc(displayName(a)))
  if (list.length > max) shown.push(`+${list.length - max}`)
  return shown.join(', ')
}

/** One message as a card: header (sender, address, date, unread), To / Cc, body, attachments. */
function messageCard(raw, m, assets, bodies, x = {}) {
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
  let remote = []
  if (html) {
    const loaded = x.remote && typeof x.remote.loaded === 'function' ? x.remote.loaded : undefined
    const r = sanitizeHtml(html, { cid: (k) => cidAsset.get(k) || null, mail: x.mail, remote: { mode: x.mail ? 'placeholder' : 'label', loaded } })
    body = r.html
    used = r.usedCids
    remoteImages = r.remoteImages
    remote = r.remote
    if (bytes(body) > BODY_MAX_BYTES) {
      body = `<p><em>This mail is too big to show formatted; its text follows.</em></p>\n${textToHtml(cut(plain || htmlToText(html), 300000))}`
      used = new Set()
      remote = [] // its text only now: no picture of it is shown
    }
    if (!body.trim() && plain) body = textToHtml(plain)
  } else if (plain) {
    body = textToHtml(plain)
  }
  if (!body.trim()) body = m.snippet ? `<p>${esc(m.snippet)}</p>` : '<p><em>(no text)</em></p>'

  if (x.mail) {
    const files = attachmentsHtml(raw, w, used, assets)
    const name = m.from || m.address || 'unknown'
    const from = `<div class="mail-from"><span class="mail-name">${esc(name)}</span>${m.address && m.address !== name ? `<span class="mail-addr">${esc(m.address)}</span>` : ''}</div>`
    const to = [m.to ? `to ${names(m.to)}` : '', m.cc ? `cc ${names(m.cc)}` : ''].filter(Boolean).join(' · ')
    const time = `<div class="mail-when">${esc(when(m.at, x.now))}${m.unread ? '<br><span class="mail-chip">Unread</span>' : ''}</div>`
    const head = `<div class="mail-head"><div class="mail-avatar">${esc(initials(m.from, m.address))}</div><div class="mail-who">${from}${to ? `<div class="mail-to">${to}</div>` : ''}</div>${time}</div>`
    return { html: `<div class="mail-msg">${head}\n<div class="mail-body">${body}</div>${files ? `\n${files}` : ''}</div>`, remoteImages, remote }
  }

  const who = `<strong>${esc(m.from || m.address || 'unknown')}</strong>${m.address && m.address !== m.from ? ` <span class="muted">&lt;${esc(m.address)}&gt;</span>` : ''}`
  const head = `<div class="card-header">${who} · ${esc(stamp(m.at))}${m.unread ? ' · <span class="lozenge lozenge-info">unread</span>' : ''}</div>`
  const meta = [m.to ? `To: ${esc(m.to)}` : '', m.cc ? `Cc: ${esc(m.cc)}` : ''].filter(Boolean).join(' · ')
  const files = attachmentsHtml(raw, w, used, assets)
  return { html: `<div class="card${m.unread ? ' new' : ''}">${head}${meta ? `\n<div class="meta">${meta}</div>` : ''}\n${body}${files ? `\n${files}` : ''}</div>`, remoteImages, remote }
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

module.exports = { threadDocument, buildCards, threadDetails, messageCard, imagesBar, initials, when, labelNames, fmtSize, HTML_MAX_BYTES, SYSTEM_LABELS, REMOTE_BAR_PART, ACTION_SHOW, ACTION_ALWAYS }
