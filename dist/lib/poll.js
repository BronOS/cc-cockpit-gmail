'use strict'
// One poll (design "Fetching" and "Polling"), and the view the panel, the CLI and triage share.
//
// - The cheap path first: `users.history.list startHistoryId=<last>`. No change since the last
//   poll means no list call at all. A change, every 10th poll (the `newer_than:` windows move with
//   time even when the mailbox does not), a first poll, or a 404 from history (the id is too old,
//   about a week) means the full path.
// - The full path: the lane searches (query.js), then `threads.get format=metadata` for every
//   listed thread whose historyId differs from the cached copy, 4 at a time.
// - A failed Alerts or Read search keeps that lane's last list (bronos.jira's rule: a side lane
//   failing never empties the board); a failed Unread search fails the poll. An expired sign-in
//   (auth) or Gmail being busy (rate, server) fails it too, so the host can back off.
// - The cache holds only the threads the lists name (at most 100 + 100 + 200).

const { queries, ALERT_CAP } = require('./query')
const { compactThread, threadFacts } = require('./model')
const { groupAlerts } = require('./alerts')
const { LANES, sortRows } = require('./lanes')
const { alertsOn } = require('./settings')
const { mapLimit } = require('./util')
const { isBusy } = require('./http')

const CONCURRENCY = 4
const FULL_EVERY = 10

/** A fresh cache for one account (a client change or a sign out starts one). */
function emptyCache(clientHash) {
  return { clientHash, account: null, historyId: null, lists: null, threads: {}, sinceFull: 0, lastPoll: 0 }
}

/** The stored cache when it belongs to this client, else a fresh one. */
function loadCache(stored, clientHash) {
  if (stored && stored.clientHash === clientHash && stored.threads && typeof stored.threads === 'object') {
    return { ...emptyCache(clientHash), ...stored, threads: stored.threads }
  }
  return emptyCache(clientHash)
}

/** Whether a thread's newest message is from an alert sender (the Read lane leaves those out). */
function isAlertThread(t, senders) {
  const msgs = t.messages || []
  return msgs.length > 0 && senders.includes(msgs[msgs.length - 1].address)
}

/**
 * @param {object} o
 * @param {ReturnType<import('./client').createClient>} o.client
 * @param {object} o.cfg settings.readSettings(...).cfg
 * @param {object} o.cache loadCache(...), updated in place
 * @param {boolean} [o.force] skip the history check (a click on Refresh, a settings change)
 * @param {number} [o.now]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ full: boolean, changed: boolean, stats: object, laneErrors: object, at: number }>}
 */
async function poll(o) {
  const { client, cfg, cache, signal } = o
  const now = o.now || Date.now()
  let baseline = null
  if (!cache.account) {
    const p = await client.profile(signal)
    cache.account = p.emailAddress
    baseline = p.historyId
  }

  let full = Boolean(o.force) || !cache.lists || !cache.historyId || cache.sinceFull + 1 >= FULL_EVERY
  let historyNote = ''
  if (!full) {
    try {
      const h = await client.history(cache.historyId, signal)
      if (!h.changed) {
        cache.historyId = h.historyId
        cache.sinceFull += 1
        cache.lastPoll = now
        return { full: false, changed: false, stats: { listed: 0, fetched: 0, threadErrors: [] }, laneErrors: {}, at: now }
      }
      baseline = h.historyId
    } catch (e) {
      if (!e || e.kind !== 'notfound') throw e
      historyNote = 'history too old'
    }
    full = true
  }
  // The baseline is taken before the lists, so a change during them shows at the next poll.
  if (!baseline) baseline = (await client.profile(signal)).historyId

  const q = queries(cfg)
  const prev = cache.lists || {}
  const laneErrors = {}
  const listing = {}
  // Unread is the lane that matters: its failure fails the poll. The side lanes keep their last list.
  const runs = await Promise.all(
    Object.entries(q).map(async ([lane, { q: query, cap }]) => {
      try {
        return [lane, await client.listThreads(query, cap, signal), null]
      } catch (e) {
        return [lane, null, e]
      }
    }),
  )
  for (const [lane, list, err] of runs) {
    if (!err) {
      listing[lane] = list
      continue
    }
    if (lane === 'unread' || err.kind === 'auth' || err.kind === 'scope' || isBusy(err)) throw err
    laneErrors[lane] = err.message
    listing[lane] = (prev[lane] || []).map((id) => ({ id, historyId: cache.threads[id] ? cache.threads[id].historyId : '' }))
  }

  // An alert never shows in Unread too, and a thread in Unread never in Read (Gmail's thread search
  // can match both `is:unread` and `-is:unread` for a thread with read and unread messages).
  const taken = new Set()
  const pick = (list) => (list || []).filter((t) => (taken.has(t.id) ? false : (taken.add(t.id), true)))
  const alerts = pick(listing.alerts).slice(0, ALERT_CAP)
  const unread = pick(listing.unread)
  const read = pick(listing.read)
  const all = [...alerts, ...unread, ...read]

  const stale = all.filter((t) => {
    const c = cache.threads[t.id]
    return !c || !t.historyId || c.historyId !== t.historyId
  })
  const results = await mapLimit(stale, CONCURRENCY, async (t) => compactThread(await client.thread(t.id, 'metadata', signal), t.historyId))
  const threadErrors = []
  let busy = null
  results.forEach((r, i) => {
    const id = stale[i].id
    if (r.ok) {
      cache.threads[id] = r.value
      return
    }
    // A dead sign-in shows on the first read already: the poll says so once instead of per thread.
    if (r.error && (r.error.kind === 'auth' || r.error.kind === 'scope')) throw r.error
    if (isBusy(r.error)) busy = r.error
    threadErrors.push({ id, message: r.error && r.error.message ? r.error.message : String(r.error) })
  })
  // A thread that could not be read and has no older copy is left out until a poll reads it.
  const have = (t) => Boolean(cache.threads[t.id])
  const senders = cfg.alertSenders || []
  const lists = {
    unread: unread.filter(have).map((t) => t.id),
    alerts: alerts.filter(have).map((t) => t.id),
    read: read.filter(have).filter((t) => !isAlertThread(cache.threads[t.id], senders)).slice(0, cfg.maxRead).map((t) => t.id),
  }
  const keep = new Set([...lists.unread, ...lists.alerts, ...lists.read])
  const threads = {}
  for (const id of keep) threads[id] = cache.threads[id]
  cache.threads = threads
  cache.lists = lists
  cache.historyId = baseline || cache.historyId
  cache.sinceFull = 0
  cache.lastPoll = now
  const out = { full: true, changed: true, stats: { listed: all.length, fetched: stale.length - threadErrors.length, threadErrors, note: historyNote }, laneErrors, at: now }
  if (busy) out.busy = busy
  return out
}

/**
 * The lanes as shown (only the enabled ones), each row `{ id, kind, lane, at, unread, verdict,
 * thread?, facts?, group? }`, sorted by triage priority then the newest message.
 * @param {{ cfg: object, cache: object, verdicts?: Record<string, object> }} o
 */
function buildView(o) {
  const { cfg, cache } = o
  const verdicts = o.verdicts || {}
  const lists = cache && cache.lists
  if (!lists) return { lanes: [], unread: 0 }
  const me = cache.account || ''
  const threadRow = (id, lane) => {
    const thread = cache.threads[id]
    const facts = thread && threadFacts(thread, me)
    if (!facts) return null
    return { id, kind: 'thread', lane, at: facts.at, unread: facts.unread, verdict: verdicts[id] || null, thread, facts }
  }
  const byLane = { unread: [], alerts: [], read: [] }
  if (cfg.lanes.unread) for (const id of lists.unread || []) byLane.unread.push(threadRow(id, 'unread'))
  if (alertsOn(cfg)) {
    const threads = (lists.alerts || []).map((id) => cache.threads[id]).filter(Boolean)
    const { groups, plain } = groupAlerts(threads, cfg.alertSenders)
    for (const g of groups) byLane.alerts.push({ id: g.id, kind: 'alert', lane: 'alerts', at: g.at, unread: true, verdict: verdicts[g.id] || null, group: g })
    for (const t of plain) byLane.alerts.push(threadRow(t.id, 'alerts'))
  }
  if (cfg.lanes.read) for (const id of lists.read || []) byLane.read.push(threadRow(id, 'read'))
  const shown = LANES.filter((l) => (l.id === 'alerts' ? alertsOn(cfg) : cfg.lanes[l.id]))
  const lanes = shown.map((l) => ({ id: l.id, title: l.title, rows: sortRows(byLane[l.id].filter(Boolean)) }))
  // The panel badge: unread threads of real mail. An alert storm should not shout from the icon.
  const unread = lanes.filter((l) => l.id === 'unread').reduce((n, l) => n + l.rows.filter((r) => r.unread).length, 0)
  return { lanes, unread }
}

/** Every row of a view, lane by lane. */
function allRows(view) {
  return view.lanes.flatMap((l) => l.rows)
}

module.exports = { poll, buildView, allRows, emptyCache, loadCache, isAlertThread, CONCURRENCY, FULL_EVERY }
