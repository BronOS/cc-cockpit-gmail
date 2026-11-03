'use strict'
// The Gmail searches behind the lanes (design "Fetching"), as the old connector had them:
// - Unread: `is:unread -in:spam -in:trash newer_than:<unreadDays>d` minus the alert senders, the
//   newest `maxUnread` threads.
// - Alerts: the same search restricted to the alert senders, up to 100 threads, listed apart so an
//   alert storm never pushes real mail out of Unread.
// - Read: `-is:unread in:inbox newer_than:<readDays>d`, twice `maxRead` asked for, since the alerts
//   among them are left out afterwards.
// The senders passed util.emailAddress, so none of them holds a space, a quote, a brace or a
// parenthesis that Gmail's search would read as syntax.

const ALERT_CAP = 100
// Gmail's copies of Google Chat messages: left out (a future chat plugin has them).
const CHAT_COPY = 'chat-noreply@google.com'

function base(days) {
  return `is:unread -in:spam -in:trash newer_than:${days}d`
}

/** `from:a` or `{from:a from:b}` (Gmail's OR group). */
function fromAny(senders) {
  if (senders.length === 1) return `from:${senders[0]}`
  return `{${senders.map((s) => `from:${s}`).join(' ')}}`
}

/**
 * The searches for the lanes that are on: `{ unread?, alerts?, read? }`, each `{ q, cap }`.
 * @param {object} cfg settings.readSettings(...).cfg
 */
function queries(cfg) {
  const out = {}
  const senders = cfg.alertSenders || []
  const alerts = Boolean(cfg.lanes.alerts && senders.length)
  if (cfg.lanes.unread) out.unread = { q: base(cfg.unreadDays) + senders.map((s) => ` -from:${s}`).join(''), cap: cfg.maxUnread }
  if (alerts) out.alerts = { q: `${base(cfg.unreadDays)} ${fromAny(senders)}`, cap: ALERT_CAP }
  if (cfg.lanes.read) out.read = { q: `-is:unread in:inbox newer_than:${cfg.readDays}d`, cap: Math.min(200, 2 * cfg.maxRead) }
  return out
}

/** The Gmail search link of an alert group (`#search/...`): its sender and the alert name. */
function alertSearch(senders, name) {
  const who = senders.length ? `${fromAny(senders)} ` : ''
  return `${who}subject:"${String(name).replace(/["\\]/g, ' ')}"`
}

module.exports = { queries, fromAny, alertSearch, ALERT_CAP, CHAT_COPY }
