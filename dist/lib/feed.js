'use strict'
// The `inbox-feed` service (v2, 0.5.0) this plugin provides to Inbox: the pure parts. The host
// (dist/host.js) wires them to its view and its existing open and mark-read paths.
//
// - Built only from the cached view the panel shows (poll.buildView) and the cached threads, never
//   an API call: Inbox calls `snapshot()` whenever a provider joins and a service call has no rate
//   limit from the app.
// - The scope is the view itself: the threads of the Unread and Read lanes (so `unreadDays`, the read
//   lane's days and its cap already apply) and the alert threads, each its own item. An alert group
//   is a panel idea; the feed has no groups, so the group's threads are items labelled `alert` and
//   `alert:<name>`. Triage verdicts stay in this plugin's lanes: the feed carries facts, and Inbox's
//   rules decide what matters.
// - `rev` is the id of the newest message, so a new reply changes it; marking read does not.
// - `diffFeed` is how events are made: after each poll and each mark the host compares the list with
//   what it last told and emits `item` for any changed field and `gone` for a missing id.
// - Plain data only (the registry copies it with structuredClone); every string is cut to the
//   contract's caps here too, since Inbox treats a source as untrusted.

const { cut, oneLine } = require('./util')
const { addressedTo, threadFacts } = require('./model')

const DESCRIBE = Object.freeze({ label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' })
const FEATURES = Object.freeze([])
const MAX_ITEMS = 1000
const MAX_GONE = 500
const CUTS = { title: 300, preview: 1000, name: 120, address: 254, label: 40, labels: 20, scope: 120, message: 300 }
const ACTION_LABELS = { open: 'Open', markRead: 'Mark read', markUnread: 'Mark unread' }
const PLACE = Object.freeze({ kind: 'folder', name: 'Inbox' })

/** `scope` of describe(): what the feed holds, from the settings (a hidden lane is not in it). */
function scopeLine(cfg) {
  const lanes = (cfg && cfg.lanes) || {}
  const parts = []
  if (lanes.unread !== false) parts.push(`unread of the last ${cfg.unreadDays} days`)
  else if (lanes.alerts !== false && cfg && cfg.alertSenders && cfg.alertSenders.length) parts.push('unread alerts')
  if (lanes.read !== false) parts.push(`read of the last ${cfg.readDays} days`)
  return cut(parts.length ? parts.join(' + ') : 'nothing (every lane is off)', CUTS.scope)
}

/** Label names a person's rules can use: system labels as flags, user labels by name, the rest left out. */
function labelsOf(thread, names) {
  const ids = new Set()
  for (const m of thread.messages || []) for (const l of m.labels || []) ids.add(l)
  const out = []
  for (const id of ids) {
    if (id === 'IMPORTANT') out.push('important')
    else if (id === 'STARRED') out.push('starred')
    else if (id.startsWith('CATEGORY_')) out.push(`category:${id.slice(9).toLowerCase()}`)
    else if (id.startsWith('Label_') && names && names[id]) out.push(oneLine(names[id]))
  }
  return out
}

/**
 * One cached thread as a FeedItem.
 * @param {object} thread model.compactThread's thread
 * @param {{ me?: string, jiraKeys?: Map<string, string>, labelNames?: Record<string, string>, alert?: string | true }} o
 *   `alert`: the thread is in the Alerts lane (its alert name, or true for a plain alert-sender thread)
 * @returns {object | null} null for a thread with no message
 */
function threadItem(thread, o = {}) {
  const facts = threadFacts(thread, o.me || '')
  if (!facts) return null
  const { lead, latest } = facts
  const labels = labelsOf(thread, o.labelNames)
  if (o.alert) {
    labels.push('alert')
    if (typeof o.alert === 'string') labels.push(`alert:${o.alert}`)
  }
  const key = o.jiraKeys && o.jiraKeys.get(thread.id)
  if (key) labels.push(`jira:${key}`)
  const item = {
    id: thread.id,
    rev: String(latest.id),
    title: cut(oneLine(facts.subject), CUTS.title) || '(no subject)',
    time: Math.max(1, Number(latest.at) || 0),
    read: !facts.unread,
    place: { ...PLACE },
    actions: [{ id: 'open', label: ACTION_LABELS.open }, facts.unread ? { id: 'markRead', label: ACTION_LABELS.markRead } : { id: 'markUnread', label: ACTION_LABELS.markUnread }],
  }
  const preview = cut(oneLine(latest.snippet || ''), CUTS.preview)
  if (preview) item.preview = preview
  const from = {}
  if (lead.from) from.name = cut(lead.from, CUTS.name)
  if (lead.address) from.address = cut(lead.address, CUTS.address)
  if (from.name || from.address) item.from = from
  const to = addressedTo([lead], o.me || '')
  if (to === 'to') item.to = 'direct'
  else if (to === 'cc') item.to = 'cc'
  else if (to === 'other') item.to = 'group'
  const seen = new Set()
  const clean = []
  for (const l of labels) {
    const s = cut(oneLine(l), CUTS.label)
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase())
      clean.push(s)
    }
  }
  if (clean.length) item.labels = clean.slice(0, CUTS.labels)
  return item
}

/**
 * The whole scope as items, newest first (then the id, a stable order), at most `limit`
 * (default 1000, the contract's cap; `act` passes Infinity to check an id against everything).
 * @param {object[]} rows poll.allRows(view)
 * @param {{ me?: string, jiraKeys?: Map<string, string>, labelNames?: Record<string, string>, threads?: Record<string, object>, limit?: number }} o
 *   `threads`: the (mark-overlaid) cached threads, to find the threads of an alert group
 */
function feedItems(rows, o = {}) {
  const byId = new Map()
  const add = (thread, extra) => {
    const it = thread && thread.id && !byId.has(thread.id) ? threadItem(thread, { ...o, ...extra }) : null
    if (it) byId.set(it.id, it)
  }
  for (const r of rows) {
    if (r.kind === 'alert') {
      for (const tid of r.group.threadIds || []) add(o.threads && o.threads[tid], { alert: r.group.name })
    } else {
      add(r.thread, { alert: r.lane === 'alerts' ? true : undefined })
    }
  }
  const limit = o.limit === undefined ? MAX_ITEMS : o.limit
  return [...byId.values()].sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1)).slice(0, limit)
}

/** JSON with sorted keys: two items are the same when this is. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/**
 * What changed between the list last told and the list now.
 * @param {object[] | Map<string, object>} prev items last told
 * @param {object[]} next items now
 * @returns {{ items: object[], gone: string[] }} `items`: new or changed (any field), `gone`: ids missing now
 */
function diffFeed(prev, next) {
  const before = prev instanceof Map ? prev : new Map((prev || []).map((i) => [i.id, i]))
  const now = new Set(next.map((i) => i.id))
  const items = next.filter((i) => !before.has(i.id) || stable(before.get(i.id)) !== stable(i))
  const gone = [...before.keys()].filter((id) => !now.has(id))
  return { items, gone }
}

/** `gone` ids in the events' bound (1-500 per event). */
function goneChunks(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += MAX_GONE) out.push(ids.slice(i, i + MAX_GONE))
  return out
}

module.exports = { DESCRIBE, FEATURES, MAX_ITEMS, MAX_GONE, ACTION_LABELS, scopeLine, threadItem, feedItems, diffFeed, goneChunks }
