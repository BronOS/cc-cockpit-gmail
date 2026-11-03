'use strict'
// The panel's title bar (`ctx.panels.header`, design "Panel"): the last poll and the account address
// as the header's text, and Refresh as an icon that spins while a poll runs. Pure, so node:test
// checks it; the host sends it on every state change and once a minute (the age goes stale).
// (From bronos.jira's header.js.)

/** "just now", "5 min ago". */
function ago(ms, now) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const META_MAX = 120 // the app refuses a longer header text

/**
 * The header for a state: `{ meta, actions }`. Not signed in: no text, Refresh disabled (there is
 * nothing to poll). A poll running: "polling…" first and the icon busy (clicks ignored by the app).
 */
function headerSpec({ ready, polling, lastPoll, account }, now) {
  let meta = ready ? `${polling ? 'polling… · ' : ''}${ago(lastPoll, now)}${account ? ` · ${account}` : ''}` : ''
  if (meta.length > META_MAX) meta = meta.slice(0, META_MAX - 1) + '…'
  return {
    meta,
    actions: [{ id: 'refresh', icon: 'refresh', title: 'Poll Gmail now', busy: Boolean(ready && polling), disabled: !ready }],
  }
}

module.exports = { headerSpec, ago, META_MAX }
