'use strict'
// A thread as readable plain text: what `ccc gmail show` prints, what the reviewer shows in its
// text mode (a reviewer before cc-cockpit 0.8.0's HTML mode), and what Discuss / New session hand
// to Claude (design: `About the mail "<subject>" from <sender>` + the readable text). Also the
// Gmail links.

const { cut, oneLine, stamp, emailAddress, gmailId } = require('./util')
const { compactMessage } = require('./model')
const { walkMessage } = require('./mime')
const { htmlToText } = require('./sanitize')
const { alertSearch } = require('./query')

const MESSAGE_TEXT_MAX = 20000

/**
 * The thread in Gmail's web app, in this account. `?authuser=<address>` picks the account when the
 * browser is signed in to several, and asks to sign in when it is not; `u/<address>/` instead
 * answers "Temporary Error (404)" in a browser not signed in to that account (seen 2026-11-03).
 * Null when the address or id does not check out.
 */
function gmailUrl(address, threadId) {
  const a = emailAddress(address)
  const id = gmailId(threadId)
  if (!a || !id) return null
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(a)}#all/${id}`
}

/** An alert group in Gmail: a search for its sender and name. */
function alertUrl(address, senders, name) {
  const a = emailAddress(address)
  if (!a) return null
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(a)}#search/${encodeURIComponent(alertSearch(senders, name))}`
}

/** One message's body as text: the plain part, else the HTML part as text, else the snippet. */
function messageText(raw, bodies) {
  const w = walkMessage(raw)
  const extra = bodies && bodies.get(String(raw.id))
  const plain = w.plain || (extra && extra.plain) || ''
  const html = w.html || (extra && extra.html) || ''
  const text = plain.trim() ? plain : html ? htmlToText(html) : compactMessage(raw).snippet
  return { text: cut(String(text).replace(/\r\n?/g, '\n').trim(), MESSAGE_TEXT_MAX), files: [...w.files, ...w.images.filter((i) => !i.inline)].map((f) => f.name) }
}

/**
 * The thread as text, oldest message first: subject, then per message who, to whom, when, its text
 * and its attachments' names. `unread` messages are marked `[unread]`.
 *
 * @param {{ subject: string, messages: object[], url?: string, note?: string, bodies?: Map }} t raw format=full messages
 */
function readableText(t) {
  const lines = [oneLine(t.subject) || '(no subject)']
  if (t.url) lines.push(`Gmail: ${t.url}`)
  if (t.note) lines.push(`(${t.note})`)
  lines.push(`${t.messages.length} message${t.messages.length === 1 ? '' : 's'}, oldest first.`)
  for (const raw of t.messages) {
    const m = compactMessage(raw)
    const { text, files } = messageText(raw, t.bodies)
    lines.push('', '-'.repeat(60), `${m.unread ? '[unread] ' : ''}From: ${m.from}${m.address && m.address !== m.from ? ` <${m.address}>` : ''}`)
    if (m.to) lines.push(`To: ${m.to}`)
    if (m.cc) lines.push(`Cc: ${m.cc}`)
    lines.push(`Date: ${stamp(m.at) || '-'}`)
    if (m.subject && m.subject !== oneLine(t.subject)) lines.push(`Subject: ${m.subject}`)
    lines.push('', text || '(no text)')
    if (files.length) lines.push('', `Attachments: ${files.join(', ')}`)
  }
  return lines.join('\n')
}

const PROMPT_MAX = 16000

/**
 * What Discuss and New session hand to Claude: it starts `About the mail "<subject>" from
 * <sender>` (never `/`, `!`, `#` or `&`, which the app refuses), then the readable text, capped.
 */
function discussPrompt(subject, sender, text, max = PROMPT_MAX) {
  const head = `About the mail "${cut(oneLine(subject) || '(no subject)', 200)}" from ${cut(oneLine(sender) || 'unknown', 120)}`
  const body = `${head}\n\nThe thread as it is now (read-only; the plugin does not change anything in Gmail):\n\n${text}`
  return cut(body, max)
}

module.exports = { gmailUrl, alertUrl, readableText, messageText, discussPrompt, PROMPT_MAX }
