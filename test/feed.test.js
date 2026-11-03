'use strict'
// The `inbox-feed` service (0.4.0): the pure mapping (levels, rev, caps, ordering, the noise rule),
// the host's answers from its cache in each state, open / markRead with a bad id, `changed` after a
// poll and a read change, the Jira key passed through, and an app without `useAll` (before 0.9.7).
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const F = require('../dist/lib/feed')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, fakeJiraService, tokens, fixture, NOW, T, ME } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))

// ---- lib/feed.js ----

const msgOf = (o) => ({ id: 'm0', address: 'ann@example.com', from: 'Ann Smith', to: `Me <${ME}>`, cc: '', subject: 'Hello', snippet: '', unread: true, at: NOW, ...o })
function threadRow(id, o = {}) {
  const lead = msgOf({ ...o.lead })
  const latest = msgOf({ id: 'newest', ...o.latest })
  return { id, kind: 'thread', lane: o.lane || 'unread', at: o.at === undefined ? NOW : o.at, unread: o.unread !== false, verdict: o.verdict === undefined ? { priority: 'action' } : o.verdict, thread: { id, messages: [lead, latest] }, facts: { lead, latest, subject: lead.subject, unread: true, count: 2, at: latest.at, participants: [] } }
}

test('feedItem: every field of the contract, rev is the newest message, from the lead', () => {
  const r = threadRow('t1', { lead: { id: 'm1', subject: 'Re: Q4   budget', from: 'Ann Smith' }, latest: { id: 'm9' }, at: NOW - 5 })
  assert.deepEqual(F.feedItem(r, { me: ME }), { id: 't1', where: 'Unread', at: NOW - 5, level: 'action', unread: true, rev: 'm9', title: 'Re: Q4 budget', from: 'Ann Smith', direct: true })
})

test('feedItem: levels come from the verdict; no verdict or an unknown one is fyi', () => {
  for (const p of ['urgent', 'action', 'fyi', 'noise']) assert.equal(F.feedItem(threadRow('t', { verdict: { priority: p } })).level, p)
  assert.equal(F.feedItem(threadRow('t', { verdict: null })).level, 'fyi')
  assert.equal(F.feedItem(threadRow('t', { verdict: { priority: 'constructor' } })).level, 'fyi')
})

test('feedItem: direct only when the person is in To (not Cc, not a list), case-insensitive', () => {
  assert.equal(F.feedItem(threadRow('t', { lead: { to: 'Me <ME@example.com>' } }), { me: ME }).direct, true)
  assert.equal(F.feedItem(threadRow('t', { lead: { to: 'Bob <bob@example.com>', cc: ME } }), { me: ME }).direct, false)
  assert.equal(F.feedItem(threadRow('t', { lead: { to: 'list@example.com' } }), { me: ME }).direct, false)
  assert.equal(F.feedItem(threadRow('t'), { me: '' }).direct, false)
  assert.ok(!('mentionsMe' in F.feedItem(threadRow('t'), { me: ME })))
})

test('feedItem: jiraKey only from the host\'s map; long texts are cut', () => {
  const r = threadRow('t', { lead: { subject: 'x'.repeat(1000), from: 'y'.repeat(1000) } })
  const it = F.feedItem(r, { me: ME, jiraKeys: new Map([['t', 'ABC-2']]) })
  assert.equal(it.jiraKey, 'ABC-2')
  assert.ok(it.title.length <= 300 && it.from.length <= 200)
  assert.ok(!('jiraKey' in F.feedItem(r, { me: ME, jiraKeys: new Map() })))
})

test('feedItem: an alert group has its newest alert as rev, a title, and is never direct', () => {
  const g = { id: 'alert:HighCPU', name: 'HighCPU', nodes: ['n1'], count: 3, firing: 2, resolved: false, at: NOW, threadIds: ['a'], latest: msgOf({ id: 'al9', from: 'Grafana', subject: '[FIRING:2] HighCPU' }) }
  const it = F.feedItem({ id: g.id, kind: 'alert', lane: 'alerts', at: NOW, unread: true, verdict: { priority: 'noise' }, group: g }, { me: ME })
  assert.equal(it.rev, 'al9')
  assert.equal(it.where, 'Alerts')
  assert.equal(it.level, 'noise')
  assert.equal(it.direct, false)
  assert.match(it.title, /HighCPU/)
})

test('feedItems: best level first, then newest; read threads are not items', () => {
  const rows = [
    threadRow('f-old', { verdict: { priority: 'fyi' }, at: 1 }),
    threadRow('a-old', { at: 5 }),
    threadRow('u', { verdict: { priority: 'urgent' }, at: 2 }),
    threadRow('a-new', { at: 9 }),
    threadRow('read', { unread: false, verdict: { priority: 'urgent' } }),
  ]
  assert.deepEqual(F.feedItems(rows, { limit: 50 }).map((i) => i.id), ['u', 'a-new', 'a-old', 'f-old'])
})

test('feedItems: noise is left out unless nothing else is left; limit cuts', () => {
  const noise = (id) => threadRow(id, { verdict: { priority: 'noise' } })
  assert.deepEqual(F.feedItems([noise('n1'), threadRow('a')], { limit: 5 }).map((i) => i.id), ['a'])
  assert.deepEqual(F.feedItems([noise('n1'), noise('n2')], { limit: 5 }).map((i) => i.id).sort(), ['n1', 'n2'])
  assert.deepEqual(F.feedItems([], { limit: 5 }), [])
  const many = Array.from({ length: 10 }, (_, k) => threadRow(`t${k}`, { at: k }))
  assert.equal(F.feedItems(many, { limit: 3 }).length, 3)
})

test('feedLimit: default 20, clamped to 1..50, a non-object is refused', () => {
  assert.equal(F.feedLimit(undefined), 20)
  assert.equal(F.feedLimit({}), 20)
  assert.equal(F.feedLimit({ limit: 0 }), 1)
  assert.equal(F.feedLimit({ limit: -4 }), 1)
  assert.equal(F.feedLimit({ limit: 9999 }), 50)
  assert.equal(F.feedLimit({ limit: 7.9 }), 7)
  assert.equal(F.feedLimit({ limit: 'abc' }), 20)
  for (const bad of [5, 'x', [3], true]) assert.throws(() => F.feedLimit(bad), /^Error: gmail: /)
})

test('feedId: strings of the thread-id or alert shape only', () => {
  assert.equal(F.feedId(T.t1), T.t1)
  assert.equal(F.feedId('alert:HighCPU'), 'alert:HighCPU')
  for (const bad of [undefined, null, 5, {}, '', '../x', 'a/b', 'a?b', 'alert:', 'x'.repeat(65)]) assert.throws(() => F.feedId(bad), /^Error: gmail: not a thread id/)
})

// ---- the host ----

const ID = { jira: '18f0a1b2c3d4e5b2' }
function jiraThread() {
  const html = '<p>Ann Smith mentioned you on a work item ABC-2 Rotate keys</p>'
  return {
    id: ID.jira,
    historyId: '1100',
    messages: [
      {
        id: `${ID.jira}01`,
        threadId: ID.jira,
        labelIds: ['UNREAD', 'INBOX'],
        snippet: 'Ann Smith mentioned you on a work item ABC-2 Rotate keys',
        historyId: '900',
        internalDate: String(NOW - 3600000),
        payload: { partId: '', mimeType: 'text/html', filename: '', headers: [{ name: 'From', value: 'Acme Jira <jira@acme.atlassian.net>' }, { name: 'To', value: 'Me <me@example.com>' }, { name: 'Subject', value: '[Acme] (ABC-2) Rotate keys' }], body: { size: html.length, data: Buffer.from(html).toString('base64url') } },
      },
    ],
  }
}

function boot(opts = {}) {
  const reg = tokens()
  const base = Object.fromEntries(Object.entries({ t1: T.t1, t2: T.t2, t3: T.t3, a1: T.a1, a2: T.a2, a3: T.a3, c1: T.c1 }).map(([k, id]) => [id, fixture(`thread-${k}.json`)]))
  const threads = opts.jira ? { ...base, [ID.jira]: jiraThread() } : base
  const lists = { unread: [T.t1, T.t2, ...(opts.jira ? [ID.jira] : [])], alerts: [T.a1, T.a2, T.a3], read: [T.t3] }
  const gmail = fakeGmail({ tokens: reg, threads, lists, ...(opts.gmail || {}) })
  const ctx = fakeCtx({ project: { alertSenders: ['alerts@example.com'] }, oauth: fakeOAuth(reg), triage: opts.triage === undefined ? fakeTriage() : opts.triage, jira: opts.jira ? fakeJiraService({ issues: { 'ABC-2': { mine: true, done: false } } }) : null })
  let clock = NOW
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => clock, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000, imageWaitMs: 50 })
  return { gmail, ctx, h, feed: ctx.provided['inbox-feed'], tick: (ms) => (clock += ms) }
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function signedIn(opts) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  await b.h.S.polling
  await b.h.S.classifying
  return b
}

test('the plugin provides inbox-feed with the contract\'s methods and describes itself', async () => {
  const { feed, h } = boot()
  assert.deepEqual(Object.keys(feed).sort(), ['describe', 'features', 'items', 'markRead', 'open'])
  assert.deepEqual(await feed.describe(), { label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' })
  assert.deepEqual(await feed.features(), ['markRead'])
  await h.stop()
})

test('items, signed in: unread mail best first from the cache, the Read lane and the noisy alert group left out, no extra API call', async () => {
  const { feed, gmail, h } = await signedIn()
  const calls = gmail.calls.length
  const r = await feed.items({ limit: 50 })
  assert.equal(gmail.calls.length, calls, 'answered from the cache')
  assert.equal(r.state, 'ok')
  assert.equal(r.message, undefined)
  assert.equal(r.asOf, NOW)
  const ids = r.items.map((i) => i.id)
  assert.ok(ids.includes(T.t1) && ids.includes(T.t2))
  assert.ok(!ids.includes(T.t3), 'a read thread is not an item')
  assert.ok(!ids.includes('alert:HighCPU'), 'noise is left out while there is mail')
  const t1 = r.items.find((i) => i.id === T.t1)
  assert.equal(t1.rev, '18f0a1b2c3d4e503', 'the newest message of the thread')
  assert.equal(t1.title, 'Re: Q4 budget')
  assert.equal(t1.from, 'Ann Smith')
  assert.equal(t1.where, 'Unread')
  assert.equal(t1.level, 'action')
  assert.equal(t1.unread, true)
  assert.equal(t1.direct, true)
  assert.ok(Number.isFinite(t1.at) && t1.at > 0)
  assert.equal((await feed.items({ limit: 1 })).items.length, 1)
  await h.stop()
})

test('items: the answer is plain data; a bad argument is refused', async () => {
  const { feed, h } = await signedIn()
  const r = await feed.items()
  assert.deepEqual(r, structuredClone(r))
  await assert.rejects(feed.items('all'), /^Error: gmail: items takes an object/)
  await h.stop()
})

test('items, not set up or signed out: state signedOut with a message and no items', async () => {
  const b = boot()
  await b.h.ready
  const r = await b.feed.items({})
  assert.equal(r.state, 'signedOut')
  assert.ok(r.message && r.message.length <= 300)
  assert.deepEqual(r.items, [])
  await b.h.stop()
})

test('items, signed out after having mail: the last cached items still come', async () => {
  const b = await signedIn()
  assert.ok((await b.feed.items({})).items.length > 0)
  // An expired grant signs out but keeps the cache (the lanes empty, the cache stays for a re-sign-in).
  b.h.auth.status = () => ({ signedIn: false, signedOutReason: 'Your Google sign-in expired.' })
  const r = await b.feed.items({})
  assert.equal(r.state, 'signedOut')
  assert.equal(r.message, 'Your Google sign-in expired.')
  assert.ok(r.items.length > 0)
  await b.h.stop()
})

test('items, the last poll failed: state error with its message, the cached items still come', async () => {
  const b = await signedIn()
  b.h.S.error = 'Gmail said:\nboom'
  const r = await b.feed.items({})
  assert.equal(r.state, 'error')
  assert.equal(r.message, 'Gmail said: boom')
  assert.ok(r.items.length > 0)
  await b.h.stop()
})

test('items: with only noise left, the noise comes', async () => {
  const b = await signedIn({ gmail: { lists: { unread: [], alerts: [T.a1, T.a2], read: [] } } })
  const r = await b.feed.items({})
  assert.deepEqual(r.items.map((i) => [i.id, i.level]), [['alert:HighCPU', 'noise']])
  await b.h.stop()
})

test('items: a Jira mail carries its issue key; other mail has none', async () => {
  const b = await signedIn({ jira: true })
  const r = await b.feed.items({})
  assert.equal(r.items.find((i) => i.id === ID.jira).jiraKey, 'ABC-2')
  assert.ok(!('jiraKey' in r.items.find((i) => i.id === T.t1)))
  await b.h.stop()
})

test('items, triage off: every unread thread is fyi, still listed', async () => {
  const b = await signedIn({ triage: null })
  const r = await b.feed.items({})
  assert.ok(r.items.length > 0 && r.items.every((i) => i.level === 'fyi'))
  await b.h.stop()
})

test('markRead: the existing write path (the UNREAD label), the item leaves the feed, changed is emitted', async () => {
  const b = await signedIn()
  const before = b.ctx.emitted.length
  await b.feed.markRead(T.t1)
  await b.h.writesIdle()
  assert.deepEqual(b.gmail.state.modifies.map((m) => m.id), [T.t1])
  assert.deepEqual(b.gmail.state.modifies[0].body, { removeLabelIds: ['UNREAD'] })
  assert.ok(!(await b.feed.items({})).items.some((i) => i.id === T.t1))
  assert.ok(b.ctx.emitted.length > before)
  assert.deepEqual(b.ctx.emitted[b.ctx.emitted.length - 1], { name: 'inbox-feed', event: 'changed', data: {} })
  await b.h.stop()
})

test('markRead: a Gmail refusal is thrown as gmail: <why>, the item stays', async () => {
  const b = await signedIn({ gmail: { fail: { [`modify:${T.t1}`]: 500 } } })
  await assert.rejects(b.feed.markRead(T.t1), /^Error: gmail: /)
  assert.ok((await b.feed.items({})).items.some((i) => i.id === T.t1))
  await b.h.stop()
})

test('open and markRead with a bad id are refused before anything reaches Gmail', async () => {
  const b = await signedIn()
  const calls = b.gmail.calls.length
  for (const bad of [undefined, null, 5, {}, '', '../x', 'a/b', 'a?b=1', 'alert:', T.t3 + 'zz', 'ffffffffffffffff']) {
    await assert.rejects(b.feed.open(bad), /^Error: gmail: /, `open ${String(bad)}`)
    await assert.rejects(b.feed.markRead(bad), /^Error: gmail: /, `markRead ${String(bad)}`)
  }
  assert.equal(b.gmail.calls.length, calls)
  assert.deepEqual(b.gmail.state.modifies, [])
  await b.h.stop()
})

test('open: the thread opens the way a row click does (the plugin\'s reader page with no reviewer)', async () => {
  const b = await signedIn()
  await b.feed.open(T.t2)
  assert.ok(b.gmail.calls.some((c) => c.path.endsWith(`/threads/${T.t2}`) && /format=full/.test(c.url)), 'the thread was read in full')
  await b.h.stop()
})

test('changed is emitted after each poll', async () => {
  const b = await signedIn()
  const n = b.ctx.emitted.filter((e) => e.event === 'changed').length
  assert.ok(n >= 1, 'the sign-in poll')
  await b.h.pollNow('test', true)
  assert.ok(b.ctx.emitted.filter((e) => e.event === 'changed').length > n)
  assert.ok(b.ctx.emitted.every((e) => e.name === 'inbox-feed' && e.event === 'changed' && Object.keys(e.data).length === 0))
  await b.h.stop()
})

test('an app before 0.9.7 (services has no useAll, emit may be missing): still activates and provides; a throwing emit is harmless', async () => {
  const ctx = fakeCtx({ project: {}, triage: fakeTriage() })
  assert.equal(ctx.services.useAll, undefined)
  const exportsHost = require('../dist/host')
  exportsHost.activate(ctx)
  assert.ok(ctx.provided['inbox-feed'], 'provides without useAll')
  assert.deepEqual(await ctx.provided['inbox-feed'].describe(), { label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' })
  assert.equal((await ctx.provided['inbox-feed'].items({})).state, 'signedOut')
  await exportsHost.deactivate()
  const ctx2 = fakeCtx({ project: {}, triage: fakeTriage() })
  ctx2.services.emit = () => {
    throw new Error('no such service')
  }
  const h = host._start(ctx2, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
  await h.ready
  await h.pollNow('x')
  await h.stop()
})
