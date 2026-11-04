'use strict'
// `ccc gmail ...`: parsing and the printed text. The handler gets plain data from the host
// (`deps`), so the suites drive it without an app. No subcommand reads stdin (the manifest does not
// declare it: with `stdin: true` every subcommand would wait for an open pipe), so the client file
// is read from a path. Nothing printed here ever holds a token or the client secret.

const fs = require('node:fs')
const path = require('node:path')
const { ago, stamp, oneLine, cut, rowId } = require('./util')
const { LANES, LANE_IDS } = require('./lanes')
const { MAX_FILE } = require('./oauth-client')
const { groupTitle } = require('./alerts')

const HELP = `ccc gmail: your Gmail (bronos.gmail)

  ccc gmail status            client, account, last poll, counts per lane, errors
  ccc gmail refresh           poll Gmail now and print the counts
  ccc gmail list [lane]       the threads of every lane, or of one: ${LANE_IDS.join(', ')}
  ccc gmail show <id>         a thread as readable text (an id from list; alert:<name> for an alert group)
  ccc gmail read <id>         mark a thread read in Gmail (alert:<name>: all of the alert's unread threads)
  ccc gmail unread <id>       mark a thread unread in Gmail
  ccc gmail login             start the Google sign-in (your browser does the rest)
  ccc gmail logout            sign out: the stored sign-in is deleted
  ccc gmail client <file>     use the OAuth client file you downloaded from Google Cloud (Desktop app)
  ccc gmail help              this text

The plugin changes only whether a thread is read (Gmail's UNREAD label): it never archives,
labels, trashes or sends. Opening a thread in the panel leaves it unread unless markReadOnOpen is on.
Settings: ccc plugin config bronos.gmail (the client secret only in Settings > This project).
`

/**
 * @param {string[]} argv
 * @param {object} deps from the host: status(), refresh(signal), view(), show(id, signal),
 *   mark(id, unread, signal), login(), logout(), client(text)
 * @param {{ cwd?: string, signal?: AbortSignal }} [call]
 */
async function runCli(argv, deps, call = {}) {
  const [cmd, ...rest] = argv
  const ok = (stdout) => ({ stdout: stdout.endsWith('\n') ? stdout : stdout + '\n', code: 0 })
  const fail = (stderr, code = 1) => ({ stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code })
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || (rest[0] === '--help' && cmd)) return ok(HELP)
  try {
    switch (cmd) {
      case 'status':
        return ok(statusText(deps.status()))
      case 'refresh': {
        const st = deps.status()
        if (!st.signedIn) return fail(notReady(st))
        const r = await deps.refresh(call.signal)
        if (r && r.error) return fail(`refresh failed: ${r.error}`)
        if (r && r.pending) return ok('still polling; ccc gmail status shows when it is done')
        return ok(countsLine(deps.status()))
      }
      case 'list': {
        const lane = rest[0]
        if (lane && !LANE_IDS.includes(lane)) return fail(`unknown lane "${cut(lane, 40)}": one of ${LANE_IDS.join(', ')}`, 2)
        const st = deps.status()
        if (!st.signedIn) return fail(notReady(st))
        if (!st.lastPoll) return fail('no poll yet: run ccc gmail refresh')
        return ok(listText(deps.view(), lane))
      }
      case 'show': {
        if (!rest.length) return fail('usage: ccc gmail show <threadId> (or alert:<name>)', 2)
        const raw = rest.join(' ')
        if (!rowId(raw)) return fail(`not a thread id: "${cut(raw, 60)}" (ccc gmail list shows them)`, 2)
        const st = deps.status()
        if (!st.signedIn) return fail(notReady(st))
        return ok(await deps.show(raw, call.signal))
      }
      case 'read':
      case 'unread': {
        if (!rest.length) return fail(`usage: ccc gmail ${cmd} <threadId>`, 2)
        const raw = rest.join(' ')
        const which = rowId(raw)
        if (!which) return fail(`not a thread id: "${cut(raw, 60)}" (ccc gmail list shows them)`, 2)
        if (which.alert && cmd === 'unread') return fail('an alert group cannot be marked unread: use one of its thread ids', 2)
        const st = deps.status()
        if (!st.signedIn) return fail(notReady(st))
        const r = await deps.mark(raw, cmd === 'unread', call.signal)
        if (r && r.pending) return ok('still waiting for Gmail; ccc gmail list shows the result')
        if (!r || r.error) return fail(r ? r.error : 'no answer')
        return ok(r.message)
      }
      case 'login': {
        const r = await deps.login()
        if (r && r.error) return fail(r.error)
        return ok(r && r.message ? r.message : 'Your browser opens the Google sign-in: finish it there. ccc gmail status shows the result.')
      }
      case 'logout': {
        const r = await deps.logout()
        return ok(r && r.message ? r.message : 'Signed out.')
      }
      case 'client': {
        if (!rest[0]) return fail('usage: ccc gmail client <path to the client JSON file>', 2)
        const file = path.resolve(call.cwd || process.cwd(), rest.join(' '))
        let text
        try {
          const st = await fs.promises.stat(file)
          if (!st.isFile()) return fail(`${file} is not a file`)
          if (st.size > MAX_FILE) return fail(`${file} is too big to be a Google client file`)
          text = await fs.promises.readFile(file, 'utf8')
        } catch (e) {
          return fail(`cannot read ${file}: ${e.code || e.message}`)
        }
        const r = await deps.client(text)
        if (!r.ok) return fail(r.error)
        return ok(r.message)
      }
      default:
        return fail(`unknown command "${cut(cmd, 40)}"\n\n${HELP}`, 2)
    }
  } catch (e) {
    return fail(e && e.message ? e.message : String(e))
  }
}

function notReady(st) {
  if (st.tooOld) return st.tooOld
  if (!st.client) return 'No OAuth client yet: ccc gmail client <file.json>, or set clientId and clientSecret (Settings > This project > Gmail). ccc gmail status says more.'
  if (st.signedOutReason) return st.signedOutReason
  return 'Not signed in to Google: ccc gmail login (or Sign in with Google in the Gmail panel).'
}

function countsLine(st) {
  if (!st.counts) return 'no poll yet'
  return st.counts.map((c) => `${c.title} ${c.total}${c.unread && c.id !== 'unread' ? ` (${c.unread} unread)` : ''}`).join(' · ') || 'no lane is on'
}

/** `ccc gmail status`. */
function statusText(st, now = Date.now()) {
  const lines = []
  if (st.tooOld) return `${st.tooOld}\n`
  const c = st.client
  lines.push(`client    ${c ? `${c.id} (${c.source === 'pasted' ? 'pasted client file' : 'settings'})` : '(none)'}`)
  if (st.pastedBroken) lines.push(`problem   ${st.pastedBroken}`)
  for (const m of st.settingsMissing || []) lines.push(`problem   ${m} is not set (Settings > This project > Gmail)`)
  lines.push(`sign-in   ${st.signedIn ? `signed in${st.sessionOnly ? ' for this session only (the keychain did not take the sign-in)' : ''}` : st.signingIn ? 'waiting for the browser' : 'not signed in'}`)
  if (!st.signedIn) {
    if (st.signedOutReason) lines.push('', st.signedOutReason)
    else if (!c) lines.push('', 'Set up an OAuth client first (the Gmail panel shows the steps; README "Set up Google Cloud"), then: ccc gmail client <file.json> and ccc gmail login.')
    else lines.push('', 'Next: ccc gmail login (or Sign in with Google in the Gmail panel).')
    for (const p of st.problems || []) lines.push(`problem   ${p}`)
    return lines.join('\n') + '\n'
  }
  lines.push(`account   ${st.account || '(not known yet)'}`)
  lines.push(`last poll ${st.lastPoll ? `${stamp(st.lastPoll)} (${ago(st.lastPoll, now)})` : 'none yet'}${st.polling ? ', polling now' : ''}; every ${st.pollMinutes} min while this project is open${st.backoffMinutes ? ` (now every ${st.backoffMinutes} min: Gmail was busy)` : ''}`)
  lines.push(`lanes     ${countsLine(st)}`)
  lines.push(`triage    ${st.triage}`)
  lines.push(`view      ${st.annotate}`)
  if (st.write) lines.push(`write     ${st.write}`)
  if (st.jira) lines.push(`jira      ${st.jira}`)
  for (const p of st.problems || []) lines.push(`problem   ${p}`)
  if (st.error) lines.push(`error     ${st.error}`)
  for (const [lane, msg] of Object.entries(st.laneErrors || {})) lines.push(`error     ${lane}: ${msg}`)
  for (const e of (st.threadErrors || []).slice(0, 5)) lines.push(`error     ${e.id}: ${e.message}`)
  return lines.join('\n') + '\n'
}

const DOT = { urgent: 'U', action: 'A', fyi: 'f', noise: '.' }

/** `ccc gmail list [lane]`: one line per row, `*` for unread, the triage letter, the id to show. */
function listText(view, lane) {
  const out = []
  for (const l of view.lanes) {
    if (lane && l.id !== lane) continue
    out.push(`${l.title} (${l.rows.length})`)
    for (const r of l.rows) {
      const t = r.verdict ? DOT[r.verdict.priority] || '?' : ' '
      if (r.kind === 'alert') {
        const g = r.group
        out.push(`  * ${t} ${cut(r.id, 40).padEnd(18)} ${cut(oneLine(groupTitle(g)), 70)}  [${g.resolved ? 'resolved' : `${g.firing} firing`}, ${g.count} mail${g.count === 1 ? '' : 's'}]`)
        continue
      }
      const f = r.facts
      out.push(`  ${r.unread ? '*' : ' '} ${t} ${r.id.padEnd(18)} ${cut(oneLine(f.lead.from || f.lead.address), 24).padEnd(24)} ${cut(oneLine(f.subject), 60)}${f.count > 1 ? ` (${f.count})` : ''}`)
    }
  }
  if (lane && !view.lanes.some((l) => l.id === lane)) {
    const title = (LANES.find((l) => l.id === lane) || {}).title || lane
    return `${title}: this lane is off (the lanes setting${lane === 'alerts' ? ', or no alertSenders' : ''})\n`
  }
  out.push('', '* unread   triage: U urgent, A action, f fyi, . noise')
  return out.join('\n') + '\n'
}

module.exports = { runCli, statusText, listText, HELP }
