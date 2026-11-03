'use strict'
// Mark read / mark unread (0.3.0, design "Read state"): the bound on the write calls and the
// optimistic view. No I/O here; the host passes the Gmail call (client.setUnread, the plugin's only
// write: the UNREAD label and nothing else).
//
// - The bound: at most WRITE_CONCURRENCY calls at once and WRITE_PER_MINUTE started in any 60 s
//   (threads.modify costs 10 of Gmail's quota units; an alert group of 100 threads is one minute's
//   worth). Past that a call waits for the window; past MAX_QUEUED waiting it is refused at once.
//   After `stop` (the host deactivates) nothing more starts: what waits is refused, so no call is
//   ever made on a disposed ctx.
// - The view: a pressed Mark read moves the row at once (an override per thread over the cached
//   lists), the call runs, and a failure takes the override back (the host says why). A thread whose
//   call succeeded keeps its override until a poll that started after it has read Gmail again.

const WRITE_CONCURRENCY = 4
const WRITE_PER_MINUTE = 120
const MAX_QUEUED = 300
const WINDOW_MS = 60000

class GateStopped extends Error {
  constructor() {
    super('the plugin is stopping: Gmail was not changed')
    this.name = 'GateStopped'
    this.kind = 'stopped'
  }
}

/**
 * A queue that runs `fn`s with at most `concurrency` at once and `perMinute` started in any minute.
 *
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep] waits (tests pass a fake clock's)
 */
function createGate(o = {}) {
  const now = o.now || Date.now
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const concurrency = o.concurrency || WRITE_CONCURRENCY
  const perMinute = o.perMinute || WRITE_PER_MINUTE
  const maxQueued = o.maxQueued || MAX_QUEUED
  const queue = []
  const starts = [] // start times inside the last minute
  let running = 0
  let pumping = false
  let stopped = false

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && running < concurrency && !stopped) {
        while (starts.length && now() - starts[0] >= WINDOW_MS) starts.shift()
        if (starts.length >= perMinute) {
          await sleep(Math.max(1, WINDOW_MS - (now() - starts[0])))
          continue
        }
        const job = queue.shift()
        starts.push(now())
        running++
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => {
            running--
            void pump()
          })
      }
    } finally {
      pumping = false
    }
    if (stopped) for (const job of queue.splice(0)) job.reject(new GateStopped())
  }

  /** Run `fn` when the bound allows; rejects when stopped or too much is waiting. */
  function run(fn) {
    if (stopped) return Promise.reject(new GateStopped())
    if (queue.length >= maxQueued) return Promise.reject(new Error('too many Gmail changes waiting: try again in a minute'))
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      void pump()
    })
  }

  function stop() {
    stopped = true
    for (const job of queue.splice(0)) job.reject(new GateStopped())
  }

  return { run, stop, stats: () => ({ running, queued: queue.length, inWindow: starts.length }) }
}

/**
 * The cache as the panel should show it while marks are pending or not yet polled: `overrides` is
 * thread id -> unread (boolean). A thread marked read leaves Unread and Alerts and shows in Read (an
 * alert sender's thread does not: Read leaves alerts out, as the poll does); one marked unread leaves
 * Read for Unread. Its messages take the new state (threads.modify changes every message of the
 * thread). The cache itself is not changed.
 */
function overlayCache(cache, overrides) {
  if (!cache || !cache.lists || !overrides || !overrides.size) return cache
  const threads = { ...cache.threads }
  const lists = { unread: [...(cache.lists.unread || [])], alerts: [...(cache.lists.alerts || [])], read: [...(cache.lists.read || [])] }
  const drop = (list, id) => {
    const i = list.indexOf(id)
    if (i >= 0) list.splice(i, 1)
    return i >= 0
  }
  for (const [id, unread] of overrides) {
    const t = threads[id]
    if (!t) continue
    threads[id] = {
      ...t,
      messages: (t.messages || []).map((m) => ({ ...m, unread, labels: unread ? [...new Set([...(m.labels || []), 'UNREAD'])] : (m.labels || []).filter((l) => l !== 'UNREAD') })),
    }
    if (unread) {
      if (drop(lists.read, id) && !lists.unread.includes(id)) lists.unread.unshift(id)
    } else {
      const wasAlert = drop(lists.alerts, id)
      if (drop(lists.unread, id) && !wasAlert && !lists.read.includes(id)) lists.read.unshift(id)
    }
  }
  return { ...cache, threads, lists }
}

module.exports = { createGate, overlayCache, GateStopped, WRITE_CONCURRENCY, WRITE_PER_MINUTE, MAX_QUEUED }
