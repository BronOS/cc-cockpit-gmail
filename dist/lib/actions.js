'use strict'
// Small decisions behind the row actions, kept pure for the suites: which Claude tab Discuss
// goes to and whether the reviewer lacks `annotate`. (From bronos.jira, minus its xdg-open opener:
// this plugin needs cc-cockpit 0.9.1, so `ctx.openExternal` is always there.)

/**
 * The tab for Discuss (as bronos.jira): the one the person is looking at
 * (`SessionInfo.active`, cc-cockpit 0.8.0), else the only live Claude tab, else the person picks
 * (`choose`), else none is open (`error`). A tab the panel already picked is used when it is still
 * one of this window's live tabs (main checks the id again on send).
 *
 * @param {Array<{ tabId: string, status: string, title?: string, cwd?: string, active?: boolean }>} sessions
 * @param {string} [requested]
 * @returns {{ tabId: string, label: string } | { choose: { tabId: string, label: string, status: string }[] } | { error: string }}
 */
function pickTab(sessions, requested) {
  const live = (sessions || []).filter((s) => s && s.status !== 'ended')
  if (requested) {
    const s = live.find((x) => x.tabId === requested)
    return s ? { tabId: s.tabId, label: tabLabel(s) } : { error: 'That Claude tab is gone; pick another or use New session.' }
  }
  const active = live.find((s) => s.active === true)
  if (active) return { tabId: active.tabId, label: tabLabel(active) }
  if (live.length === 1) return { tabId: live[0].tabId, label: tabLabel(live[0]) }
  if (!live.length) return { error: 'No Claude tab is open in this window: use New session.' }
  return { choose: live.map((s) => ({ tabId: s.tabId, label: tabLabel(s), status: s.status })) }
}

/** The tab's topic as the Sessions panel names it, else its folder, else its id. */
function tabLabel(s) {
  if (s.title) return s.title
  if (s.cwd) return s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd
  return s.tabId
}

/**
 * Whether a reviewer call failed because the installed reviewer has no `annotate` (cc-cockpit
 * before 0.8.0). The app's message is `service "reviewer" (plugin P) has no method "annotate"`
 * (`ccc guide api`); anything else is a real failure of annotate.
 */
function isMissingAnnotate(err) {
  const m = err && err.message ? err.message : String(err || '')
  return /has no method "annotate"/.test(m)
}

module.exports = { pickTab, tabLabel, isMissingAnnotate }
