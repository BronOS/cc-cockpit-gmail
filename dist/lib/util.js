'use strict'
// Small helpers shared by the other modules: text cuts, a bounded parallel map, stable hashes,
// times for a person, and the checks on ids that go into a Gmail URL path. No I/O here, so every
// suite can use them as they are.

const crypto = require('node:crypto')

/** `text` cut to at most `max` characters, with an ellipsis that says it was cut. */
function cut(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** One line: line breaks and runs of white space become one space (rows, notices, a subject). */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/**
 * Run `fn` over `items` with at most `limit` running at once (design: concurrency 4, so a first
 * run with 135 threads does not open 135 sockets to Gmail). Resolves to
 * `[{ ok: true, value } | { ok: false, error }]` in the items' order: one failing thread never
 * fails the poll.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = { ok: true, value: await fn(items[i], i) }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker())
  await Promise.all(workers)
  return out
}

/** A short stable hash of a JSON value: what a triage item looked like when it was classified. */
function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/** The first `n` hex digits of sha256(text): a key part that names a value without holding it. */
function sha(text, n = 12) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, n)
}

/** `2026-10-30 14:02`, local time: a person reads it (a message date, the last poll). */
function stamp(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "3 min ago", "2 h ago": `ccc gmail status`. */
function ago(ms, now = Date.now()) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

/**
 * A Gmail thread or message id (hex digits in practice; the old connector allowed `A-Za-z0-9_-`),
 * or null. It goes into a URL path and a cache key, so nothing that could add a path segment or a
 * query passes.
 */
function gmailId(value) {
  const s = String(value == null ? '' : value).trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null
}

const ALERT = 'alert:'
const MAX_ALERT_NAME = 200 // a triage id is at most 256 characters

/**
 * A row id from the panel or the CLI: a thread id, or `alert:<name>` (an alert group). Returns
 * `{ thread }` or `{ alert }`, null for anything else.
 */
function rowId(value) {
  const s = String(value == null ? '' : value)
  if (s.startsWith(ALERT)) {
    const name = s.slice(ALERT.length)
    if (name.trim() && name.length <= MAX_ALERT_NAME && !/[\r\n\0]/.test(name)) return { alert: name }
    return null
  }
  const id = gmailId(s)
  return id ? { thread: id } : null
}

/** An email address as the plugin keeps it (lower case), or null when it does not look like one. */
function emailAddress(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase()
  // No characters a Gmail query or a URL path would read as syntax (space, quotes, braces,
  // parentheses, commas): an address goes into `from:` and into the Gmail link.
  if (s.length > 254 || !/^[^\s@"'(){}<>,;:\\/[\]]+@[^\s@"'(){}<>,;:\\/[\]]+\.[^\s@"'(){}<>,;:\\/[\]]+$/.test(s)) return null
  return s
}

module.exports = { cut, oneLine, mapLimit, hashOf, sha, stamp, ago, gmailId, rowId, emailAddress, ALERT, MAX_ALERT_NAME }
