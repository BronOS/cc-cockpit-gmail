'use strict'
// Gmail's thread and message shapes, cut down to what the lanes, triage and the CLI need: per
// message who sent it to whom, the subject, the snippet, the time and its labels. This is what the
// cache file keeps (no bodies: those are read fresh when a thread is opened).

const { decode } = require('./entities')
const { cut, oneLine } = require('./util')
const { CHAT_COPY } = require('./query')

const CUTS = { header: 500, subject: 300, snippet: 400, labels: 50 }

/** A header of a message payload by name (any letter case), '' when absent. */
function header(m, name) {
  const hs = m && m.payload && Array.isArray(m.payload.headers) ? m.payload.headers : []
  const want = name.toLowerCase()
  const h = hs.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === want)
  return h && typeof h.value === 'string' ? h.value : ''
}

/**
 * `"Ann Smith" <ann@x.com>` -> `{ name: 'Ann Smith', address: 'ann@x.com' }`; a bare address has no
 * name; a value with no address keeps it as the name. Gmail has already decoded RFC 2047 words.
 */
function parseAddress(value) {
  const s = String(value == null ? '' : value).trim()
  const angle = /^(.*?)<([^<>]*)>\s*$/.exec(s)
  if (angle) {
    let name = angle[1].trim()
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1')
    return { name: oneLine(name), address: angle[2].trim().toLowerCase() }
  }
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: '', address: s.toLowerCase() }
  return { name: oneLine(s), address: '' }
}

/** A To / Cc header as addresses: split on commas outside quotes and angle brackets. */
function parseAddressList(value) {
  const s = String(value == null ? '' : value)
  const out = []
  let cur = ''
  let quoted = false
  let angle = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && quoted && i + 1 < s.length) {
      cur += c + s[++i]
      continue
    }
    if (c === '"') quoted = !quoted
    else if (!quoted && c === '<') angle++
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1)
    if (c === ',' && !quoted && angle === 0) {
      if (cur.trim()) out.push(parseAddress(cur))
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(parseAddress(cur))
  return out.slice(0, 200)
}

/** A name for a person: the display name, else the address, else what was there. */
function displayName(a) {
  return a.name || a.address || ''
}

/** One message as the cache keeps it (from format=metadata or format=full). */
function compactMessage(m) {
  const from = parseAddress(header(m, 'From'))
  const labels = Array.isArray(m.labelIds) ? m.labelIds.filter((x) => typeof x === 'string').slice(0, CUTS.labels) : []
  const at = Number(m.internalDate)
  return {
    id: String(m.id),
    at: Number.isFinite(at) ? at : 0,
    from: cut(displayName(from), 200),
    address: cut(from.address, 254),
    to: cut(oneLine(header(m, 'To')), CUTS.header),
    cc: cut(oneLine(header(m, 'Cc')), CUTS.header),
    subject: cut(oneLine(header(m, 'Subject')), CUTS.subject),
    snippet: cut(oneLine(decode(typeof m.snippet === 'string' ? m.snippet : '')), CUTS.snippet),
    unread: labels.includes('UNREAD'),
    labels,
    listId: cut(oneLine(header(m, 'List-Id')), 200),
  }
}

/** Whether a message is Gmail's copy of a Google Chat message (left out everywhere). */
function isChatCopy(msg) {
  return msg.address === CHAT_COPY
}

/**
 * A thread as the cache keeps it: its historyId (the listing's, so the next listing can tell a
 * change) and its messages oldest first, Chat copies left out.
 */
function compactThread(raw, historyId) {
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .filter((m) => m && m.id != null)
    .map(compactMessage)
    .filter((m) => !isChatCopy(m))
    .sort((a, b) => a.at - b.at)
  return { id: String(raw.id), historyId: String(historyId || raw.historyId || ''), messages }
}

/**
 * The row facts of a thread for the person `me` (their address): the message that speaks for it
 * (the newest unread one of others, else the newest of others, else the newest), its unread count.
 * Null for a thread with no message left (only Chat copies).
 */
function threadFacts(thread, me) {
  const msgs = thread.messages || []
  if (!msgs.length) return null
  const others = msgs.filter((m) => !me || m.address !== me)
  const unreadMsgs = msgs.filter((m) => m.unread)
  const unreadOthers = others.filter((m) => m.unread)
  const lead = unreadOthers[unreadOthers.length - 1] || others[others.length - 1] || msgs[msgs.length - 1]
  const latest = msgs[msgs.length - 1]
  return {
    lead,
    latest,
    subject: lead.subject || latest.subject || '(no subject)',
    unread: unreadMsgs.length > 0,
    unreadCount: unreadMsgs.length,
    count: msgs.length,
    at: latest.at,
    participants: [...new Set(others.map((m) => m.from).filter(Boolean))],
  }
}

/** How a message is addressed to the person: in To, in Cc, or neither (a list, a group). */
function addressedTo(msgs, me) {
  if (!me) return 'unknown'
  const has = (field) => msgs.some((m) => parseAddressList(m[field]).some((a) => a.address === me))
  if (has('to')) return 'to'
  if (has('cc')) return 'cc'
  return 'other'
}

module.exports = { header, parseAddress, parseAddressList, displayName, compactMessage, compactThread, threadFacts, addressedTo, isChatCopy, CUTS }
