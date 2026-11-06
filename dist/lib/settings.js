'use strict'
// Settings validation (project scope; design "Auth" and "Fetching"). The manifest schema cannot say
// everything (no regexes in schemas: the app refuses them, ReDoS in main), so the host checks here
// what the form cannot: a client id that is a Google one, alert senders that are addresses. A bad
// optional value (one alert sender) is a problem shown in the panel and `ccc gmail status` and
// skipped; it never stops the plugin.

const { emailAddress } = require('./util')
const { checkClientId } = require('./oauth-client')
const { parseProxy } = require('./remote')

const LANE_IDS = ['unread', 'alerts', 'read']
const LANE_DEFAULTS = { unread: true, alerts: true, read: true }

/**
 * @param {Record<string, unknown>} p ctx.settings.project
 * @returns {{ cfg: object, problems: string[] }}
 */
function readSettings(p) {
  const s = p || {}
  const problems = []
  const rawId = typeof s.clientId === 'string' ? s.clientId.trim() : ''
  let clientId = ''
  if (rawId) {
    const c = checkClientId(rawId)
    if (c.ok) clientId = rawId
    else problems.push(`clientId: ${c.error}`)
  }
  // A secret field is absent when unset (never '' or null; `ccc guide settings-secrets`).
  const clientSecret = typeof s.clientSecret === 'string' && s.clientSecret ? s.clientSecret : ''

  // Nested defaults: a project that never saved `lanes` may arrive without some keys, so each lane
  // falls back on its own default rather than trusting the object to be whole (as bronos.jira).
  const lanesIn = s.lanes && typeof s.lanes === 'object' ? s.lanes : {}
  const lanes = {}
  for (const id of LANE_IDS) lanes[id] = typeof lanesIn[id] === 'boolean' ? lanesIn[id] : LANE_DEFAULTS[id]

  const alertSenders = []
  for (const a of Array.isArray(s.alertSenders) ? s.alertSenders : []) {
    if (typeof a === 'string' && !a.trim()) continue
    const addr = emailAddress(a)
    if (addr) {
      if (!alertSenders.includes(addr)) alertSenders.push(addr)
    } else problems.push(`alertSenders: "${String(a).slice(0, 60)}" is not an email address, skipped`)
  }
  const int = (v, d, lo, hi) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  const cfg = {
    clientId,
    clientSecret,
    lanes,
    alertSenders,
    rowsPerLane: int(s.rowsPerLane, 10, 1, 300),
    unreadDays: int(s.unreadDays, 14, 1, 365),
    maxUnread: int(s.maxUnread, 15, 1, 100),
    readDays: int(s.readDays, 2, 1, 90),
    maxRead: int(s.maxRead, 10, 1, 100),
    pollMinutes: int(s.pollMinutes, 2, 1, 1440),
    triageText: s.triageText === 'summary' ? 'summary' : 'full',
    // 0.3.0: opening a thread from the panel marks it read in Gmail, as Gmail does; off keeps it unread.
    markReadOnOpen: typeof s.markReadOnOpen === 'boolean' ? s.markReadOnOpen : false,
    // The inbox-feed sends an alert group as one item (the panel's row); off, one per thread.
    alertGroupsInInbox: typeof s.alertGroupsInInbox === 'boolean' ? s.alertGroupsInInbox : true,
  }
  return { cfg, problems }
}

/**
 * The app-wide settings (0.6.0, Settings > Plugins > Gmail; the always-show senders are the html
 * settings page's, kept in ctx.appStorage): Remote images 'ask' (default) or 'always', and the image
 * proxy template (parsed: null when empty). A bad proxy is a problem and loads no picture at all: a
 * person who set a proxy did not want the pictures fetched directly instead.
 *
 * @param {Record<string, unknown>} a ctx.settings.app
 * @returns {{ remoteImages: 'ask' | 'always', proxy: { template: string, hostKey: string } | null, problems: string[] }}
 */
function readAppSettings(a) {
  const s = a || {}
  const problems = []
  const parsed = parseProxy(typeof s.imageProxy === 'string' ? s.imageProxy : '')
  let proxy = null
  if (parsed && parsed.error) problems.push(`imageProxy: ${parsed.error}; remote pictures are not loaded until it is fixed`)
  else proxy = parsed
  // The reviewer's view a mail opens in when its sender has no choice of the person's yet (views.js).
  const defaultView = s.defaultView === 'reader' ? 'reader' : 'original'
  return { remoteImages: s.remoteImages === 'always' ? 'always' : 'ask', proxy, proxyBroken: Boolean(parsed && parsed.error), problems, defaultView }
}

/** Whether the Alerts lane exists: switched on and at least one alert sender. */
function alertsOn(cfg) {
  return Boolean(cfg.lanes.alerts && cfg.alertSenders.length)
}

module.exports = { readSettings, readAppSettings, alertsOn, LANE_IDS, LANE_DEFAULTS }
