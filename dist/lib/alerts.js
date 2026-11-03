'use strict'
// Grafana alerts (design "Alerts", ported from the old cockpit's lib/convs.py `alert` and
// `group_alerts`). An alert message is one from an alert sender whose subject starts `[FIRING…]` or
// `[RESOLVED…]`. Its name comes from the body (`alertname=X grafana_folder=`, or Grafana's newer
// `📁 folder › X 🔥` line), else the subject without its trailing `(labels)`; its node from
// `nodename=`, else those labels. The body here is Gmail's snippet: the lanes read metadata only,
// and Grafana's mail puts those labels in its first lines, which the snippet holds.
//
// One row per alert name with all its unread threads (an alert that fires every five minutes is
// one row, not fifty), a count badge and its nodes. Unlike the old connector, a name whose newest
// message is RESOLVED is kept and shown as resolved (design): it is still unread mail. A thread from
// an alert sender whose unread messages are not all Grafana-shaped is a plain row in the lane.

const { oneLine, cut, MAX_ALERT_NAME, ALERT } = require('./util')

const MAX_NODES = 10
const SUBJECT = /^\[(FIRING|RESOLVED)\b[^\]]*\]\s*(.*)$/i

/**
 * `{ name, node, resolved }` of an alert message, null for any other message.
 * @param {{ address: string, subject: string, snippet: string }} msg a cached message (model.compactMessage)
 * @param {string[]} senders the alert senders (lower case)
 */
function parseAlert(msg, senders) {
  if (!msg || !senders.includes(msg.address)) return null
  const st = SUBJECT.exec(String(msg.subject || '').trim())
  if (!st) return null
  // The snippet is plain text already; a body read in full may hold tags, which never name an alert.
  const text = String(msg.snippet || '').replace(/<[^>]{0,500}>/g, '')
  const fromBody = /alertname=(.{1,300}?) grafana_folder=/.exec(text) || /📁 [^›]{0,300}› (.{1,300}?) [🔥✅]/u.exec(text)
  const rest = st[2]
  const labels = /\(([^()]*)\)\s*$/.exec(rest)
  const name = cut(oneLine(fromBody ? fromBody[1] : rest.replace(/\s*\([^()]*\)\s*$/, '')), MAX_ALERT_NAME)
  if (!name) return null
  const node = /nodename=(\S{1,200})/.exec(text)
  return { name, node: node ? node[1] : labels ? oneLine(labels[1]) : '', resolved: st[1].toUpperCase() === 'RESOLVED' }
}

/**
 * The Alerts lane from the alert search's threads: alert groups and plain rows.
 *
 * @param {object[]} threads cached threads (model.compactThread), any order
 * @param {string[]} senders
 * @returns {{ groups: object[], plain: object[] }} `groups`: `{ id: 'alert:<name>', name, nodes,
 *   count, firing, resolved, at, threadIds (newest first), latest }`; `plain`: the threads left as rows
 */
function groupAlerts(threads, senders) {
  const by = new Map()
  const plain = []
  for (const t of threads) {
    const unread = (t.messages || []).filter((m) => m.unread && senders.includes(m.address))
    const parsed = unread.map((m) => ({ m, a: parseAlert(m, senders) }))
    if (!parsed.length || parsed.some((x) => !x.a)) {
      if ((t.messages || []).length) plain.push(t)
      continue
    }
    for (const { m, a } of parsed) {
      if (!by.has(a.name)) by.set(a.name, { name: a.name, msgs: [] })
      by.get(a.name).msgs.push({ msg: m, node: a.node, resolved: a.resolved, threadId: t.id })
    }
  }
  const groups = []
  for (const g of by.values()) {
    const msgs = g.msgs.sort((x, y) => x.msg.at - y.msg.at)
    const newest = msgs[msgs.length - 1]
    // A node is live while its newest message fires; a resolved group lists all its nodes.
    const lastOf = new Map()
    for (const x of msgs) if (x.node) lastOf.set(x.node, x)
    const live = [...lastOf.values()].filter((x) => !x.resolved).map((x) => x.node)
    const nodes = (newest.resolved || !live.length ? [...lastOf.keys()] : live).sort().slice(0, MAX_NODES)
    const threadAt = new Map()
    for (const x of msgs) threadAt.set(x.threadId, Math.max(threadAt.get(x.threadId) || 0, x.msg.at))
    groups.push({
      id: ALERT + g.name,
      name: g.name,
      nodes,
      count: msgs.length,
      firing: msgs.filter((x) => !x.resolved).length,
      resolved: newest.resolved,
      at: newest.msg.at,
      threadIds: [...threadAt.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
      latest: newest.msg,
    })
  }
  return { groups, plain }
}

/** The row title of a group: `HighCPU: node1, node2`. */
function groupTitle(g) {
  return g.nodes.length ? `${g.name}: ${g.nodes.join(', ')}` : g.name
}

module.exports = { parseAlert, groupAlerts, groupTitle, MAX_NODES }
