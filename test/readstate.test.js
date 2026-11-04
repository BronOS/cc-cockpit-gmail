'use strict'
// Mark read / mark unread (0.3.0): the one write call (threads.modify, the UNREAD label and nothing
// else), the bound on it, the optimistic move with its rollback, alert groups, markReadOnOpen, the
// scope upgrade of a gmail.readonly sign-in, and `ccc gmail read|unread`.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { setThreadUnread, readStateBody, GmailError, WRITE_SCOPE_TEXT } = require('../dist/lib/http')
const { createClient } = require('../dist/lib/client')
const { createGate, overlayCache } = require('../dist/lib/readstate')
const { createAuth } = require('../dist/lib/auth')
const { grantedScope, SCOPE, READONLY_SCOPE } = require('../dist/lib/oauth-client')
const { readSettings } = require('../dist/lib/settings')
const { runCli } = require('../dist/lib/cli')
const { sha } = require('../dist/lib/util')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, fakeSecrets, fakeStorage, tokens, fixture, json, NOW, T, CLIENT_ID } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))

function boot(opts = {}) {
  const reg = tokens()
  const gmail = fakeGmail({ tokens: reg, ...(opts.gmail || {}) })
  const oauth = fakeOAuth(reg, opts.oauthOpts)
  const ctx = fakeCtx({
    project: opts.project === undefined ? { alertSenders: ['alerts@example.com'] } : opts.project,
    oauth,
    triage: opts.triage === undefined ? fakeTriage() : opts.triage,
    reviewer: opts.reviewer === undefined ? { annotate: async () => ({ opened: true }) } : opts.reviewer,
    storage: opts.storage,
    secrets: opts.secrets,
  })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000 })
  return { gmail, oauth, ctx, h, reg }
}

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
const ids = (st, id) => lane(st, id).rows.map((r) => r.id)
const writesOf = (gmail) => gmail.calls.filter((c) => c.method !== 'GET')

// ---- the one write ----

test('readStateBody: exactly the UNREAD label, added or removed, from a boolean only', () => {
  assert.deepEqual(readStateBody(false), { removeLabelIds: ['UNREAD'] })
  assert.deepEqual(readStateBody(true), { addLabelIds: ['UNREAD'] })
  for (const bad of [undefined, null, 0, 1, 'true', ['INBOX'], { removeLabelIds: ['INBOX'] }]) assert.equal(readStateBody(bad), null, String(bad))
})

test('setThreadUnread: POST threads/<id>/modify with the body built here, JSON, no redirect; bad input never reaches fetch', async () => {
  const calls = []
  const fetch = async (url, init) => (calls.push({ url, init }), json({ id: T.t1, messages: [] }))
  await setThreadUnread(T.t1, false, { token: 'tok', fetch })
  await setThreadUnread(T.t1, true, { token: 'tok', fetch })
  assert.equal(calls[0].url, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${T.t1}/modify`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(calls[0].init.body), { removeLabelIds: ['UNREAD'] })
  assert.deepEqual(JSON.parse(calls[1].init.body), { addLabelIds: ['UNREAD'] })
  for (const [id, unread] of [['../labels', false], [`${T.t1}/x`, false], ['', false], [T.t1, 'yes'], [T.t1, { addLabelIds: ['TRASH'] }]]) {
    await assert.rejects(setThreadUnread(id, unread, { token: 'tok', fetch }), (e) => e instanceof GmailError && e.kind === 'unsafe')
  }
  assert.equal(calls.length, 2)
})

test('a write refused for the scope (a gmail.readonly token) is kind scope, with the sign-in-again text', async () => {
  const fetch = async () => json(fixture('error-403-scope.json'), 403)
  await assert.rejects(setThreadUnread(T.t1, false, { token: 'tok', fetch }), (e) => e.kind === 'scope' && e.message === WRITE_SCOPE_TEXT)
  assert.match(WRITE_SCOPE_TEXT, /^Sign in again to allow marking mail read/)
})

test('client.setUnread: a 401 takes a fresh token and tries once more', async () => {
  const reg = tokens()
  reg.valid.add('good')
  const g = fakeGmail({ tokens: reg })
  let tok = 'stale'
  const c = createClient({ getToken: async () => tok, invalidate: () => (tok = 'good'), fetch: g.fetch })
  await c.setUnread(T.t2, false)
  assert.deepEqual(g.calls.map((x) => [x.method, x.auth]), [['POST', 'Bearer stale'], ['POST', 'Bearer good']])
  assert.deepEqual(g.state.modifies, [{ id: T.t2, body: { removeLabelIds: ['UNREAD'] } }])
})

// ---- the bound ----

test('the gate: at most `concurrency` at once, at most `perMinute` started in a minute, then it waits', async () => {
  let clock = 0
  const sleeps = []
  const gate = createGate({ concurrency: 2, perMinute: 3, now: () => clock, sleep: async (ms) => (sleeps.push(ms), (clock += ms)) })
  let running = 0
  let peak = 0
  const job = async () => {
    const start = clock
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 2))
    running--
    return start
  }
  const at = await Promise.all([1, 2, 3, 4, 5].map(() => gate.run(job)))
  assert.equal(peak, 2)
  assert.deepEqual(at.slice(0, 3), [0, 0, 0])
  assert.ok(at[3] >= 60000 && at[4] >= 60000, 'the 4th and 5th waited for the window')
  assert.ok(sleeps.length >= 1)
})

test('the gate: stop refuses what waits and everything after; a full queue is refused at once', async () => {
  let release
  const hold = new Promise((r) => (release = r))
  const gate = createGate({ concurrency: 1, maxQueued: 2 })
  const started = []
  const a = gate.run(async () => (started.push('a'), hold))
  const b = gate.run(async () => started.push('b'))
  const c = gate.run(async () => started.push('c'))
  await assert.rejects(gate.run(async () => started.push('d')), /too many Gmail changes waiting/)
  gate.stop()
  await assert.rejects(b, (e) => e.kind === 'stopped')
  await assert.rejects(c, (e) => e.kind === 'stopped')
  await assert.rejects(gate.run(async () => started.push('e')), (e) => e.kind === 'stopped')
  release()
  await a
  assert.deepEqual(started, ['a'])
})

// ---- the optimistic view ----

test('overlayCache: read leaves Unread (and Alerts) for Read, unread leaves Read; the cache is not touched', () => {
  const msg = (unread) => ({ id: 'm', at: 1, address: 'a@x.org', unread, labels: unread ? ['INBOX', 'UNREAD'] : ['INBOX'] })
  const cache = { lists: { unread: ['u1', 'u2'], alerts: ['a1'], read: ['r1'] }, threads: { u1: { messages: [msg(true)] }, u2: { messages: [msg(true)] }, a1: { messages: [msg(true)] }, r1: { messages: [msg(false)] } } }
  const before = JSON.stringify(cache)
  const v = overlayCache(cache, new Map([['u1', false], ['a1', false], ['r1', true], ['gone', false]]))
  assert.deepEqual(v.lists, { unread: ['r1', 'u2'], alerts: [], read: ['u1'] })
  assert.equal(v.threads.u1.messages[0].unread, false)
  assert.deepEqual(v.threads.u1.messages[0].labels, ['INBOX'])
  assert.deepEqual(v.threads.r1.messages[0].labels, ['INBOX', 'UNREAD'])
  assert.equal(JSON.stringify(cache), before)
  assert.equal(overlayCache(cache, new Map()), cache)
})

test('Mark read: the row moves to Read before Gmail answers, the one call removes UNREAD only, a poll keeps it there', async () => {
  let open
  const gateP = new Promise((r) => (open = r))
  const b = await signedIn({ gmail: { modifyGate: gateP } })
  const { ctx, h, gmail } = b
  assert.ok(ids(ctx.lastState(), 'unread').includes(T.t2))
  const done = ctx.sendPanel({ type: 'markRead', id: T.t2 })
  await until(() => !ids(ctx.lastState(), 'unread').includes(T.t2))
  const moved = lane(ctx.lastState(), 'read').rows.find((r) => r.id === T.t2)
  assert.ok(moved, 'shown in Read at once')
  assert.equal(moved.unread, false)
  assert.equal(ctx.lastState().unread, 1, 'the badge follows')
  assert.equal(gmail.state.modifies.length, 0, 'Gmail has not answered yet')
  open()
  await done
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies, [{ id: T.t2, body: { removeLabelIds: ['UNREAD'] } }])
  assert.deepEqual(writesOf(gmail).map((c) => [c.method, c.path]), [['POST', `/gmail/v1/users/me/threads/${T.t2}/modify`]])
  assert.notEqual((ctx.lastState().notice || {}).kind, 'error', 'no error notice on success')
  await h.pollNow('test')
  assert.equal(h.S.marks.size, 0, 'the poll read Gmail again: no override left')
  assert.ok(ids(ctx.lastState(), 'read').includes(T.t2))
  assert.ok(!ids(ctx.lastState(), 'unread').includes(T.t2))
  await h.stop()
})

test('Mark unread on a Read row: back to Unread, the one call adds UNREAD only', async () => {
  const { ctx, h, gmail } = await signedIn()
  const row = lane(ctx.lastState(), 'read').rows.find((r) => r.id === T.t3)
  assert.equal(row.unread, false)
  await ctx.sendPanel({ type: 'markUnread', id: T.t3 })
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies, [{ id: T.t3, body: { addLabelIds: ['UNREAD'] } }])
  assert.ok(ids(ctx.lastState(), 'unread').includes(T.t3))
  assert.ok(!ids(ctx.lastState(), 'read').includes(T.t3))
  await h.pollNow('test')
  assert.ok(ids(ctx.lastState(), 'unread').includes(T.t3))
  await h.stop()
})

test('a failed write rolls the row back and says why; Gmail is unchanged', async () => {
  const { ctx, h, gmail } = await signedIn({ gmail: { fail: { [`modify:${T.t2}`]: 500 } } })
  await ctx.sendPanel({ type: 'markRead', id: T.t2 })
  await h.writesIdle()
  const st = ctx.lastState()
  assert.ok(ids(st, 'unread').includes(T.t2), 'back in Unread')
  assert.ok(!ids(st, 'read').includes(T.t2))
  assert.equal(lane(st, 'unread').rows.find((r) => r.id === T.t2).unread, true)
  assert.equal(st.notice.kind, 'error')
  assert.match(st.notice.text, /could not be marked read in Gmail: Gmail had a problem \(500\).*It is back where it was/)
  assert.equal(h.S.marks.size, 0)
  assert.equal(gmail.state.modifies.length, 0)
  await h.stop()
})

test('Mark read on an alert group marks every unread thread of the group read; the group leaves the lane', async () => {
  const { ctx, h, gmail } = await signedIn()
  const g = lane(ctx.lastState(), 'alerts').rows.find((r) => r.id === 'alert:HighCPU')
  assert.ok(g)
  const groupThreads = h.S.view.lanes.find((l) => l.id === 'alerts').rows.find((r) => r.id === 'alert:HighCPU').group.threadIds
  assert.deepEqual([...groupThreads].sort(), [T.a1, T.a2].sort())
  await ctx.sendPanel({ type: 'markRead', id: 'alert:HighCPU' })
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies.map((m) => m.id).sort(), [T.a1, T.a2].sort())
  assert.ok(gmail.state.modifies.every((m) => JSON.stringify(m.body) === '{"removeLabelIds":["UNREAD"]}'))
  assert.deepEqual(ids(ctx.lastState(), 'alerts'), [T.a3])
  assert.ok(!ids(ctx.lastState(), 'read').includes(T.a1), 'Read leaves alerts out')
  await h.pollNow('test')
  assert.deepEqual(ids(ctx.lastState(), 'alerts'), [T.a3])
  // An alert group has no Mark unread.
  await ctx.sendPanel({ type: 'markUnread', id: `alert:${'x'}` })
  assert.match(ctx.lastState().notice.text, /cannot be marked unread/)
  await h.stop()
})

test('one thread of an alert group fails: only that one goes back, the notice counts them', async () => {
  const { ctx, h, gmail } = await signedIn({ gmail: { fail: { [`modify:${T.a2}`]: 500 } } })
  await ctx.sendPanel({ type: 'markRead', id: 'alert:HighCPU' })
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies.map((m) => m.id), [T.a1])
  assert.match(ctx.lastState().notice.text, /^1 of 2 threads of the alert "HighCPU" could not be marked read/)
  const g = h.S.view.lanes.find((l) => l.id === 'alerts').rows.find((r) => r.id === 'alert:HighCPU')
  assert.deepEqual(g.group.threadIds, [T.a2])
  await h.stop()
})

test('markReadOnOpen on: opening an unread thread marks it read; a read thread is not written', async () => {
  const { ctx, h, gmail } = await signedIn({ project: { alertSenders: ['alerts@example.com'], markReadOnOpen: true } })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies, [{ id: T.t1, body: { removeLabelIds: ['UNREAD'] } }])
  assert.ok(ids(ctx.lastState(), 'read').includes(T.t1))
  await ctx.sendPanel({ type: 'open', id: T.t3 })
  await h.writesIdle()
  assert.equal(gmail.state.modifies.length, 1, 'already read: no call')
  // Discuss and `ccc gmail show` read the thread without marking it.
  await ctx.sendPanel({ type: 'newSession', id: T.t2 })
  await ctx.runCli(['show', T.t2])
  await h.writesIdle()
  assert.equal(gmail.state.modifies.length, 1)
  await h.stop()
})

test('markReadOnOpen off: opening leaves the thread unread in Gmail and in the lane', async () => {
  const { ctx, h, gmail } = await signedIn({ project: { alertSenders: ['alerts@example.com'], markReadOnOpen: false } })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  await h.writesIdle()
  assert.equal(writesOf(gmail).length, 0)
  assert.ok(ids(ctx.lastState(), 'unread').includes(T.t1))
  assert.equal(ctx.lastState().write.markReadOnOpen, false)
  assert.match((await ctx.runCli(['status'])).stdout, /write +mark read \/ unread on; opening a thread from the panel leaves it unread \(markReadOnOpen off\)/)
  await h.stop()
})

test('markReadOnOpen on an alert row marks the threads it shows read', async () => {
  const { ctx, h, gmail } = await signedIn({ project: { alertSenders: ['alerts@example.com'], markReadOnOpen: true } })
  await ctx.sendPanel({ type: 'open', id: 'alert:HighCPU' })
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies.map((m) => m.id).sort(), [T.a1, T.a2].sort())
  await h.stop()
})

// ---- the scope upgrade ----

test('grantedScope reads a token response scope; none (cc-cockpit 0.9.3) is not known', () => {
  assert.equal(grantedScope(`${SCOPE} openid`), 'modify')
  assert.equal(grantedScope('https://mail.google.com/'), 'modify')
  assert.equal(grantedScope(READONLY_SCOPE), 'readonly')
  assert.equal(grantedScope(undefined), null)
  assert.equal(grantedScope(''), null)
})

test('auth: a 0.2.0 sign-in (marker without scope) still reads but needs the write scope; 0.3.0 keeps it in the marker', async () => {
  const storage = fakeStorage()
  const secrets = fakeSecrets()
  const reg = tokens()
  const oauth = fakeOAuth(reg)
  const mk = () => createAuth({ oauth, secrets, storage, log: { info() {}, warn() {} }, now: () => NOW })
  const cfg = readSettings({}).cfg
  const a = mk()
  await a.load(cfg)
  await a.pasteClient(CLIENT_FILE)
  await a.signIn()
  assert.deepEqual(await storage.get('signedIn'), { client: sha(CLIENT_ID, 12), scope: 'modify' })
  assert.equal(a.status().needsWriteScope, false)
  // What 0.2.0 left behind: the same marker without `scope`.
  await storage.set('signedIn', { client: sha(CLIENT_ID, 12) })
  const old = mk()
  await old.load(cfg)
  assert.equal(old.status().signedIn, true)
  assert.equal(old.status().needsWriteScope, true)
  assert.match(await old.token(), /^ya29\./, 'reading goes on')
  // A sign-in again asks for gmail.modify and clears it.
  await old.signIn()
  assert.deepEqual(oauth.authorizes.at(-1).scopes, [SCOPE])
  assert.equal(old.status().needsWriteScope, false)
  // A write refused for the scope: kept, also over a restart.
  await old.scopeMissing()
  assert.deepEqual(await storage.get('signedIn'), { client: sha(CLIENT_ID, 12), scope: 'readonly' })
  const again = mk()
  await again.load(cfg)
  assert.equal(again.status().needsWriteScope, true)
  await again.signOut()
  assert.equal(again.status().needsWriteScope, false)
})

test('auth: a token response that lists only gmail.readonly (the Gmail box unticked) needs the write scope at once', async () => {
  const reg = tokens()
  const oauth = fakeOAuth(reg, { scopeField: READONLY_SCOPE })
  const a = createAuth({ oauth, secrets: fakeSecrets(), storage: fakeStorage(), log: { info() {}, warn() {} }, now: () => NOW })
  await a.load(readSettings({}).cfg)
  await a.pasteClient(CLIENT_FILE)
  await a.signIn()
  assert.equal(a.status().needsWriteScope, true)
})

test('a 0.2.0 sign-in in the host: lanes as before, the prompt to sign in again, Mark read sends nothing, open marks nothing', async () => {
  // A sign-in made by 0.2.0: a readonly grant and its marker without `scope`.
  const storage = fakeStorage()
  const secrets = fakeSecrets()
  const first = await signedIn({ storage, secrets, oauthOpts: { readonly: true } })
  await first.h.stop()
  await storage.set('signedIn', { client: sha(CLIENT_ID, 12) })
  const reg = first.reg
  const gmail = fakeGmail({ tokens: reg })
  const ctx = fakeCtx({ project: { alertSenders: ['alerts@example.com'] }, oauth: first.oauth, triage: fakeTriage(), reviewer: { annotate: async () => ({ opened: true }) }, storage, secrets })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000 })
  await h.ready
  await h.pollNow('test', true)
  await ctx.sendPanel({ type: 'hello' })
  let st = ctx.lastState()
  assert.ok(ids(st, 'unread').length > 0, 'reading is not broken')
  assert.deepEqual(st.write, { allowed: false, prompt: true, markReadOnOpen: false })
  await ctx.sendPanel({ type: 'open', id: T.t1 })
  await ctx.sendPanel({ type: 'markRead', id: T.t2 })
  await h.writesIdle()
  assert.equal(writesOf(gmail).length, 0, 'no write is tried with a readonly sign-in')
  assert.ok(ids(ctx.lastState(), 'unread').includes(T.t2))
  // Not now hides the prompt for the run; a Mark read press shows it again.
  await ctx.sendPanel({ type: 'hideScopePrompt' })
  assert.equal(ctx.lastState().write.prompt, false)
  await ctx.sendPanel({ type: 'markRead', id: T.t2 })
  assert.equal(ctx.lastState().write.prompt, true)
  assert.match((await ctx.runCli(['status'])).stdout, /write +off: this sign-in only reads .*ccc gmail login/)
  const r = await ctx.runCli(['read', T.t2])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Sign in again to allow marking mail read/)
  await h.stop()
})

test('scope upgrade: a readonly grant fails its first write (rolled back, the prompt), signing in again keeps the lanes and the verdicts, then Mark read works', async () => {
  const triage = fakeTriage()
  const { ctx, h, gmail, oauth } = await signedIn({ triage, oauthOpts: { readonly: true } })
  assert.equal(ctx.lastState().write.prompt, false, 'a 0.3.0 sign-in is taken as granted until Google says otherwise')
  await ctx.sendPanel({ type: 'markRead', id: T.t2 })
  await h.writesIdle()
  let st = ctx.lastState()
  assert.ok(ids(st, 'unread').includes(T.t2), 'rolled back')
  assert.deepEqual(st.write, { allowed: false, prompt: true, markReadOnOpen: false })
  assert.ok(!st.notice || st.notice.kind !== 'error', 'the prompt says it, not an error notice')
  assert.equal(gmail.state.modifies.length, 0)
  const classified = triage.calls.length
  const verdicts = JSON.stringify(h.S.verdicts)
  // Sign in again, now granting gmail.modify.
  oauth.readonly = false
  await ctx.sendPanel({ type: 'signIn' })
  await until(() => !h.auth.status().signingIn && ctx.lastState().write && ctx.lastState().write.allowed)
  await h.S.polling
  await h.S.classifying
  st = ctx.lastState()
  assert.equal(st.write.prompt, false)
  assert.match(st.notice.text, /Signed in again as me@example\.com: Mark read and Mark unread work now/)
  assert.equal(JSON.stringify(h.S.verdicts), verdicts, 'the same account keeps its verdicts')
  assert.equal(triage.calls.length, classified, 'nothing is judged again')
  await ctx.sendPanel({ type: 'markRead', id: T.t2 })
  await h.writesIdle()
  assert.deepEqual(gmail.state.modifies, [{ id: T.t2, body: { removeLabelIds: ['UNREAD'] } }])
  assert.ok(ids(ctx.lastState(), 'read').includes(T.t2))
  await h.stop()
})

// ---- CLI ----

test('ccc gmail read / unread: the thread changes in Gmail, the text says so; bad ids exit 2', async () => {
  const { ctx, h, gmail } = await signedIn()
  const r = await ctx.runCli(['read', T.t2])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^Marked ".*" read in Gmail\.\n$/)
  const u = await ctx.runCli(['unread', T.t2])
  assert.equal(u.code, 0)
  assert.match(u.stdout, /unread in Gmail/)
  assert.deepEqual(gmail.state.modifies.map((m) => m.body), [{ removeLabelIds: ['UNREAD'] }, { addLabelIds: ['UNREAD'] }])
  const g = await ctx.runCli(['read', 'alert:HighCPU'])
  assert.match(g.stdout, /\(2 threads\) read in Gmail/)
  assert.equal((await ctx.runCli(['read'])).code, 2)
  assert.equal((await ctx.runCli(['unread', '../labels'])).code, 2)
  assert.equal((await ctx.runCli(['unread', 'alert:HighCPU'])).code, 2)
  assert.equal(gmail.state.modifies.length, 4)
  await h.stop()
})

test('runCli read / unread: not signed in, a pending write, an error from the host', async () => {
  const st = { signedIn: true, client: { id: 'x', source: 'pasted' } }
  const calls = []
  const d = (answer, status = st) => ({ status: () => status, mark: async (id, unread) => (calls.push([id, unread]), answer) })
  assert.match((await runCli(['read', T.t1], d({}, { signedIn: false, client: null }))).stderr, /No OAuth client yet/)
  assert.match((await runCli(['read', T.t1], d({ pending: true }))).stdout, /still waiting for Gmail/)
  const e = await runCli(['unread', T.t1], d({ error: 'Gmail had a problem (500)' }))
  assert.equal(e.code, 1)
  assert.equal(e.stderr, 'Gmail had a problem (500)\n')
  assert.deepEqual(calls, [[T.t1, false], [T.t1, true]])
})

test('after stop: no write reaches Gmail, a pending one is refused', async () => {
  let open
  const gateP = new Promise((r) => (open = r))
  const { ctx, h, gmail } = await signedIn({ gmail: { modifyGate: gateP } })
  const posts = ctx.posts.length
  await h.stop()
  await ctx.sendPanel({ type: 'markRead', id: T.t2 })
  await h.writesIdle()
  open()
  assert.equal(writesOf(gmail).length, 0)
  assert.equal(ctx.posts.length, posts, 'nothing posted on a stopped host')
})
