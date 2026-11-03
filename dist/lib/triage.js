'use strict'
// What jev-triage gets for one row (its `triage` v1 service, source `gmail`; design "Triage"): the
// item text, the hint, and short fields rules can match.
//
// - item: `{ id: threadId | "alert:<name>", text, hint?, floor?, fields: { from, to, lane, list } }`.
// - text, `triageText: full` (the old connector's conv_text): who it is from and to (and whether the
//   person is in To, in Cc or neither: a list, a group address), the subject, up to three earlier
//   messages of the thread as context (sender + snippet), then the newest message marked as new.
//   `summary`: from and subject only (for an employer that objects to mail text leaving).
// - hints: every Grafana alert group is noise (the old connector's rule). A plain mail from an alert
//   sender has no hint: Jev judges it. Mail from Jira (0.2.0, with the bronos.jira plugin's `jira`
//   service): the host passes what lib/jira.js decided (an issue moved = hint noise, about a Done issue
//   = hint fyi, a mention on or creation of my open issue = floor action) and the issue key, which
//   goes into `fields.jira` so jev-triage rules can match it. Without Jira the item is as in 0.1.0.

const { cut, oneLine } = require('./util')
const { addressedTo } = require('./model')
const { groupTitle } = require('./alerts')

const CUTS = { context: 3, contextSnippet: 300, newSnippet: 1500, field: 200 }

const TO_TEXT = {
  to: 'the person (in To)',
  cc: 'the person (in Cc)',
  other: 'not the person by name (a list, a group address or someone else)',
  unknown: 'unknown',
}

function who(m) {
  return m.address && m.from && m.from !== m.address ? `${m.from} <${m.address}>` : m.address || m.from || 'unknown'
}

/** The text Jev reads about a thread row. */
function threadText(row, mode, me) {
  const { facts, thread } = row
  const lead = facts.lead
  const head = `Email from ${who(lead)}, subject: ${oneLine(facts.subject)}`
  if (mode === 'summary') return head
  const msgs = thread.messages
  const at = msgs.indexOf(lead)
  const context = msgs.slice(Math.max(0, at - CUTS.context), at)
  const lines = [head, `Addressed to: ${TO_TEXT[addressedTo([lead], me)]}`]
  if (lead.to) lines.push(`To: ${cut(lead.to, 300)}`)
  if (lead.cc) lines.push(`Cc: ${cut(lead.cc, 300)}`)
  if (lead.listId) lines.push(`Mailing list: ${lead.listId}`)
  if (facts.count > 1) lines.push(`The thread has ${facts.count} messages${facts.participants.length ? `, from ${facts.participants.slice(0, 8).join(', ')}` : ''}.`)
  if (context.length) {
    lines.push('', 'Earlier in the thread (context only, do not judge these):')
    for (const m of context) lines.push(`  ${who(m)}: ${cut(m.snippet, CUTS.contextSnippet)}`)
  }
  lines.push('', `${row.unread ? 'New message' : 'Latest message (already read)'} to judge:`, `  ${who(lead)}: ${cut(lead.snippet, CUTS.newSnippet) || '(no text)'}`)
  return lines.join('\n')
}

/** The text Jev reads about an alert group (it is hinted noise; Jev only sees it if a rule says so). */
function alertText(g, mode) {
  const head = `Email, Grafana alert '${g.name}' from ${who(g.latest)}`
  if (mode === 'summary') return head
  return [head, `${g.count} unread alert mail${g.count === 1 ? '' : 's'}, ${g.resolved ? 'resolved now' : `${g.firing} firing`}${g.nodes.length ? `, nodes: ${g.nodes.join(', ')}` : ''}.`, `Addressed to: the ops alert channel, nobody in particular.`, '', `Latest: ${cut(g.latest.subject, 300)}`].join('\n')
}

/**
 * One triage item for a view row.
 * @param {object} row poll.buildView's row
 * @param {'full'|'summary'} mode
 * @param {string} me the person's address
 * @param {{ key?: string|null, hint?: { priority: string }, floor?: string }|null} [jira] a Jira mail's
 *   key and hint (lib/jira.js), null for any other mail
 */
function triageItem(row, mode, me, jira) {
  if (row.kind === 'alert') {
    const g = row.group
    return {
      id: row.id,
      text: alertText(g, mode),
      hint: { priority: 'noise' },
      fields: { from: g.latest.address || '', to: cut(g.latest.to, CUTS.field), lane: row.lane, list: cut(g.latest.listId, CUTS.field), alert: cut(groupTitle(g), CUTS.field) },
    }
  }
  const lead = row.facts.lead
  const item = {
    id: row.id,
    text: threadText(row, mode, me),
    fields: { from: lead.address || '', to: cut(lead.to, CUTS.field), lane: row.lane, list: cut(lead.listId, CUTS.field) },
  }
  if (jira) {
    if (jira.key) item.fields.jira = jira.key
    if (jira.hint) item.hint = { priority: jira.hint.priority }
    else if (jira.floor) item.floor = jira.floor
  }
  return item
}

module.exports = { triageItem, threadText, alertText, TO_TEXT }
