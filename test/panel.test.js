'use strict'
// The panel's row logic, the title bar, the setup guide, the CLI text and the reader page's ready, with no host.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { rowKeyAction, rowClickOpens, rowButtons, moveIndex, ageText, alertBadge } = require('../panels/rowlogic')
const { headerSpec, META_MAX } = require('../dist/lib/header')
const { LINKS, STEPS, linkUrl } = require('../dist/lib/setup')
const { runCli, statusText, listText, HELP } = require('../dist/lib/cli')
const { tmpDir, NOW } = require('./fakes')

test('rowKeyAction: Enter and Space open, arrows / Home / End move, only on the row, no modifiers', () => {
  assert.equal(rowKeyAction('Enter', true), 'open')
  assert.equal(rowKeyAction(' ', true), 'open')
  assert.equal(rowKeyAction('ArrowDown', true), 'next')
  assert.equal(rowKeyAction('ArrowUp', true), 'prev')
  assert.equal(rowKeyAction('Home', true), 'first')
  assert.equal(rowKeyAction('End', true), 'last')
  assert.equal(rowKeyAction('Enter', false), null, 'Enter on a button is that button')
  assert.equal(rowKeyAction('Enter', true, { ctrl: true }), null)
  assert.equal(rowKeyAction('x', true), null)
})

test('rowClickOpens: not on a control, not while selecting', () => {
  assert.equal(rowClickOpens(false, false), true)
  assert.equal(rowClickOpens(true, false), false)
  assert.equal(rowClickOpens(false, true), false)
})

test('rowButtons: ↗, the verdict when triage is on, Discuss, New; no read/unread before sign-in', () => {
  const b = rowButtons({ kind: 'thread', verdict: { priority: 'action' } }, { triageOn: true })
  assert.deepEqual(b.map((x) => x.action), ['browser', 'wrong', 'discuss', 'newSession'])
  assert.equal(b[1].label, 'action ▾')
  assert.equal(rowButtons({ kind: 'thread', verdict: null }, { triageOn: true })[1].label, 'triage ▾')
  assert.deepEqual(rowButtons({ kind: 'alert' }, { triageOn: false }).map((x) => x.action), ['browser', 'discuss', 'newSession'])
  assert.match(rowButtons({ kind: 'alert' }, {})[0].title, /Search this alert/)
  assert.ok(!rowButtons({ kind: 'thread' }, { triageOn: true }).some((x) => /read/i.test(x.action)))
})

test('rowButtons (0.3.0): Mark read on an unread thread and an alert group, Mark unread on a read thread, after ↗', () => {
  const s = { triageOn: true, write: true }
  assert.deepEqual(rowButtons({ kind: 'thread', unread: true }, s).map((x) => x.action), ['browser', 'markRead', 'wrong', 'discuss', 'newSession'])
  assert.equal(rowButtons({ kind: 'thread', unread: true }, s)[1].label, 'Mark read')
  const read = rowButtons({ kind: 'thread', unread: false }, s)[1]
  assert.deepEqual([read.action, read.label], ['markUnread', 'Mark unread'])
  const g = rowButtons({ kind: 'alert', unread: true, count: 3 }, s)[1]
  assert.deepEqual([g.action, g.label], ['markRead', 'Mark read'])
  assert.match(g.title, /3 unread mails read in Gmail/)
  assert.ok(!rowButtons({ kind: 'alert', unread: true, count: 1 }, s).some((x) => x.action === 'markUnread'))
})

test('moveIndex', () => {
  assert.equal(moveIndex('next', 0, 3), 1)
  assert.equal(moveIndex('next', 2, 3), null)
  assert.equal(moveIndex('prev', 0, 3), null)
  assert.equal(moveIndex('prev', 2, 3), 1)
  assert.equal(moveIndex('first', 2, 3), 0)
  assert.equal(moveIndex('last', 0, 3), 2)
  assert.equal(moveIndex('next', 0, 0), null)
  assert.equal(moveIndex('open', 0, 3), null)
})

test('ageText and alertBadge', () => {
  assert.equal(ageText(0, NOW), '')
  assert.equal(ageText(NOW - 30000, NOW), 'now')
  assert.equal(ageText(NOW - 5 * 60000, NOW), '5m')
  assert.equal(ageText(NOW - 3 * 3600000, NOW), '3h')
  assert.equal(ageText(NOW - 2 * 86400000, NOW), '2d')
  assert.match(ageText(NOW - 10 * 86400000, NOW), /^[A-Z][a-z]{2} \d{1,2}$/)
  assert.equal(alertBadge({ kind: 'alert', resolved: true }), 'resolved')
  assert.equal(alertBadge({ kind: 'alert', resolved: false, firing: 2, count: 3 }), '2 firing')
  assert.equal(alertBadge({ kind: 'thread' }), '')
})

test('the page loads rowlogic.js before main.js and has no inline script', () => {
  const html = fs.readFileSync(path.join(__dirname, '../panels/main.html'), 'utf8')
  assert.ok(html.indexOf('src="rowlogic.js"') > 0 && html.indexOf('src="rowlogic.js"') < html.indexOf('src="main.js"'))
  assert.ok(!/<script>(?!<\/script>)/.test(html.replace(/<script src="[^"]+"( defer)?><\/script>/g, '')))
  const thread = fs.readFileSync(path.join(__dirname, '../panels/thread.html'), 'utf8')
  assert.ok(!/<script>[^<]/.test(thread))
})

test('the panel never puts text into the page as HTML; the reader page only the host-sanitized document', () => {
  const strip = (f) => fs.readFileSync(path.join(__dirname, '../panels', f), 'utf8').replace(/\/\/.*$/gm, '')
  const HTML_SINKS = /\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment/g
  assert.deepEqual(strip('main.js').match(HTML_SINKS), null)
  assert.deepEqual(strip('thread.js').match(HTML_SINKS), ['.innerHTML ='], 'one sink: the document parts the host built with sanitize.js')
})

test('headerSpec: the last poll and the account, refresh busy while polling, off before sign-in', () => {
  assert.deepEqual(headerSpec({ ready: false }, NOW), { meta: '', actions: [{ id: 'refresh', icon: 'refresh', title: 'Poll Gmail now', busy: false, disabled: true }] })
  const h = headerSpec({ ready: true, polling: true, lastPoll: NOW - 5 * 60000, account: 'me@example.com' }, NOW)
  assert.equal(h.meta, 'polling… · 5 min ago · me@example.com')
  assert.equal(h.actions[0].busy, true)
  assert.equal(headerSpec({ ready: true, lastPoll: 0 }, NOW).meta, 'never')
  assert.ok(headerSpec({ ready: true, lastPoll: NOW, account: `${'a'.repeat(200)}@x.org` }, NOW).meta.length <= META_MAX)
})

test('setup: the steps name both account kinds, every link id resolves, nothing else does', () => {
  const all = STEPS.map((s) => s.text).join('\n')
  assert.match(all, /personal Gmail account choose External, then Publish app/)
  assert.match(all, /7 days/)
  assert.match(all, /Workspace .* choose Internal/)
  assert.match(all, /Desktop app/)
  assert.match(all, /gmail\.modify/)
  for (const s of STEPS) for (const l of s.links) assert.ok(linkUrl(l.id), l.id)
  for (const url of Object.values(LINKS)) assert.match(url, /^https:\/\/(console\.cloud\.google\.com|myaccount\.google\.com|github\.com\/BronOS\/cc-cockpit-gmail)[/#]/)
  for (const bad of ['constructor', '__proto__', 'toString', 'https://x', '', null, 1]) assert.equal(linkUrl(bad), null, String(bad))
})

function deps(over = {}) {
  const calls = []
  const st = {
    client: { source: 'pasted', id: '123456789012…' },
    signedIn: true,
    account: 'me@example.com',
    lastPoll: NOW - 60000,
    pollMinutes: 2,
    counts: [{ id: 'unread', title: 'Unread', total: 2, unread: 2 }, { id: 'alerts', title: 'Alerts', total: 1, unread: 1 }],
    triage: 'on (bronos.jev-triage)',
    annotate: 'reviewer.annotate',
    laneErrors: {},
    threadErrors: [],
    ...over.status,
  }
  const view = { lanes: [{ id: 'unread', title: 'Unread', rows: [{ id: '18f0a1b2c3d4e5f1', kind: 'thread', unread: true, verdict: { priority: 'urgent' }, facts: { lead: { from: 'Ann', address: 'a@x.org' }, subject: 'Hi', count: 2 } }] }, { id: 'alerts', title: 'Alerts', rows: [{ id: 'alert:Disk', kind: 'alert', verdict: null, group: { name: 'Disk', nodes: ['db1'], resolved: false, firing: 2, count: 2 } }] }] }
  return {
    calls,
    d: {
      status: () => st,
      refresh: async () => (calls.push('refresh'), over.refresh || {}),
      view: () => view,
      show: async (id) => (calls.push(['show', id]), `text of ${id}`),
      login: async () => (calls.push('login'), over.login || {}),
      logout: async () => (calls.push('logout'), {}),
      client: async (text) => (calls.push(['client', text]), over.client || { ok: true, message: 'Client saved.' }),
    },
  }
}

test('cli: help, unknown commands and bad arguments exit 2', async () => {
  const { d } = deps()
  assert.equal((await runCli([], d)).stdout, HELP)
  assert.equal((await runCli(['help'], d)).code, 0)
  assert.equal((await runCli(['list', '--help'], d)).stdout, HELP)
  const u = await runCli(['frobnicate'], d)
  assert.equal(u.code, 2)
  assert.match(u.stderr, /unknown command "frobnicate"/)
  assert.equal((await runCli(['list', 'spam'], d)).code, 2)
  assert.equal((await runCli(['show'], d)).code, 2)
  assert.equal((await runCli(['show', '../etc'], d)).code, 2)
  assert.equal((await runCli(['client'], d)).code, 2)
  assert.match(HELP, /never archives,\nlabels, trashes or sends/)
  assert.match(HELP, /ccc gmail read <id> +mark a thread read/)
  assert.match(HELP, /ccc gmail unread <id> +mark a thread unread/)
})

test('cli: list, show, refresh, login, logout', async () => {
  const { d, calls } = deps()
  const l = await runCli(['list'], d)
  assert.match(l.stdout, /^Unread \(1\)\n {2}\* U 18f0a1b2c3d4e5f1 +Ann +Hi \(2\)\nAlerts \(1\)\n {2}\* {3}alert:Disk +Disk: db1 +\[2 firing, 2 mails\]/)
  assert.match((await runCli(['list', 'read'], d)).stdout, /^Read: this lane is off/)
  assert.match((await runCli(['list', 'alerts'], d)).stdout, /^Alerts \(1\)/)
  assert.equal((await runCli(['show', 'alert:Disk'], d)).stdout, 'text of alert:Disk\n')
  assert.equal((await runCli(['refresh'], d)).stdout, 'Unread 2 · Alerts 1 (1 unread)\n')
  assert.match((await runCli(['login'], d)).stdout, /browser opens the Google sign-in/)
  assert.equal((await runCli(['logout'], d)).stdout, 'Signed out.\n')
  assert.deepEqual(calls, [['show', 'alert:Disk'], 'refresh', 'login', 'logout'])
  const pending = deps({ refresh: { pending: true } })
  assert.match((await runCli(['refresh'], pending.d)).stdout, /still polling/)
  const bad = deps({ refresh: { error: 'Gmail had a problem (503)' } })
  assert.match((await runCli(['refresh'], bad.d)).stderr, /refresh failed: Gmail had a problem/)
})

test('cli: not signed in says what to do next, per case', async () => {
  const none = deps({ status: { client: null, signedIn: false } })
  assert.match((await runCli(['list'], none.d)).stderr, /No OAuth client yet: ccc gmail client <file\.json>/)
  const out = deps({ status: { signedIn: false, signedOutReason: 'Google ended the sign-in (invalid_grant)...' } })
  assert.match((await runCli(['refresh'], out.d)).stderr, /invalid_grant/)
  const plain = deps({ status: { signedIn: false } })
  assert.match((await runCli(['show', '18f0a1b2c3d4e5f1'], plain.d)).stderr, /Not signed in to Google: ccc gmail login/)
  const noPoll = deps({ status: { lastPoll: 0 } })
  assert.match((await runCli(['list'], noPoll.d)).stderr, /no poll yet/)
})

test('cli client <file>: relative to the caller, size-capped, the file text handed on', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'c.json'), '{"installed":{}}')
  fs.writeFileSync(path.join(dir, 'big.json'), 'x'.repeat(70000))
  fs.mkdirSync(path.join(dir, 'sub'))
  const { d, calls } = deps()
  assert.equal((await runCli(['client', 'c.json'], d, { cwd: dir })).stdout, 'Client saved.\n')
  assert.deepEqual(calls[0], ['client', '{"installed":{}}'])
  assert.match((await runCli(['client', 'big.json'], d, { cwd: dir })).stderr, /too big/)
  assert.match((await runCli(['client', 'sub'], d, { cwd: dir })).stderr, /is not a file/)
  assert.match((await runCli(['client', 'nope.json'], d, { cwd: dir })).stderr, /cannot read .*ENOENT/)
  const refused = deps({ client: { ok: false, error: 'This is a "Web application" client.' } })
  const r = await runCli(['client', 'c.json'], refused.d, { cwd: dir })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Web application/)
})

test('cli: a throwing dependency is an error line, never a crash', async () => {
  const { d } = deps()
  d.show = async () => {
    throw new Error('Gmail had a problem (500)')
  }
  const r = await runCli(['show', '18f0a1b2c3d4e5f1'], d)
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'Gmail had a problem (500)\n')
})

test('statusText: every state reads as a next step', () => {
  assert.match(statusText({ tooOld: 'needs cc-cockpit 0.9.1' }), /^needs cc-cockpit 0\.9\.1\n$/)
  const none = statusText({ client: null, signedIn: false })
  assert.match(none, /^client {4}\(none\)\nsign-in {3}not signed in\n\nSet up an OAuth client first/)
  const ready = statusText({ client: { source: 'settings', id: '555555555555…' }, signedIn: true, sessionOnly: true, account: 'me@example.com', lastPoll: NOW - 120000, pollMinutes: 2, backoffMinutes: 8, counts: [], triage: 'off', annotate: 'x', error: 'boom', laneErrors: { read: 'gone' }, threadErrors: [{ id: 't', message: 'm' }], problems: ['alertSenders: bad'] }, NOW)
  assert.match(ready, /client {4}555555555555… \(settings\)/)
  assert.match(ready, /for this session only/)
  assert.match(ready, /now every 8 min: Gmail was busy/)
  assert.match(ready, /lanes {5}no lane is on/)
  assert.match(ready, /error {5}boom\nerror {5}read: gone\nerror {5}t: m/)
  assert.match(ready, /problem {3}alertSenders: bad/)
  assert.match(statusText({ client: { source: 'pasted', id: 'x' }, signedIn: false, signingIn: true }), /waiting for the browser/)
  assert.match(listText({ lanes: [] }, undefined), /\* unread {3}triage: U urgent/)
})

/**
 * panels/thread.js in a vm with just enough of a page: the elements it looks up, a template whose
 * parsed content has no elements (clean() then has nothing to strip), and a ccPanel that records.
 */
function threadPage() {
  const el = () => ({ listeners: [], children: null, addEventListener(t, fn) { this.listeners.push(fn) }, replaceChildren(c) { this.children = c } })
  const els = { doc: el(), discuss: el(), new: el(), browser: el() }
  const page = { readies: 0, posts: [], onMessage: null, els }
  const document = {
    title: '',
    getElementById: (id) => els[id],
    querySelectorAll: () => [],
    createElement: () => ({ set innerHTML(v) { this.content = { html: v, querySelectorAll: () => [] } } }),
    createTextNode: (t) => t,
  }
  const ccPanel = { ready: () => page.readies++, post: (m) => page.posts.push(m), onMessage: (fn) => (page.onMessage = fn) }
  const code = fs.readFileSync(path.join(__dirname, '..', 'panels', 'thread.js'), 'utf8')
  vm.runInNewContext(code, { document, ccPanel, Map, Set, Number, String, Array })
  page.send = (m) => page.onMessage(m)
  return page
}

test('thread page: ready once the mail is drawn (not at load), once; a mail with no html parts is ready on doc', () => {
  const p = threadPage()
  assert.equal(p.readies, 0, 'the loader stays while the page waits for the mail')
  p.send({ type: 'doc', title: 'Lunch', parts: 2 })
  p.send({ type: 'html', i: 0, part: '<p>Hi ' })
  assert.equal(p.readies, 0, 'not before every part is in')
  p.send({ type: 'html', i: 1, part: 'there</p>' })
  assert.equal(p.readies, 1)
  assert.equal(p.els.doc.children.html, '<p>Hi there</p>')
  // A part sent again re-renders but does not call ready a second time.
  p.send({ type: 'html', i: 1, part: 'again</p>' })
  assert.equal(p.readies, 1)
  const empty = threadPage()
  empty.send({ type: 'doc', title: 'Empty', parts: 0 })
  assert.equal(empty.readies, 1)
})
