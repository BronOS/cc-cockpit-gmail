'use strict'
// The `inbox-feed` service (v1, 0.4.0) this plugin provides to Inbox: the pure parts. The host
// (dist/host.js) wires them to its view and its existing open and mark-read paths.
//
// - Built only from the cached view the panel shows (poll.buildView), never an API call: Inbox may
//   ask on every refresh, and a service call has no rate limit from the app. Unread rows only: a
//   thread the person has read in Gmail (or marked read here) has left their inbox, and the Read
//   lane is there for the panel, not for a queue of things that need them.
// - `recent` (optional, announced through `features()`): the same FeedItems for the READ rows of the
//   Read lane, newest first, so Inbox can offer "reopen what I just read". Same cache, same row
//   mapping, caps and limit rule, still never an API call. A thread marked read here while it sits in
//   the Unread lane is not in it (the lane is the contract, not the flag alone). open() already finds
//   these ids: it searches every row of the view, the Read lane included.
// - `level` is this plugin's own triage verdict (Jev, or its alert/Jira hints), best first. A row
//   without a verdict (triage off, not judged yet) is `fyi`: shown after the judged ones, never
//   hidden and never shouted. Noise is left out unless nothing else is left.
// - `rev` is the id of the newest message (an alert group: of its newest alert), so a new reply
//   changes it and Inbox's "done until it changes" brings the thread back; marking read does not.
// - `direct`: the message that speaks for the thread has the person in To (not Cc, not a list).
//   `mentionsMe` is left out: mail has no mention notion. `jiraKey` is what lib/jira.js found.
// - Arguments come from another plugin, so every one is checked; strings are cut to the same
//   bounds the cache keeps, the result is plain data (the registry copies it with structuredClone).
//   Errors are thrown as `gmail: <why>`.

const { cut, oneLine, rowId } = require('./util')
const { addressedTo } = require('./model')
const { groupTitle } = require('./alerts')

const DESCRIBE = Object.freeze({ label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' })
const FEATURES = Object.freeze(['markRead', 'recent', 'markUnread'])
const LEVEL_RANK = { urgent: 0, action: 1, fyi: 2, noise: 3 }
const LIMIT = { def: 20, min: 1, max: 50 }
const CUTS = { title: 300, from: 200, where: 60 }
const LANE_TITLE = { unread: 'Unread', alerts: 'Alerts', read: 'Read' }

/** The feed level of a row: its verdict's priority when it is one of the four, else `fyi`. */
function levelOf(row) {
  const p = row.verdict && row.verdict.priority
  // hasOwn, not `in`: a verdict of "constructor" must not pass as a level.
  return typeof p === 'string' && Object.hasOwn(LEVEL_RANK, p) ? p : 'fyi'
}

/**
 * One view row as a FeedItem.
 * @param {object} row poll.buildView's row
 * @param {{ me?: string, jiraKeys?: Map<string, string> }} o the person's address; row id -> issue key
 */
function feedItem(row, o = {}) {
  const base = { id: row.id, where: LANE_TITLE[row.lane] || cut(String(row.lane || ''), CUTS.where), at: row.at || 0, level: levelOf(row), unread: Boolean(row.unread) }
  if (row.kind === 'alert') {
    const g = row.group
    return { ...base, rev: String(g.latest.id), title: cut(oneLine(groupTitle(g)), CUTS.title), from: cut(g.latest.from || g.latest.address || '', CUTS.from), direct: false }
  }
  const f = row.facts
  const item = {
    ...base,
    rev: String(f.latest.id),
    title: cut(oneLine(f.subject), CUTS.title),
    from: cut(f.lead.from || f.lead.address || '', CUTS.from),
    direct: addressedTo([f.lead], o.me || '') === 'to',
  }
  const key = o.jiraKeys && o.jiraKeys.get(row.id)
  if (key) item.jiraKey = key
  return item
}

/** The limit of a call: the default when absent, else clamped to 1..50; anything but an object throws. */
function feedLimit(arg) {
  if (arg === undefined || arg === null) return LIMIT.def
  if (typeof arg !== 'object' || Array.isArray(arg)) throw new Error('gmail: items takes an object ({ limit })')
  const n = Math.floor(Number(arg.limit))
  if (arg.limit === undefined || arg.limit === null || !Number.isFinite(n)) return LIMIT.def
  return Math.min(LIMIT.max, Math.max(LIMIT.min, n))
}

/**
 * The items, best first: unread rows by level, then the newest, noise only when nothing else is
 * left, at most `limit`.
 * @param {object[]} rows poll.allRows(view)
 * @param {{ limit: number, me?: string, jiraKeys?: Map<string, string> }} o
 */
function feedItems(rows, o) {
  const all = rows
    .filter((r) => r.unread)
    .map((r) => feedItem(r, o))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.at - a.at || (a.id < b.id ? -1 : 1))
  const real = all.filter((i) => i.level !== 'noise')
  return (real.length ? real : all).slice(0, o.limit)
}

/**
 * The recently read items: threads of the Read lane that are read, newest message first (then the
 * id, a stable order), at most `limit`. No level order and no noise rule: a history, not a queue.
 * An alert group is never in the Read lane (the poll leaves alert senders out of it).
 * @param {object[]} rows poll.allRows(view)
 * @param {{ limit: number, me?: string, jiraKeys?: Map<string, string> }} o
 */
function recentItems(rows, o) {
  return rows
    .filter((r) => r.lane === 'read' && r.kind === 'thread' && !r.unread)
    .map((r) => feedItem(r, o))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .slice(0, o.limit)
}

/** The id of open() / markRead(): a thread id or `alert:<name>` as a string, else it throws. */
function feedId(value) {
  if (typeof value !== 'string' || !rowId(value)) throw new Error('gmail: not a thread id')
  return value
}

module.exports = { DESCRIBE, FEATURES, LIMIT, feedItem, feedItems, recentItems, feedLimit, feedId, levelOf }
