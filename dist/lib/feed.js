'use strict'
// The `inbox-feed` service (v2, 0.5.0) this plugin provides to Inbox: the pure parts. The host
// (dist/host.js) wires them to its view and its existing open and mark-read paths.
//
// - Built only from the cached view the panel shows (poll.buildView) and the cached threads, never
//   an API call: Inbox calls `snapshot()` whenever a provider joins and a service call has no rate
//   limit from the app.
// - The scope is the view itself: the threads of the Unread and Read lanes (so `unreadDays`, the read
//   lane's days and its cap already apply) and the alerts. An alert group (alerts.groupAlerts: the
//   unread Grafana threads of one alert name) is one item by default (setting `alertGroupsInInbox`),
//   as the panel shows it: an alert that fires every five minutes would otherwise be fifty items in
//   Inbox. Off, the group's threads are items of their own labelled `alert` and `alert:<name>` (the
//   0.5.0 feed). A plain alert-sender thread is always its own item. Triage verdicts stay in this
//   plugin's lanes: the feed carries facts, and Inbox's rules decide what matters.
// - `rev` is the id of the newest message, so a new reply changes it; marking read does not. A group's
//   is the id of its newest alert message, so a new firing changes it and brings back an item Inbox
//   marked Done.
// - `diffFeed` is how events are made: after each poll and each mark the host compares the list with
//   what it last told and emits `item` for any changed field and `gone` for a missing id.
// - Plain data only (the registry copies it with structuredClone); every string is cut to the
//   contract's caps here too, since Inbox treats a source as untrusted.

const { cut, oneLine, sha, ALERT } = require('./util')
const { addressedTo, threadFacts } = require('./model')
const { groupTitle } = require('./alerts')

const DESCRIBE = Object.freeze({ label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' })
const FEATURES = Object.freeze([])
const MAX_ITEMS = 1000
const MAX_GONE = 500
const CUTS = { title: 300, preview: 1000, name: 120, address: 254, label: 40, labels: 20, scope: 120, message: 300 }
const ACTION_LABELS = { open: 'Open', markRead: 'Mark read', markUnread: 'Mark unread' }
const PLACE = Object.freeze({ kind: 'folder', name: 'Inbox' })
const MAX_ID = 200 // the contract's id cap; an alert name may be 200 characters (util.MAX_ALERT_NAME) before `alert:`

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
  setLabels(item, labels)
  return item
}

/** Labels cut to 40, one line, no case-insensitive duplicates, at most 20 (the contract's caps). */
function setLabels(item, labels) {
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
}

/**
 * The feed id of an alert group: its row id `alert:<name>` when that fits the contract's 200, else
 * the name cut with a hash of the whole name after it (two long names sharing their first 177
 * characters stay two items). The host maps it back to the row (`groupOfItem`) for act and open.
 */
function groupItemId(name) {
  const id = ALERT + name
  if (id.length <= MAX_ID) return id
  let head = name.slice(0, MAX_ID - ALERT.length - 17)
  // A cut through a surrogate pair would leave half a character in the id.
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1)
  return `${ALERT}${head}~${sha(name, 16)}`
}

/**
 * One alert group (alerts.groupAlerts) as a FeedItem. A group exists only while one of its threads
 * has an unread alert message, so it is always unread and offers Mark read (all its threads, the
 * panel's row action) and never Mark unread (markRow refuses that for a group). Once every thread
 * is read the group is not in the view, so diffFeed makes it `gone`.
 * @param {object} g a group: `{ name, nodes, count, firing, resolved, at, threadIds, latest }`
 * @returns {object | null} null for a group with no message (not expected)
 */
function groupItem(g) {
  const latest = g && g.latest
  if (!latest || latest.id == null) return null
  const item = {
    id: groupItemId(g.name),
    // The newest alert message: a new firing (or a resolve) is new activity; a mark read is not.
    rev: cut(String(latest.id), 100),
    title: cut(oneLine(groupTitle(g)), CUTS.title) || '(no subject)',
    time: Math.max(1, Number(g.at) || 0),
    read: false,
    place: { ...PLACE },
    actions: [{ id: 'open', label: ACTION_LABELS.open }, { id: 'markRead', label: ACTION_LABELS.markRead }],
  }
  const preview = cut(oneLine(latest.snippet || ''), CUTS.preview)
  if (preview) item.preview = preview
  const from = {}
  if (latest.from) from.name = cut(latest.from, CUTS.name)
  if (latest.address) from.address = cut(latest.address, CUTS.address)
  if (from.name || from.address) item.from = from
  // The badge facts of the panel's row as labels a rule can test: `firing` or `resolved` (the newest
  // message's state), and the counts (unread alert messages, how many of them fire). A count change
  // alone is a label change: an `item` event, but no rev change, so a Done item stays done until
  // the next new message, which changes the rev anyway.
  const labels = ['alert', `alert:${g.name}`, g.resolved ? 'resolved' : 'firing', `count:${g.count}`, `firing:${g.firing}`]
  setLabels(item, labels)
  return item
}

/**
 * The whole scope as items, newest first (then the id, a stable order), at most `limit`
 * (default 1000, the contract's cap; `act` passes Infinity to check an id against everything).
 * @param {object[]} rows poll.allRows(view)
 * @param {{ me?: string, jiraKeys?: Map<string, string>, labelNames?: Record<string, string>, threads?: Record<string, object>, limit?: number, only?: string, groups?: boolean }} o
 *   `threads`: the (mark-overlaid) cached threads, to find the threads of an alert group;
 *   `groups`: an alert group is one item (groupItem), else one item per thread of it
 */
function feedItems(rows, o = {}) {
  const byId = new Map()
  // `only`: the one id wanted (an overlay's buttons, an act): every other thread is skipped before it is built.
  const add = (thread, extra) => {
    if (o.only !== undefined && (!thread || thread.id !== o.only)) return
    const it = thread && thread.id && !byId.has(thread.id) ? threadItem(thread, { ...o, ...extra }) : null
    if (it) byId.set(it.id, it)
  }
  for (const r of rows) {
    if (r.kind === 'alert' && o.groups) {
      const id = groupItemId(r.group.name)
      if (o.only !== undefined && id !== o.only) continue
      const it = byId.has(id) ? null : groupItem(r.group)
      if (it) byId.set(id, it)
    } else if (r.kind === 'alert') {
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

module.exports = { DESCRIBE, FEATURES, MAX_ITEMS, MAX_GONE, ACTION_LABELS, scopeLine, threadItem, groupItem, groupItemId, feedItems, diffFeed, goneChunks }
