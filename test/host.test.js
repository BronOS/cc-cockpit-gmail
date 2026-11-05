'use strict'
// The host end to end with a fake ctx, a fake Google sign-in and a fake Gmail: setup, sign-in,
// polling, triage, the panel actions, the reviewer and its fallbacks, the CLI, and the rule that
// no token or secret ever reaches a panel message, a log line or the CLI output.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const host = require('../dist/host')
const { refreshKey } = require('../dist/lib/auth')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, tokens, fixture, picture, tmpDir, API, ME, NOW, T, CLIENT_ID, CLIENT_SECRET, SETTINGS_CLIENT } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))

function boot(opts = {}) {
  const reg = tokens()
  const gmail = fakeGmail({ tokens: reg, ...(opts.gmail || {}) })
  const oauth = fakeOAuth(reg, opts.oauthOpts)
  const ctx = fakeCtx({
    project: opts.project === undefined ? { alertSenders: ['alerts@example.com'] } : opts.project,
    oauth,
    triage: opts.triage === undefined ? fakeTriage() : opts.triage,
    reviewer: opts.reviewer,
    sessions: opts.sessions,
    overlayAnswer: opts.overlayAnswer,
    storage: opts.storage,
    secrets: opts.secrets,
    dataDir: opts.dataDir,
    old: opts.old,
    buttons: !opts.noButtons,
  })
  let clock = NOW
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => clock, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000, imageWaitMs: opts.imageWaitMs })
  return { gmail, oauth, ctx, h, reg, tick: (ms) => (clock += ms) }
}

/** Boot, paste the client, sign in, wait for the first poll and triage. */
async function signedIn(opts = {}) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  await b.h.S.polling
  await b.h.S.classifying
  return b
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const lane = (st, id) => st.lanes.find((l) => l.id === id)
const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: `/p/${tabId}`, notes: [], files: [], ...extra })

/** Every string the plugin let out: panel posts, headers, logs. */
function everythingSaid(ctx) {
  return JSON.stringify([ctx.posts, ctx.headers, ctx.logs])
}

test('not configured: the setup guide, no request to Google, status says what to do', async () => {
  const { ctx, h, gmail, oauth } = boot()
  await h.ready
  await ctx.sendPanel({ type: 'hello' })
  const st = ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.equal(st.auth.client, null)
  assert.ok(st.steps.length >= 5)
  assert.ok(st.steps.some((s) => s.links.some((l) => l.id === 'clients')))
  await h.pollNow('test')
  assert.equal(gmail.calls.length, 0)
  assert.equal(oauth.authorizes.length, 0)
  const r = await ctx.runCli(['status'])
  assert.match(r.stdout, /client +\(none\)/)
  assert.match(r.stdout, /ccc gmail client <file.json>/)
  assert.equal(ctx.schedules[0].seconds, 120)
  await h.stop()
})

test('a setup link opens the fixed console URL with ctx.openExternal; an unknown id opens nothing', async () => {
  const { ctx, h } = boot()
  await ctx.sendPanel({ type: 'link', id: 'gmailApi' })
  await ctx.sendPanel({ type: 'link', id: 'https://evil.example' })
  await ctx.sendPanel({ type: 'link', id: 'constructor' })
  assert.deepEqual(ctx.external, ['https://console.cloud.google.com/apis/library/gmail.googleapis.com'])
  await h.stop()
})

test('an older app (no ctx.oauth, secrets, header, openExternal): the panel and the CLI say so, nothing runs', async () => {
  const { ctx, h, gmail } = boot({ old: true })
  await ctx.sendPanel({ type: 'hello' })
  assert.match(ctx.lastState().tooOld, /needs cc-cockpit 0\.9\.1 or later/)
  assert.match(ctx.lastState().tooOld, /ctx\.oauth, ctx\.secrets, ctx\.panels\.header, ctx\.openExternal/)
  assert.equal(ctx.schedules.length, 0)
  assert.match((await ctx.runCli(['status'])).stdout, /needs cc-cockpit 0\.9\.1/)
  assert.match((await ctx.runCli(['login'])).stderr, /needs cc-cockpit 0\.9\.1/)
  assert.equal(gmail.calls.length, 0)
  await h.stop()
})

test('pasting the client file: kept in this project\'s storage (it survives a reinstall), never in a post', async () => {
  const { ctx, h } = boot()
  await ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  const st = ctx.lastState()
  assert.equal(st.auth.client.source, 'pasted')
  assert.match(st.notice.text, /Client saved .*Next: Sign in with Google/)
  assert.deepEqual(await ctx.storage.get('client'), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.ok(!(await ctx.secrets.keys()).some((k) => k.startsWith('client:')))
  assert.ok(!everythingSaid(ctx).includes(CLIENT_SECRET))
  await h.stop()
})

test('a bad client file is refused with a reason by the paste box; nothing is stored', async () => {
  const { ctx, h } = boot()
  await ctx.sendPanel({ type: 'client', text: JSON.stringify(fixture('client-web.json')) })
  assert.match(ctx.lastState().clientError, /Web application.*Desktop app/)
  await ctx.sendPanel({ type: 'client', text: 'not json' })
  assert.match(ctx.lastState().clientError, /not JSON/)
  assert.equal((await ctx.secrets.keys()).length, 0)
  assert.equal(ctx.lastState().auth.client, null)
  await h.stop()
})

test('sign in: the Google auth URL with offline access and consent, gmail.modify only, the refresh token per project and client', async () => {
  const { ctx, h, oauth } = await signedIn()
  assert.equal(oauth.authorizes.length, 1)
  const spec = oauth.authorizes[0]
  assert.equal(spec.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent')
  assert.equal(spec.tokenUrl, 'https://oauth2.googleapis.com/token')
  assert.deepEqual(spec.scopes, ['https://www.googleapis.com/auth/gmail.modify'])
  assert.equal(spec.clientId, CLIENT_ID)
  assert.equal(spec.clientSecret, CLIENT_SECRET)
  const pk = await ctx.storage.get('projectKey')
  assert.match(pk, /^[a-f0-9]{12}$/)
  assert.equal(await ctx.secrets.get(refreshKey(pk, CLIENT_ID)), '1//refresh-1')
  assert.match(refreshKey(pk, CLIENT_ID), /^refresh:[a-f0-9]{12}:[a-f0-9]{12}$/)
  const st = ctx.lastState()
  assert.equal(st.auth.signedIn, true)
  assert.equal(st.account, ME)
  assert.match(st.notice.text, /Signed in as me@example\.com/)
  await h.stop()
})

test('the first poll fills the lanes: Unread without chat copies, Alerts grouped, Read; only shown rows go to triage', async () => {
  const triage = fakeTriage()
  const { ctx, h } = await signedIn({ triage })
  const st = ctx.lastState()
  assert.deepEqual(st.lanes.map((l) => l.id), ['unread', 'alerts', 'read'])
  assert.deepEqual(lane(st, 'unread').rows.map((r) => r.id).sort(), [T.t1, T.t2].sort())
  const alerts = lane(st, 'alerts').rows
  assert.deepEqual(alerts.map((r) => r.id).sort(), ['alert:HighCPU', T.a3].sort())
  const g = alerts.find((r) => r.kind === 'alert')
  assert.equal(g.count, 3)
  assert.equal(g.resolved, true, 'the newest message of the name (node2) is RESOLVED (design: newest decides)')
  assert.equal(g.firing, 2)
  assert.deepEqual(lane(st, 'read').rows.map((r) => r.id), [T.t3])
  // The row facts: the newest unread message of others speaks for the thread.
  const t1 = lane(st, 'unread').rows.find((r) => r.id === T.t1)
  assert.equal(t1.from, 'Ann Smith')
  assert.equal(t1.subject, 'Re: Q4 budget')
  assert.match(t1.snippet, /Also "the logo" for the deck, it's attached/)
  assert.equal(t1.unread, true)
  assert.equal(t1.count, 3)
  // Triage: source gmail, one call with every shown row, the alert group hinted noise.
  assert.equal(triage.calls.length, 1)
  assert.equal(triage.calls[0].source, 'gmail')
  assert.deepEqual(triage.calls[0].items.map((i) => i.id).sort(), [T.t1, T.t2, T.t3, T.a3, 'alert:HighCPU'].sort())
  assert.deepEqual(triage.calls[0].items.find((i) => i.id === 'alert:HighCPU').hint, { priority: 'noise' })
  // Badge: unread real mail only.
  assert.equal(ctx.badges[ctx.badges.length - 1], 2)
  // The title bar: last poll and the address, refresh enabled.
  const head = ctx.headers[ctx.headers.length - 1]
  assert.match(head.meta, /just now · me@example\.com/)
  assert.equal(head.actions[0].disabled, false)
  await h.stop()
})

test('Grafana: a name whose newest message is RESOLVED shows as resolved', async () => {
  const threads = { [T.a2]: fixture('thread-a2.json') }
  const { ctx, h } = await signedIn({ gmail: { threads, lists: { unread: [], alerts: [T.a2], read: [] } } })
  const g = lane(ctx.lastState(), 'alerts').rows[0]
  assert.equal(g.kind, 'alert')
  assert.equal(g.resolved, true)
  assert.equal(g.subject, 'HighCPU: node2')
  await h.stop()
})

test('the token goes only to gmail.googleapis.com, with no redirect followed', async () => {
  const { gmail, h } = await signedIn()
  assert.ok(gmail.calls.length > 5)
  assert.ok(gmail.calls.every((c) => c.url.startsWith(API + '/gmail/v1/users/me/')))
  assert.ok(gmail.calls.every((c) => c.redirect === 'manual'))
  assert.ok(gmail.calls.every((c) => /^Bearer ya29\./.test(c.auth)))
  await h.stop()
})

test('a second poll with no history change makes one cheap call and classifies nothing', async () => {
  const triage = fakeTriage()
  const { gmail, h } = await signedIn({ triage })
  const before = gmail.calls.length
  await h.pollNow('schedule')
  const after = gmail.calls.slice(before)
  assert.deepEqual(after.map((c) => c.path), ['/gmail/v1/users/me/history'])
  await h.S.classifying
  assert.equal(triage.calls.length, 1)
  await h.stop()
})

test('a history change runs the searches; only threads whose historyId moved are read again', async () => {
  const { gmail, h, ctx } = await signedIn()
  gmail.state.historyId = '1050'
  gmail.threads[T.t2] = { ...gmail.threads[T.t2], historyId: '1049' }
  const before = gmail.calls.length
  await h.pollNow('schedule')
  const after = gmail.calls.slice(before).map((c) => c.path)
  assert.equal(after.filter((p) => p === '/gmail/v1/users/me/threads').length, 3)
  assert.deepEqual(after.filter((p) => p.startsWith('/gmail/v1/users/me/threads/')), [`/gmail/v1/users/me/threads/${T.t2}`])
  assert.equal(h.S.cache.historyId, '1050')
  assert.ok(lane(ctx.lastState(), 'unread'))
  await h.stop()
})

test('a history id too old (404) means a full refresh, not an error', async () => {
  const fail = {}
  const { gmail, h, ctx } = await signedIn({ gmail: { fail } })
  fail.history = 404
  const before = gmail.calls.length
  await h.pollNow('schedule')
  const after = gmail.calls.slice(before).map((c) => c.path)
  assert.equal(after.filter((p) => p === '/gmail/v1/users/me/threads').length, 3, 'the searches ran')
  assert.equal(ctx.lastState().error, null)
  await h.stop()
})

test('the Refresh button in the title bar forces the searches', async () => {
  const { gmail, h, ctx } = await signedIn()
  const before = gmail.calls.length
  await ctx.clickAction('refresh')
  await h.S.polling
  const after = gmail.calls.slice(before).map((c) => c.path)
  assert.ok(!after.includes('/gmail/v1/users/me/history'))
  assert.equal(after.filter((p) => p === '/gmail/v1/users/me/threads').length, 3)
  await h.stop()
})

test('an expired sign-in (invalid_grant) signs out, deletes the refresh token and says why, naming the 7-day Testing expiry', async () => {
  const b = await signedIn()
  const pk = await b.ctx.storage.get('projectKey')
  b.oauth.invalidGrant = true
  b.h.auth.invalidate()
  b.gmail.state.historyId = '1100'
  await b.h.pollNow('schedule')
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.match(st.auth.signedOutReason, /invalid_grant/)
  assert.match(st.auth.signedOutReason, /7 days/)
  assert.match(st.auth.signedOutReason, /In production/)
  assert.equal(st.lanes.length, 0)
  assert.equal(await b.ctx.secrets.get(refreshKey(pk, CLIENT_ID)), null)
  assert.match((await b.ctx.runCli(['status'])).stdout, /7 days/)
  const r = await b.ctx.runCli(['list'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Sign in again/)
  await b.h.stop()
})

test('a 401 from Gmail refreshes the access token once and retries', async () => {
  const b = await signedIn()
  b.reg.valid.clear() // every token Gmail knew is dead; the refresh hands out a new one
  b.gmail.state.historyId = '1100'
  await b.h.pollNow('schedule')
  assert.equal(b.ctx.lastState().error, null)
  assert.equal(b.oauth.refreshes.length, 1)
  assert.equal(b.oauth.refreshes[0].refreshToken, '1//refresh-1')
  await b.h.stop()
})

test('the access token is refreshed shortly before it expires, not after', async () => {
  const b = await signedIn()
  b.tick(3600000 - 30000) // 30 s left: inside the one-minute margin
  await b.h.pollNow('schedule')
  assert.equal(b.oauth.refreshes.length, 1)
  await b.h.stop()
})

test('after a restart the stored refresh token signs in without the browser', async () => {
  const dataDir = tmpDir()
  const a = await signedIn({ dataDir })
  await a.h.stop()
  const b = boot({ dataDir, storage: a.ctx.storage, secrets: a.ctx.secrets })
  b.reg.valid = a.reg.valid
  await b.h.ready
  await b.ctx.sendPanel({ type: 'hello' })
  assert.equal(b.ctx.lastState().auth.signedIn, true)
  assert.equal(b.ctx.lastState().account, ME, 'the cached account and lanes are back at once')
  assert.ok(lane(b.ctx.lastState(), 'unread').rows.length)
  await b.h.pollNow('start')
  assert.equal(b.oauth.authorizes.length, 0)
  assert.equal(b.oauth.refreshes.length, 1)
  await b.h.stop()
})

test('sign out deletes the stored sign-in and empties the lanes', async () => {
  const b = await signedIn()
  const pk = await b.ctx.storage.get('projectKey')
  await b.ctx.sendPanel({ type: 'signOut' })
  assert.equal(await b.ctx.secrets.get(refreshKey(pk, CLIENT_ID)), null)
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.equal(st.lanes.length, 0)
  assert.equal(st.account, '')
  assert.equal((await b.ctx.storage.get('client')).clientId, CLIENT_ID, 'the client stays')
  await b.h.stop()
})

test('changing the clientId in the settings signs out (the old refresh token is deleted)', async () => {
  const b = boot({ project: { ...SETTINGS_CLIENT } })
  await b.h.ready
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  const pk = await b.ctx.storage.get('projectKey')
  assert.equal(b.oauth.authorizes[0].clientId, SETTINGS_CLIENT.clientId)
  assert.ok(await b.ctx.secrets.get(refreshKey(pk, SETTINGS_CLIENT.clientId)))
  await b.ctx.changeSettings({ clientId: '999999999999-other.apps.googleusercontent.com', clientSecret: 'GOCSPX-other' })
  assert.equal(await b.ctx.secrets.get(refreshKey(pk, SETTINGS_CLIENT.clientId)), null)
  assert.equal(b.ctx.lastState().auth.signedIn, false)
  assert.equal(b.ctx.lastState().auth.client.source, 'settings')
  await b.h.stop()
})

test('a pasted client wins over the settings fields until it is removed', async () => {
  const b = boot({ project: { ...SETTINGS_CLIENT } })
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  assert.equal(b.ctx.lastState().auth.client.source, 'pasted')
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.oauth.authorizes.length)
  assert.equal(b.oauth.authorizes[0].clientId, CLIENT_ID)
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  await b.ctx.sendPanel({ type: 'removeClient' })
  const st = b.ctx.lastState()
  assert.equal(st.auth.client.source, 'settings')
  assert.equal(st.auth.signedIn, false, 'another client: signed out')
  assert.equal(await b.ctx.storage.get('client'), undefined)
  await b.h.stop()
})

test('a client secret only in the settings, without its id, is reported missing', async () => {
  const b = boot({ project: { clientSecret: 'GOCSPX-x' } })
  await b.h.ready
  await b.ctx.sendPanel({ type: 'hello' })
  assert.deepEqual(b.ctx.lastState().auth.settingsMissing, ['clientId'])
  assert.equal(b.ctx.lastState().auth.client, null)
  await b.h.stop()
})

test('a locked keyring: the client paste works (storage); a sign-in lasts only the session and says that', async () => {
  const b = boot()
  await b.h.ready
  b.ctx.secrets.failSet = 'cannot store secrets: no Secret Service on the session bus'
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  assert.equal(b.ctx.lastState().clientError, null)
  b.ctx.secrets.failSet = 'cannot store secrets: locked'
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  await until(() => b.ctx.lastState().notice && /until the app closes/.test(b.ctx.lastState().notice.text))
  assert.equal(b.ctx.lastState().auth.sessionOnly, true)
  await b.h.stop()
})

test('a sign-in the browser does not finish: the reason as a notice, still signed out', async () => {
  const b = boot()
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  b.oauth.authorizeError = 'sign-in timed out (no answer from the browser within 5 minutes)'
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.ctx.lastState().notice && b.ctx.lastState().notice.kind === 'error')
  assert.match(b.ctx.lastState().notice.text, /timed out/)
  assert.equal(b.ctx.lastState().auth.signedIn, false)
  await b.h.stop()
})

test('ccc gmail login only starts the sign-in and returns at once; a second one starts over', async () => {
  const b = boot()
  await b.h.ready
  assert.match((await b.ctx.runCli(['login'])).stderr, /No OAuth client yet/)
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  let open
  b.oauth.gate = new Promise((r) => (open = r))
  const r = await b.ctx.runCli(['login'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /browser opens the Google sign-in/)
  assert.match((await b.ctx.runCli(['login'])).stdout, /Started over/)
  assert.match((await b.ctx.runCli(['status'])).stdout, /waiting for the browser/)
  open()
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  assert.match((await b.ctx.runCli(['status'])).stdout, /account +me@example\.com/)
  await b.h.stop()
})

test('ccc gmail client <file> reads the client file from the caller\'s folder', async () => {
  const b = boot()
  await b.h.ready
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'client.json'), CLIENT_FILE)
  const r = await b.ctx.runCli(['client', 'client.json'], dir)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Client saved \(123456789012…\)\. Next: ccc gmail login/)
  assert.ok(!r.stdout.includes(CLIENT_SECRET))
  assert.match((await b.ctx.runCli(['client', 'missing.json'], dir)).stderr, /cannot read/)
  await b.h.stop()
})

test('no token or secret ever reaches a panel post, a header, a log line or the CLI output', async () => {
  const b = await signedIn({ reviewer: { annotate: async () => ({ opened: true }) } })
  await b.ctx.sendPanel({ type: 'open', id: T.t1 })
  const outs = []
  for (const argv of [['status'], ['list'], ['show', T.t1], ['refresh'], ['help']]) outs.push(await b.ctx.runCli(argv))
  b.oauth.invalidGrant = true
  b.h.auth.invalidate()
  b.gmail.state.historyId = '1300'
  await b.h.pollNow('schedule')
  outs.push(await b.ctx.runCli(['status']))
  const all = everythingSaid(b.ctx) + JSON.stringify(outs)
  for (const secret of [CLIENT_SECRET, '1//refresh', 'ya29.']) assert.ok(!all.includes(secret), `leaked ${secret}`)
  await b.h.stop()
})

test('triage off: unsorted, the panel says so, nothing is classified', async () => {
  const { ctx, h } = await signedIn({ triage: null })
  const st = ctx.lastState()
  assert.equal(st.triage.on, false)
  assert.ok(st.lanes.flatMap((l) => l.rows).every((r) => r.verdict === null))
  assert.match((await ctx.runCli(['status'])).stdout, /triage +off: install and enable Jev triage/)
  await h.stop()
})

test('a triage change event classifies those ids again, other sources are ignored', async () => {
  const triage = fakeTriage()
  const { ctx, h } = await signedIn({ triage })
  ctx.handles.triage.listeners.change[0]({ source: 'gmail', ids: [T.t2] })
  ctx.handles.triage.listeners.change[0]({ source: 'jira', ids: [T.t1] })
  await h.S.classifying
  assert.equal(triage.calls.length, 2)
  assert.deepEqual(triage.calls[1].items.map((i) => i.id), [T.t2])
  ctx.handles.triage.listeners.change[0]({ source: 'gmail', ids: null })
  await h.S.classifying
  assert.equal(triage.calls[2].items.length, 5)
  await h.stop()
})

test('the verdict chooser stores an override and the row shows it; Undo clears it', async () => {
  const triage = fakeTriage()
  const { ctx, h } = await signedIn({ triage })
  await ctx.sendPanel({ type: 'wrong', id: T.t2, priority: 'urgent' })
  let row = lane(ctx.lastState(), 'unread').rows[0]
  assert.deepEqual(triage.overrides[T.t2], { priority: 'urgent' })
  assert.equal(row.id, T.t2, 'urgent sorts first')
  assert.equal(row.verdict.by, 'override')
  assert.match(ctx.lastState().notice.text, /Jev triage panel/)
  await ctx.sendPanel({ type: 'undoWrong', id: T.t2 })
  row = lane(ctx.lastState(), 'unread').rows.find((r) => r.id === T.t2)
  assert.equal(row.verdict.by, 'jev')
  await ctx.sendPanel({ type: 'wrong', id: T.t2, priority: 'whatever' })
  assert.equal(triage.overrides[T.t2], undefined)
  await h.stop()
})

test('Open with the html reviewer: clean HTML, the inline logo as an asset, the details aside, the active tab', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), { opened: true }) }
  const { ctx, h, gmail } = await signedIn({ project: { alertSenders: ['alerts@example.com'], markReadOnOpen: false }, reviewer, sessions: [tab('t1', 'waiting'), tab('t2', 'working', { active: true })], gmail: { attachments: { '18f0a1b2c3d4e503': picture('png', 300) } } })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.equal(c.title, 'Q4 budget')
  assert.equal(c.key, `gmail:${T.t1}`)
  assert.equal(c.tabId, 't2')
  assert.equal(c.url, `https://mail.google.com/mail/?authuser=me%40example.com#all/${T.t1}`)
  assert.equal(c.assets.length, 1)
  assert.match(c.assets[0].dataUrl, /^data:image\/png;base64,/)
  assert.ok(c.html.includes(`<img data-asset="${c.assets[0].id}" alt="Acme logo"`))
  assert.ok(!/script|onclick|javascript:|track\.example|style=/i.test(c.html))
  assert.match(c.html, /<details><summary>Quoted text<\/summary>/)
  assert.match(c.html, /<a href="https:\/\/acme\.com\/deck">the deck<\/a>/)
  assert.match(c.html, /Q4\.pdf · 178 KB/)
  assert.match(c.aside, /<dl class="facts">/)
  assert.match(c.aside, /Finance/, 'a user label by its name')
  assert.match(c.aside, /Open in Gmail/)
  assert.match(c.aside, /3 \(1 unread\)/)
  // markReadOnOpen off: opening changes nothing in Gmail.
  await h.writesIdle()
  assert.ok(gmail.calls.every((x) => x.method === 'GET' && !/modify|batchModify|trash|send/.test(x.path)))
  assert.equal(lane(ctx.lastState(), 'unread').rows.some((r) => r.id === T.t1), true)
  await h.stop()
})

test('Open an alert group: its newest threads in one document, a search link in Gmail', async () => {
  const calls = []
  const { ctx, h } = await signedIn({ reviewer: { annotate: async (s) => (calls.push(s), { opened: true }) } })
  await ctx.sendPanel({ type: 'open', id: 'alert:HighCPU' })
  const c = calls[0]
  assert.match(c.title, /^HighCPU: node1/)
  assert.match(c.key, /^gmail:alert:[a-f0-9]{16}$/)
  assert.match(c.url, /#search\/from%3Aalerts%40example\.com%20subject%3A%22HighCPU%22$/)
  assert.match(c.html, /2 threads of this alert/)
  assert.equal((c.html.match(/class="card( new)?"><div class="card-header">/g) || []).length, 3)
  await h.stop()
})

test('a reviewer that refuses html: text this time and for the rest of the run', async () => {
  const calls = []
  const reviewer = {
    annotate: async (spec) => {
      calls.push(spec)
      if (spec.html) throw new Error('reviewer: give exactly one of text and html')
      return { opened: true }
    },
  }
  const { ctx, h } = await signedIn({ reviewer })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.equal(calls.length, 2)
  assert.match(calls[1].text, /^Q4 budget\nGmail: https:\/\/mail\.google\.com/)
  assert.match(calls[1].text, /\[unread\] From: Ann Smith <ann@acme\.com>/)
  await ctx.sendPanel({ type: 'open', id: T.t2 })
  assert.equal(calls.length, 3)
  assert.ok(calls[2].text)
  assert.match((await ctx.runCli(['status'])).stdout, /text only/)
  await h.stop()
})

// Real-work feedback 8: the overlay came only after the thread (and its pictures) were read.
test('Open with a reviewer that has prepare: the overlay is up before the thread is read, then filled', async () => {
  const order = []
  const reviewer = {
    prepare: async (spec) => (order.push(['prepare', spec]), { opened: true }),
    cancel: async (spec) => (order.push(['cancel', spec]), { closed: false }),
    annotate: async (spec) => (order.push(['annotate', spec.key]), { opened: true }),
  }
  const { ctx, h, gmail } = await signedIn({ reviewer })
  const reads = () => gmail.calls.filter((x) => /\/threads\//.test(x.path)).length
  const before = reads()
  const realPrepare = reviewer.prepare
  reviewer.prepare = async (spec) => {
    // Nothing of the thread was read yet when the overlay was asked for.
    order.push(['reads at prepare', reads() - before])
    return realPrepare(spec)
  }
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.deepEqual(order[0], ['reads at prepare', 0])
  // The row's subject (its newest mail's): the thread is not read yet.
  // The inbox-item type goes with prepare: the reviewer fixes it when the overlay starts.
  assert.deepEqual(order[1], ['prepare', { key: `gmail:${T.t1}`, title: 'Re: Q4 budget', type: { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1 } } }])
  assert.ok(reads() > before, 'the open read the thread, after prepare')
  assert.deepEqual(order[2], ['annotate', `gmail:${T.t1}`])
  // The finally's cancel (a no-op once filled).
  assert.deepEqual(order[3], ['cancel', { key: `gmail:${T.t1}` }])
  // An alert group: the same key annotate gets.
  order.length = 0
  await ctx.sendPanel({ type: 'open', id: 'alert:HighCPU' })
  const prepared = order.find((x) => x[0] === 'prepare')[1]
  assert.match(prepared.key, /^gmail:alert:[a-f0-9]{16}$/)
  assert.match(prepared.title, /^HighCPU: node1/)
  assert.deepEqual(prepared.type, { name: 'inbox-item', data: { source: 'bronos.gmail', id: 'alert:HighCPU' } }, 'an alert group is a feed item (alertGroupsInInbox, on by default)')
  assert.equal(order.find((x) => x[0] === 'annotate')[1], prepared.key)
  await h.stop()
})

test('Open with prepare: an open that fails cancels the loading overlay; a reviewer without prepare still opens', async () => {
  const calls = []
  const reviewer = {
    prepare: async (spec) => (calls.push(['prepare', spec.key]), { opened: true }),
    cancel: async (spec) => (calls.push(['cancel', spec.key]), { closed: true }),
    annotate: async () => {
      throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
    },
  }
  const { ctx, h } = await signedIn({ reviewer })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.deepEqual(calls, [['prepare', `gmail:${T.t1}`], ['cancel', `gmail:${T.t1}`]])
  assert.match(ctx.lastState().notice.text, /could not open the mail/)
  await h.stop()
  // An older reviewer (no prepare, no cancel): annotate alone, as before.
  const old = []
  const b = await signedIn({ reviewer: { annotate: async (s) => (old.push(s.key), { opened: true }) } })
  await b.ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.deepEqual(old, [`gmail:${T.t1}`])
  await b.h.stop()
})

test('no annotate (an older reviewer) or no reviewer: the plugin\'s reader page, in parts', async () => {
  const { ctx, h } = await signedIn({ reviewer: { open: async () => ({}) }, overlayAnswer: { kind: 'value', value: { action: 'newSession' } } })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.equal(ctx.overlays.length, 1)
  const o = ctx.overlays[0]
  assert.equal(o.spec.file, 'panels/thread.html')
  assert.equal(o.posts[0].type, 'doc')
  assert.ok(o.posts.some((p) => p.type === 'html' && p.part.includes('Q4 budget')))
  // The page's answer: a new session about the mail.
  assert.equal(ctx.opened.length, 1)
  assert.match(ctx.opened[0].prompt, /^About the mail "Q4 budget" from Ann Smith/)
  assert.equal(ctx.opened[0].focus, true, 'the new tab is shown')
  // A link click in the page is opened by the app, and only a link the host put into the page.
  o.send({ open: 'https://acme.com/deck' })
  o.send({ open: 'file:///etc/passwd' })
  o.send({ open: 'https://evil.example/not-in-the-mail' })
  o.send({ open: 'javascript:alert(1)' })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ctx.external, ['https://acme.com/deck'])
  await h.stop()
})

test('↗ opens the thread in Gmail with ctx.openExternal; a refusal shows the address instead', async () => {
  const { ctx, h } = await signedIn()
  await ctx.sendPanel({ type: 'browser', id: T.t1 })
  assert.deepEqual(ctx.external, [`https://mail.google.com/mail/?authuser=me%40example.com#all/${T.t1}`])
  ctx.externalError = 'at most 3 per 10 s'
  await ctx.sendPanel({ type: 'browser', id: T.t2 })
  assert.match(ctx.lastState().notice.text, new RegExp(`Could not open the browser.*#all/${T.t2}`))
  await h.stop()
})

test('Discuss: the active tab gets the prompt; with several tabs and none active the person picks', async () => {
  const { ctx, h } = await signedIn({ sessions: [tab('a', 'waiting'), tab('b', 'waiting')] })
  await ctx.sendPanel({ type: 'discuss', id: T.t1 })
  const st = ctx.lastState()
  assert.equal(st.choose.id, T.t1)
  assert.equal(st.choose.tabs.length, 2)
  await ctx.sendPanel({ type: 'discuss', id: T.t1, tabId: 'b' })
  assert.equal(ctx.sent.length, 1)
  assert.equal(ctx.sent[0].tabId, 'b')
  assert.match(ctx.sent[0].text, /^About the mail "Q4 budget" from Ann Smith\n/)
  assert.match(ctx.sent[0].text, /Can you send the Q4 numbers by Friday\?/)
  assert.match(ctx.lastState().notice.text, /Sent "Re: Q4 budget" to "b"/)
  await h.stop()
})

test('panel ids are checked: a path or a query in an id never reaches Gmail', async () => {
  const { ctx, h, gmail } = await signedIn()
  const before = gmail.calls.length
  for (const id of ['../profile', 'x?y=1', '', 'a/b', 'alert:\nx']) await ctx.sendPanel({ type: 'open', id })
  assert.equal(gmail.calls.length, before)
  await h.stop()
})

test('Show all and the collapsed lanes are kept in storage', async () => {
  const { ctx, h } = await signedIn({ project: { alertSenders: ['alerts@example.com'], rowsPerLane: 1 } })
  let u = lane(ctx.lastState(), 'unread')
  assert.equal(u.rows.length, 1)
  assert.equal(u.total, 2)
  await ctx.sendPanel({ type: 'expand', lane: 'unread' })
  u = lane(ctx.lastState(), 'unread')
  assert.equal(u.rows.length, 2)
  await ctx.sendPanel({ type: 'toggle', lane: 'read' })
  assert.equal(lane(ctx.lastState(), 'read').collapsed, true)
  assert.deepEqual(await ctx.storage.get('ui'), { collapsed: { read: true }, expanded: { unread: true } })
  await ctx.sendPanel({ type: 'toggle', lane: '__proto__' })
  assert.deepEqual(await ctx.storage.get('ui'), { collapsed: { read: true }, expanded: { unread: true } })
  await h.stop()
})

test('lanes off are not searched; no alert senders means no Alerts lane', async () => {
  const { ctx, h, gmail } = await signedIn({ project: { lanes: { unread: true, alerts: true, read: false } } })
  assert.deepEqual(ctx.lastState().lanes.map((l) => l.id), ['unread'])
  const qs = gmail.calls.filter((c) => c.q).map((c) => c.q)
  assert.equal(qs.length, 1)
  assert.match(qs[0], /^is:unread -in:spam -in:trash newer_than:14d$/)
  await h.stop()
})

test('ccc gmail list, show and refresh', async () => {
  const { ctx, h } = await signedIn()
  const list = await ctx.runCli(['list'])
  assert.match(list.stdout, /^Unread \(2\)/m)
  assert.match(list.stdout, new RegExp(`\\* [A.] ${T.t1}`))
  assert.match(list.stdout, /alert:HighCPU +HighCPU: node1/)
  assert.match((await ctx.runCli(['list', 'nope'])).stderr, /unknown lane/)
  const show = await ctx.runCli(['show', T.t3])
  assert.match(show.stdout, /^Lunch\?/)
  assert.match(show.stdout, /Café at noon\? See https:\/\/example\.org\/menu\./, 'latin-1 decoded')
  const alert = await ctx.runCli(['show', 'alert:HighCPU'])
  assert.match(alert.stdout, /2 threads of this alert/)
  assert.equal((await ctx.runCli(['show', '../x'])).code, 2)
  const r = await ctx.runCli(['refresh'])
  assert.match(r.stdout, /Unread 2 · Alerts 2 \(2 unread\) · Read 1/)
  await h.stop()
})

test('a failed Read search keeps its last list and says so; a failed Unread search fails the poll', async () => {
  const fail = {}
  const b = await signedIn({ gmail: { fail } })
  // A 400, not a 5xx: Gmail being busy fails the whole poll (and backs off) instead.
  fail['list:read'] = 400
  b.gmail.state.historyId = '1400'
  await b.h.pollNow('schedule')
  let st = b.ctx.lastState()
  assert.deepEqual(lane(st, 'read').rows.map((r) => r.id), [T.t3], 'the last list stays')
  assert.ok(st.laneErrors && st.laneErrors.read, 'the lane says it is stale')
  delete fail['list:read']
  fail['list:unread'] = 400
  b.gmail.state.historyId = '1401'
  await b.h.pollNow('schedule')
  st = b.ctx.lastState()
  assert.ok(st.error)
  assert.ok(lane(st, 'unread').rows.length, 'the old lanes stay on screen')
  await b.h.stop()
})

test('a thread that cannot be read is left out with a log line; the rest show', async () => {
  const b = await signedIn({ gmail: { fail: { [`thread:${T.t2}`]: 500 } } })
  const st = b.ctx.lastState()
  assert.deepEqual(lane(st, 'unread').rows.map((r) => r.id), [T.t1])
  assert.ok(b.ctx.logs.some(([lvl, l]) => lvl === 'warn' && l.includes(`reading thread ${T.t2} failed`)))
  assert.match(st.error, /polls less often|Gmail had a problem/)
  await b.h.stop()
})

test('Gmail busy (429): the schedule backs off, doubling up to 30 min, and comes back after a good poll', async () => {
  const fail = {}
  const b = await signedIn({ project: { alertSenders: ['alerts@example.com'], pollMinutes: 10 }, gmail: { fail } })
  assert.equal(b.ctx.schedules[b.ctx.schedules.length - 1].seconds, 600)
  fail.history = 429
  await b.h.pollNow('schedule')
  assert.match(b.ctx.lastState().error, /rate limiting.*every 20 min/)
  assert.equal(b.ctx.schedules[b.ctx.schedules.length - 1].seconds, 1200)
  await b.h.pollNow('schedule')
  await b.h.pollNow('schedule')
  assert.equal(b.ctx.schedules[b.ctx.schedules.length - 1].seconds, 1800)
  delete fail.history
  await b.h.pollNow('schedule')
  assert.equal(b.ctx.lastState().error, null)
  assert.equal(b.ctx.schedules[b.ctx.schedules.length - 1].seconds, 600)
  await b.h.stop()
})

test('Gmail gave no read access (403 insufficient scope): the poll says to sign in again with the box ticked', async () => {
  const fail = {}
  const b = await signedIn({ gmail: { fail } })
  fail.history = 403
  await b.h.pollNow('schedule')
  assert.match(b.ctx.lastState().error, /no read access.*ticked/)
  await b.h.stop()
})

test('thread overlays: the reader page starts at once with the inbox-item type and ready manual, before the thread is read', async () => {
  const { ctx, h, gmail } = await signedIn()
  const reads = () => gmail.calls.filter((x) => /\/threads\//.test(x.path)).length
  const before = reads()
  const start = ctx.overlay.start
  let readsAtStart = -1
  ctx.overlay.start = (spec) => ((readsAtStart = reads() - before), start(spec))
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.equal(readsAtStart, 0, 'the overlay was asked for before the thread was read')
  const o = ctx.overlays[0]
  assert.equal(o.spec.ready, 'manual')
  assert.deepEqual(o.spec.type, { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1 } })
  assert.ok(o.posts.some((p) => p.type === 'doc'))
  assert.match(o.discuss().text, /^Subject: Re: Q4 budget\nFrom: Ann Smith/)
  await h.stop()
})

test('thread overlays: the reviewer gets the type in annotate; an alert row has the group\'s, none with alert groups off', async () => {
  const calls = []
  const { ctx, h } = await signedIn({ reviewer: { annotate: async (s) => (calls.push(s), { opened: true }) } })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.deepEqual(calls[0].type, { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1 } })
  await ctx.sendPanel({ type: 'open', id: 'alert:HighCPU' })
  assert.deepEqual(calls[1].type, { name: 'inbox-item', data: { source: 'bronos.gmail', id: 'alert:HighCPU' } })
  // The group's overlay gets its item buttons (Mark read: all its threads) like a thread's.
  const buttons = await ctx.buttonProviders[0].provider({ type: calls[1].type, title: 't', opener: 'bronos.gmail' })
  assert.deepEqual(buttons.map((b) => b.id), ['markRead'])
  await ctx.changeSettings({ alertSenders: ['alerts@example.com'], alertGroupsInInbox: false })
  await ctx.sendPanel({ type: 'open', id: 'alert:HighCPU' })
  assert.equal(calls[calls.length - 1].type, undefined, 'off: an alert row shows several threads and is no feed item')
  await h.stop()
})

test('overlay buttons: only for our own items, labels follow state, run = act', async () => {
  const { ctx, h } = await signedIn()
  assert.equal(ctx.buttonProviders.length, 1)
  assert.equal(ctx.buttonProviders[0].name, 'inbox-item')
  const provider = ctx.buttonProviders[0].provider
  const own = (id, source = 'bronos.gmail') => ({ type: { name: 'inbox-item', data: { source, id } }, title: 't', opener: 'bronos.gmail' })
  assert.deepEqual(await provider(own(T.t1, 'bronos.jira')), [])
  assert.deepEqual(await provider(own('not-a-thread')), [])
  assert.deepEqual(await provider({ type: { name: 'inbox-item', data: null }, title: 't', opener: 'x' }), [])
  const before = await provider(own(T.t1))
  assert.equal(before.length, 1)
  assert.ok(!before.some((b) => b.id === 'open'))
  assert.match(before[0].label, /read/i)
  await before[0].run(own(T.t1))
  await until(() => true)
  const after = await provider(own(T.t1))
  assert.notEqual(after[0].id, before[0].id)
  assert.notEqual(after[0].label, before[0].label)
  await h.stop()
})

test('overlay buttons: only on overlays we or the reviewer opened, whatever the data names', async () => {
  const { ctx, h } = await signedIn()
  const provider = ctx.buttonProviders[0].provider
  // `opener` is the app's record of who opened the overlay: another plugin naming our item, a type
  // data claiming to be ours, the CLI or core get no buttons that act on it.
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1, opener: 'bronos.gmail' } }, title: 't', opener })
  for (const foreign of ['evil.plugin', 'bronos.inbox', 'cli', 'core', '', undefined]) {
    assert.deepEqual(await provider(by(foreign)), [], `opener ${foreign}`)
  }
  assert.deepEqual(await provider({ type: by('x').type, title: 't' }), [])
  // Our own reader page and the reviewer we hand the item to (the project's pick) do.
  assert.equal((await provider(by('bronos.gmail'))).length, 1)
  ctx.services.provider = (name) => (name === 'reviewer' ? 'cockpit.reviewer' : null)
  assert.equal((await provider(by('cockpit.reviewer'))).length, 1)
  await h.stop()
})

test('overlay buttons: the reviewer the project picked, asked at button time; the bundled one only when picked', async () => {
  const { ctx, h } = await signedIn()
  const provider = ctx.buttonProviders[0].provider
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1, opener: 'bronos.gmail' } }, title: 't', opener })
  let picked = 'other.reviewer'
  const asked = []
  ctx.services.provider = (name) => (asked.push(name), name === 'reviewer' ? picked : null)
  // A replacement reviewer the project picked gets the buttons; the bundled one, not picked, does not.
  assert.equal((await provider(by('other.reviewer'))).length, 1)
  assert.deepEqual(await provider(by('cockpit.reviewer')), [])
  assert.ok(asked.includes('reviewer'))
  // The pick changes while we run: the next overlay follows it.
  picked = 'cockpit.reviewer'
  assert.equal((await provider(by('cockpit.reviewer'))).length, 1)
  assert.deepEqual(await provider(by('other.reviewer')), [])
  // No reviewer reachable, or the app refusing the name: no reviewer is trusted, our own page still is.
  picked = null
  assert.deepEqual(await provider(by('cockpit.reviewer')), [])
  ctx.services.provider = () => {
    throw new Error('plugin bronos.gmail does not declare service "reviewer" in services.uses')
  }
  assert.deepEqual(await provider(by('cockpit.reviewer')), [])
  assert.equal((await provider(by('bronos.gmail'))).length, 1)
  await h.stop()
})

test('overlay buttons: an older app without ctx.services.provider trusts the bundled reviewer only', async () => {
  const { ctx, h } = await signedIn()
  const provider = ctx.buttonProviders[0].provider
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1, opener: 'bronos.gmail' } }, title: 't', opener })
  delete ctx.services.provider
  assert.equal((await provider(by('cockpit.reviewer'))).length, 1)
  assert.deepEqual(await provider(by('other.reviewer')), [])
  assert.equal((await provider(by('bronos.gmail'))).length, 1)
  await h.stop()
})

test('overlay buttons: a ctx without the member still activates and opens a thread', async () => {
  const { ctx, h } = await signedIn({ noButtons: true, reviewer: { open: async () => ({}) } })
  assert.equal(ctx.buttonProviders.length, 0)
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.equal(ctx.overlays.length, 1)
  await h.stop()
})

test('overlay buttons: a failed Mark read (a Gmail error) shows in the notice and throws, not silent', async () => {
  const { ctx, h } = await signedIn({ gmail: { fail: { [`modify:${T.t1}`]: 500 } } })
  const provider = ctx.buttonProviders[0].provider
  const info = { type: { name: 'inbox-item', data: { source: 'bronos.gmail', id: T.t1 } }, title: 't', opener: 'bronos.gmail' }
  const [button] = await provider(info)
  assert.equal(button.id, 'markRead')
  await assert.rejects(button.run(info), /^Error: gmail: /)
  assert.equal(ctx.lastState().notice.kind, 'error')
  assert.match(ctx.lastState().notice.text, /^gmail: /)
  // Still unread, so the button still offers Mark read.
  assert.equal((await provider(info))[0].id, 'markRead')
  await h.stop()
})
