'use strict'
// The `inbox-feed` service (v2, 0.5.0): the pure mapping (fields, labels, caps, alert threads, the
// diff), the host's snapshot from its cache in each state, act with a foreign id or an action the
// item lacks, the item / gone / sync events after a poll, a mark, a sign-in and an error, and an app
// without `useAll`, `slots` or `overlay.buttons` (an older app).
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const F = require('../dist/lib/feed')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, fakeJiraService, tokens, fixture, NOW, T, ME } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))

// ---- lib/feed.js ----

const msgOf = (o) => ({ id: 'm0', address: 'ann@example.com', from: 'Ann Smith', to: `Me <${ME}>`, cc: '', subject: 'Hello', snippet: '', unread: true, at: NOW, labels: ['INBOX', 'UNREAD'], ...o })
function thread(id, o = {}) {
  return { id, messages: [msgOf({ id: 'm1', ...o.first }), msgOf({ id: 'newest', ...o.latest })] }
}
const threadRow = (id, o = {}) => ({ id, kind: 'thread', lane: o.lane || 'unread', at: NOW, unread: true, verdict: null, thread: thread(id, o) })

test('threadItem: every field of the contract; rev is the newest message, from the lead', () => {
  const t = thread('t1', { first: { subject: 'Re: Q4   budget', from: 'Ann Smith' }, latest: { subject: 'Re: Q4   budget', from: 'Ann Smith', id: 'm9', snippet: 'See  the\nnumbers', at: NOW - 5, labels: ['INBOX', 'UNREAD', 'IMPORTANT', 'STARRED', 'CATEGORY_UPDATES', 'Label_7', 'SENT'] } })
  const it = F.threadItem(t, { me: ME, labelNames: { Label_7: 'Projects/Q4' } })
  assert.deepEqual(it, {
    id: 't1',
    rev: 'm9',
    title: 'Re: Q4 budget',
    time: NOW - 5,
    read: false,
    place: { kind: 'folder', name: 'Inbox' },
    actions: [{ id: 'open', label: 'Open' }, { id: 'markRead', label: 'Mark read' }],
    preview: 'See the numbers',
    from: { name: 'Ann Smith', address: 'ann@example.com' },
    to: 'direct',
    labels: ['important', 'starred', 'category:updates', 'Projects/Q4'],
  })
})

test('threadItem: a read thread offers markUnread; to is direct, cc or group; unknown without the person\'s address', () => {
  const read = thread('t', { first: { unread: false }, latest: { unread: false } })
  const it = F.threadItem(read, { me: ME })
  assert.equal(it.read, true)
  assert.deepEqual(it.actions.map((a) => a.id), ['open', 'markUnread'])
  assert.equal(F.threadItem(thread('t', { latest: { to: 'Bob <bob@example.com>', cc: ME } }), { me: ME }).to, 'cc')
  assert.equal(F.threadItem(thread('t', { latest: { to: 'list@example.com' } }), { me: ME }).to, 'group')
  assert.ok(!('to' in F.threadItem(thread('t'), { me: '' })))
  assert.ok(!('mentionsMe' in it))
  assert.equal(F.threadItem({ id: 'x', messages: [] }), null)
})

test('threadItem: caps (title 300, preview 1000, name 120, labels 20 of 40), unknown user labels dropped, jira and alert labels added, no duplicates', () => {
  const ids = Array.from({ length: 30 }, (_, k) => `Label_${k}`)
  const names = Object.fromEntries(ids.map((id, k) => [id, `${k % 2 ? 'x' : 'y'}`.repeat(60) + k]))
  const t = thread('t', { first: { subject: 's'.repeat(1000), from: 'f'.repeat(500) }, latest: { snippet: 'p'.repeat(5000), labels: [...ids, 'Label_unknown'] } })
  const it = F.threadItem(t, { me: ME, labelNames: names, jiraKeys: new Map([['t', 'ABC-2']]), alert: 'HighCPU' })
  assert.ok(it.title.length <= 300 && it.preview.length <= 1000 && it.from.name.length <= 120)
  assert.ok(it.labels.length <= 20 && it.labels.every((l) => l.length >= 1 && l.length <= 40))
  const small = F.threadItem(thread('t', { latest: { labels: ['INBOX', 'IMPORTANT', 'UNREAD'] } }), { me: ME, jiraKeys: new Map([['t', 'ABC-2']]), alert: 'HighCPU' })
  assert.deepEqual(small.labels, ['important', 'alert', 'alert:HighCPU', 'jira:ABC-2'])
  assert.deepEqual(F.threadItem(thread('t'), { me: ME, alert: true }).labels, ['alert'])
})

test('feedItems: threads of every lane, an alert group as one item per thread, newest first, deduplicated, limit cuts', () => {
  const group = { id: 'alert:HighCPU', name: 'HighCPU', threadIds: ['a1', 'a2'] }
  const rows = [
    threadRow('old', { latest: { at: 1 } }),
    threadRow('read', { lane: 'read', first: { unread: false }, latest: { unread: false, at: 50 } }),
    { id: group.id, kind: 'alert', lane: 'alerts', at: NOW, unread: true, group },
    threadRow('plain-alert', { lane: 'alerts', latest: { at: 7 } }),
  ]
  const threads = { a1: thread('a1', { latest: { at: 100 } }), a2: thread('a2', { latest: { at: 90 } }), gone: thread('gone') }
  const out = F.feedItems(rows, { me: ME, threads })
  assert.deepEqual(out.map((i) => i.id), ['a1', 'a2', 'read', 'plain-alert', 'old'])
  assert.deepEqual(out[0].labels, ['alert', 'alert:HighCPU'])
  assert.deepEqual(out[3].labels, ['alert'])
  assert.equal(out[2].read, true)
  assert.equal(F.feedItems(rows, { me: ME, threads, limit: 2 }).length, 2)
  assert.deepEqual(F.feedItems([rows[0], rows[0]], { me: ME }).length, 1)
  // `only`: the same item as in the whole list, nothing else built.
  assert.deepEqual(F.feedItems(rows, { me: ME, threads, only: 'a2' }), [out[1]])
  assert.deepEqual(F.feedItems(rows, { me: ME, threads, only: 'nope' }), [])
  const noThread = F.feedItems([rows[2]], { me: ME, threads: {} })
  assert.deepEqual(noThread, [])
  assert.equal(F.feedItems(Array.from({ length: 1200 }, (_, k) => threadRow(`t${k}`, { latest: { at: k + 1 } })), { me: ME }).length, 1000)
})

test('diffFeed: new and changed (each field) are items, missing ids are gone, a no-op is nothing', () => {
  const base = F.threadItem(thread('t', { latest: { snippet: 'a' } }), { me: ME })
  const other = F.threadItem(thread('u'), { me: ME })
  assert.deepEqual(F.diffFeed([base, other], [base, other]), { items: [], gone: [] })
  assert.deepEqual(F.diffFeed([], [base]), { items: [base], gone: [] })
  assert.deepEqual(F.diffFeed(new Map([['t', base], ['u', other]]), [base]), { items: [], gone: ['u'] })
  const changes = [
    (i) => ({ ...i, rev: 'zz' }),
    (i) => ({ ...i, title: 'new' }),
    (i) => ({ ...i, preview: 'new' }),
    (i) => ({ ...i, time: i.time + 1 }),
    (i) => ({ ...i, read: !i.read }),
    (i) => ({ ...i, to: 'cc' }),
    (i) => ({ ...i, labels: ['starred'] }),
    (i) => ({ ...i, from: { name: 'Bob' } }),
    (i) => ({ ...i, actions: [{ id: 'open', label: 'Open' }] }),
    (i) => ({ ...i, place: { kind: 'folder', name: 'Other' } }),
  ]
  for (const mutate of changes) {
    const next = mutate(base)
    assert.deepEqual(F.diffFeed([base], [next]), { items: [next], gone: [] })
  }
  // key order does not matter
  const reordered = Object.fromEntries(Object.entries(base).reverse())
  assert.deepEqual(F.diffFeed([base], [reordered]).items, [])
})

test('goneChunks: at most 500 ids to an event', () => {
  assert.deepEqual(F.goneChunks([]), [])
  assert.deepEqual(F.goneChunks(Array.from({ length: 1001 }, (_, k) => String(k))).map((c) => c.length), [500, 500, 1])
})

test('scopeLine: from the settings, a hidden lane left out, at most 120 characters', () => {
  assert.equal(F.scopeLine({ lanes: { unread: true, alerts: true, read: true }, unreadDays: 14, readDays: 2, alertSenders: [] }), 'unread of the last 14 days + read of the last 2 days')
  assert.equal(F.scopeLine({ lanes: { unread: true, read: false }, unreadDays: 3, readDays: 2, alertSenders: [] }), 'unread of the last 3 days')
  assert.equal(F.scopeLine({ lanes: { unread: false, alerts: false, read: true }, unreadDays: 3, readDays: 2, alertSenders: [] }), 'read of the last 2 days')
  assert.match(F.scopeLine({ lanes: { unread: false, alerts: false, read: false }, unreadDays: 3, readDays: 2 }), /^nothing/)
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
  const ctx = fakeCtx({ project: { alertSenders: ['alerts@example.com'], ...(opts.project || {}) }, oauth: fakeOAuth(reg), triage: opts.triage === undefined ? fakeTriage() : opts.triage, jira: opts.jira ? fakeJiraService({ issues: { 'ABC-2': { mine: true, done: false } } }) : null, reviewer: opts.reviewer })
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


const lastOf = (b, ev) => b.ctx.emitted.filter((e) => e.event === ev)
const events = (b) => b.ctx.emitted.filter((e) => e.name === 'inbox-feed')

test('the plugin provides inbox-feed v2 with the contract\'s methods and describes itself with its scope', async () => {
  const { feed, h } = boot({ project: { unreadDays: 7, readDays: 3 } })
  assert.deepEqual(Object.keys(feed).sort(), ['act', 'describe', 'features', 'snapshot'])
  assert.deepEqual(await feed.describe(), { label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail', scope: 'unread of the last 7 days + read of the last 3 days' })
  assert.deepEqual(await feed.features(), [])
  await h.stop()
})

test('snapshot, signed in: the unread and read threads and the alert threads from the cache, no API call, plain data', async () => {
  const { feed, gmail, h } = await signedIn()
  const calls = gmail.calls.length
  const r = await feed.snapshot()
  assert.equal(gmail.calls.length, calls, 'answered from the cache')
  assert.equal(r.state, 'ok')
  assert.equal(r.message, undefined)
  assert.equal(r.asOf, NOW)
  assert.deepEqual(r, structuredClone(r))
  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]))
  for (const id of [T.t1, T.t2, T.t3, T.a1, T.a2, T.a3]) assert.ok(byId[id], id)
  assert.ok(!('alert:HighCPU' in byId), 'no alert groups in the feed')
  assert.equal(byId[T.t1].rev, '18f0a1b2c3d4e503', 'the newest message of the thread')
  assert.equal(byId[T.t1].title, 'Re: Q4 budget')
  assert.equal(byId[T.t1].from.name, 'Ann Smith')
  assert.equal(byId[T.t1].to, 'direct')
  assert.equal(byId[T.t1].read, false)
  assert.deepEqual(byId[T.t1].place, { kind: 'folder', name: 'Inbox' })
  assert.ok(byId[T.t1].labels.includes('important'))
  assert.equal(byId[T.t3].read, true)
  assert.deepEqual(byId[T.t3].actions.map((a) => a.id), ['open', 'markUnread'])
  assert.ok(byId[T.a1].labels.includes('alert') && byId[T.a1].labels.some((l) => l.startsWith('alert:')))
  assert.ok(!byId[T.t1].labels.includes('alert'))
  assert.ok(r.items.every((i) => i.time > 0))
  assert.deepEqual(r.items.map((i) => i.time), [...r.items.map((i) => i.time)].sort((a, b) => b - a))
  await h.stop()
})

test('snapshot: user label names are read once a poll ends and join the labels', async () => {
  const b = await signedIn()
  await until(() => b.h.S.labels)
  const t1 = (await b.feed.snapshot()).items.find((i) => i.id === T.t1)
  assert.ok(t1.labels.length >= 2, 'a user label by name next to important')
  await b.h.stop()
})

test('snapshot: a hidden Read lane leaves the read thread out; Jira mail carries jira:KEY', async () => {
  const hidden = await signedIn({ project: { lanes: { read: false } } })
  assert.ok(!(await hidden.feed.snapshot()).items.some((i) => i.id === T.t3))
  await hidden.h.stop()
  const b = await signedIn({ jira: true })
  const it = (await b.feed.snapshot()).items.find((i) => i.id === ID.jira)
  assert.ok(it.labels.includes('jira:ABC-2'))
  await b.h.stop()
})

test('snapshot, not set up or signed out: state signedOut with a message and no items', async () => {
  const b = boot()
  await b.h.ready
  const r = await b.feed.snapshot()
  assert.equal(r.state, 'signedOut')
  assert.ok(r.message && r.message.length <= 300)
  assert.deepEqual(r.items, [])
  await b.h.stop()
})

test('snapshot, signed out after having mail: the last cached items still come; a failed poll gives error with them', async () => {
  const b = await signedIn()
  b.h.S.error = 'Gmail said:\nboom'
  const e = await b.feed.snapshot()
  assert.equal(e.state, 'error')
  assert.equal(e.message, 'Gmail said: boom')
  assert.ok(e.items.length > 0)
  b.h.S.error = null
  b.h.auth.status = () => ({ signedIn: false, signedOutReason: 'Your Google sign-in expired.' })
  const r = await b.feed.snapshot()
  assert.equal(r.state, 'signedOut')
  assert.equal(r.message, 'Your Google sign-in expired.')
  assert.ok(r.items.length > 0)
  await b.h.stop()
})

test('act refuses a foreign id, a bad argument and an action the item lacks; nothing reaches Gmail', async () => {
  const b = await signedIn()
  const calls = b.gmail.calls.length
  for (const bad of [undefined, null, 5, {}, '', '../x', 'alert:HighCPU', 'ffffffffffffffff']) {
    const r = await b.feed.act(bad, 'markRead')
    assert.equal(r.ok, false, String(bad))
    assert.match(r.message, /^gmail: /)
  }
  assert.equal((await b.feed.act(T.t1, 'markUnread')).ok, false, 'an unread thread has no markUnread')
  assert.equal((await b.feed.act(T.t3, 'markRead')).ok, false, 'a read thread has no markRead')
  assert.equal((await b.feed.act(T.t1, 'done')).ok, false)
  assert.equal((await b.feed.act(T.t1, 7)).ok, false)
  assert.equal(b.gmail.calls.length, calls)
  assert.deepEqual(b.gmail.state.modifies, [])
  await b.h.stop()
})

test('act markRead: the existing write path (the UNREAD label), then the item is read; markUnread brings it back', async () => {
  const b = await signedIn()
  const r = await b.feed.act(T.t1, 'markRead')
  assert.deepEqual(r, { ok: true })
  await b.h.writesIdle()
  assert.deepEqual(b.gmail.state.modifies.map((m) => m.id), [T.t1])
  assert.deepEqual(b.gmail.state.modifies[0].body, { removeLabelIds: ['UNREAD'] })
  const it = (await b.feed.snapshot()).items.find((i) => i.id === T.t1)
  assert.equal(it.read, true)
  assert.deepEqual(it.actions.map((a) => a.id), ['open', 'markUnread'])
  assert.deepEqual(await b.feed.act(T.t3, 'markUnread'), { ok: true })
  await b.h.writesIdle()
  assert.deepEqual(b.gmail.state.modifies[1].body, { addLabelIds: ['UNREAD'] })
  await b.h.stop()
})

test('act markRead on a thread of an alert group works (the thread is its own item)', async () => {
  const b = await signedIn()
  assert.deepEqual(await b.feed.act(T.a1, 'markRead'), { ok: true })
  await b.h.writesIdle()
  assert.deepEqual(b.gmail.state.modifies.map((m) => m.id), [T.a1])
  await b.h.stop()
})

test('act: a Gmail refusal comes back as { ok: false, message } and the item stays unread', async () => {
  const b = await signedIn({ gmail: { fail: { [`modify:${T.t1}`]: 500 } } })
  const r = await b.feed.act(T.t1, 'markRead')
  assert.equal(r.ok, false)
  assert.ok(r.message.length > 0 && r.message.length <= 300)
  assert.equal((await b.feed.snapshot()).items.find((i) => i.id === T.t1).read, false)
  await b.h.stop()
})

test('act open: the thread opens the way a row click does (the plugin\'s reader page with no reviewer)', async () => {
  const b = await signedIn()
  assert.deepEqual(await b.feed.act(T.t2, 'open'), { ok: true })
  // act answers once the open has started: the read goes on after it.
  await until(() => b.gmail.calls.some((c) => c.path.endsWith(`/threads/${T.t2}`) && /format=full/.test(c.url)))
  await until(() => b.ctx.overlays.some((o) => o.posts.some((m) => m.type === 'doc')))
  await b.h.writesIdle()
  assert.deepEqual(b.gmail.state.modifies, [], 'opening marks nothing read')
  await b.h.stop()
})

test('act open settles once the reader is up, not when the person closes it; a later failure is a notice', async () => {
  const b = await signedIn()
  // Our own reader page stays open (its result never settles), as it does until the person closes it.
  const start = b.ctx.overlay.start
  b.ctx.overlay.start = (spec) => ({ ...start(spec), result: new Promise(() => {}) })
  const late = new Promise((r) => setTimeout(() => r('late'), 1000))
  assert.deepEqual(await Promise.race([b.feed.act(T.t2, 'open'), late]), { ok: true })
  await until(() => b.ctx.overlays.some((o) => o.posts.some((m) => m.type === 'doc')))
  // The thread read fails after the reader started (gone at Google): act already answered ok, the panel says why.
  delete b.gmail.threads[T.t1]
  assert.deepEqual(await b.feed.act(T.t1, 'open'), { ok: true })
  await until(() => b.h.S.notice && b.h.S.notice.kind === 'error')
  assert.match(b.h.S.notice.text, /^Could not open the mail: /)
  await b.h.stop()
})

// Round-2 review: act answered ok before anything was on screen, so a failed read went only to this
// panel's notice and Inbox ended the item's "back" mark for an open the person never saw.
test('act open with nothing on screen yet (a reviewer without prepare, or a prepare that failed): a failed read is the act\'s refusal', async () => {
  const annotated = []
  const reviewers = {
    'no prepare': { annotate: async (s) => (annotated.push(s.key), { opened: true }) },
    'prepare failed': {
      prepare: async () => {
        throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
      },
      cancel: async () => ({ closed: false }),
      annotate: async (s) => (annotated.push(s.key), { opened: true }),
    },
  }
  for (const [name, reviewer] of Object.entries(reviewers)) {
    const b = await signedIn({ reviewer })
    delete b.gmail.threads[T.t1]
    const r = await b.feed.act(T.t1, 'open')
    assert.equal(r.ok, false, name)
    assert.match(r.message, /^gmail: /, name)
    assert.equal(b.ctx.overlays.length, 0, `${name}: no reader page either`)
    // The same reviewer opens a thread that can be read: ok once the reviewer's overlay is filled.
    assert.deepEqual(await b.feed.act(T.t2, 'open'), { ok: true }, name)
    assert.deepEqual(annotated.splice(0), [`gmail:${T.t2}`], name)
    await b.h.stop()
  }
})

// Round-3 review: an open that ended without anything on screen (the reviewer refused the mail, or
// the app refused the reader page) set the panel's notice and returned, and act still answered ok.
test('act open: a reviewer (without prepare) refusing the mail is the act\'s refusal, with the notice\'s text', async () => {
  const reviewer = {
    annotate: async () => {
      throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
    },
  }
  const b = await signedIn({ reviewer })
  const r = await b.feed.act(T.t2, 'open')
  assert.equal(r.ok, false)
  assert.match(r.message, /^gmail: The reviewer could not open the mail: .*at most 3 open/)
  assert.equal(b.h.S.notice.kind, 'error', 'the panel says it too')
  assert.equal(b.ctx.overlays.length, 0)
  await b.h.stop()
})

test('act open: the app refusing our reader page is the act\'s refusal, with the notice\'s text', async () => {
  const b = await signedIn()
  b.ctx.overlay.start = () => {
    throw new Error('overlay: at most 3 open')
  }
  const r = await b.feed.act(T.t2, 'open')
  assert.equal(r.ok, false)
  assert.match(r.message, /^gmail: Cannot open the reader: overlay: at most 3 open/)
  await b.h.stop()
})

test('sync: after activate\'s first cached view (signed out here), carrying the state', async () => {
  const b = boot()
  await b.h.ready
  await until(() => lastOf(b, 'sync').length)
  const s = lastOf(b, 'sync')[0]
  assert.equal(s.name, 'inbox-feed')
  assert.equal(s.data.state, 'signedOut')
  assert.deepEqual(s.data.items, [])
  await b.h.stop()
})

test('sync after a sign-in, then items after a poll: the new list is a sync once, then only diffs', async () => {
  const b = await signedIn()
  await b.h.pollNow('test', true)
  const syncs = lastOf(b, 'sync')
  assert.ok(syncs.length >= 2, 'start and the sign-in')
  assert.equal(syncs[0].data.state, 'signedOut')
  assert.equal(syncs[syncs.length - 1].data.state, 'ok')
  assert.ok(lastOf(b, 'item').some((e) => e.data.id === T.t1), 'the first poll\'s threads come as items')
  const n = b.ctx.emitted.length
  await b.h.pollNow('test', true)
  await until(() => true)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(b.ctx.emitted.length, n, 'a no-op poll emits nothing')
  await b.h.stop()
})

test('a mark emits an item with the new read state; a thread leaving the scope is gone', async () => {
  const b = await signedIn()
  await new Promise((r) => setTimeout(r, 30))
  const before = b.ctx.emitted.length
  await b.feed.act(T.t1, 'markRead')
  await b.h.writesIdle()
  await new Promise((r) => setTimeout(r, 30))
  const evs = b.ctx.emitted.slice(before)
  const item = evs.find((e) => e.event === 'item' && e.data.id === T.t1)
  assert.ok(item, 'item event')
  assert.equal(item.data.read, true)
  // an alert thread marked read leaves the Alerts lane: gone
  await b.feed.act(T.a3, 'markRead')
  await b.h.writesIdle()
  await new Promise((r) => setTimeout(r, 30))
  const gone = lastOf(b, 'gone')
  assert.ok(gone.some((e) => e.data.ids.includes(T.a3)))
  assert.ok(events(b).every((e) => ['item', 'gone', 'sync'].includes(e.event)), 'no changed event any more')
  await b.h.stop()
})

test('an error is a sync with state error, its recovery a sync with ok', async () => {
  const b = await signedIn()
  await new Promise((r) => setTimeout(r, 30))
  const n = lastOf(b, 'sync').length
  b.h.S.error = 'boom'
  await b.feed.act(T.t1, 'markRead')
  await b.h.writesIdle()
  await new Promise((r) => setTimeout(r, 30))
  const err = lastOf(b, 'sync')[n]
  assert.equal(err.data.state, 'error')
  assert.equal(err.data.message, 'boom')
  assert.ok(err.data.items.length > 0, 'the last known list comes with it')
  await b.h.pollNow('test', true)
  await new Promise((r) => setTimeout(r, 30))
  const syncs = lastOf(b, 'sync')
  assert.equal(syncs[syncs.length - 1].data.state, 'ok')
  await b.h.stop()
})

test('an app before 0.9.7 (services has no useAll, emit may be missing): still activates and provides; a throwing emit is harmless', async () => {
  const ctx = fakeCtx({ project: {}, triage: fakeTriage() })
  assert.equal(ctx.services.useAll, undefined)
  assert.equal(ctx.slots, undefined)
  assert.equal(ctx.overlay.buttons, undefined)
  const exportsHost = require('../dist/host')
  exportsHost.activate(ctx)
  assert.ok(ctx.provided['inbox-feed'], 'provides without useAll')
  assert.equal((await ctx.provided['inbox-feed'].describe()).label, 'Mail')
  assert.equal((await ctx.provided['inbox-feed'].snapshot()).state, 'signedOut')
  await exportsHost.deactivate()
  const ctx2 = fakeCtx({ project: {}, triage: fakeTriage() })
  ctx2.services.emit = () => {
    throw new Error('no such service')
  }
  const h = host._start(ctx2, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
  await h.ready
  await h.pollNow('x')
  await h.stop()
  const ctx3 = fakeCtx({ project: {}, triage: fakeTriage() })
  delete ctx3.services.emit
  const h3 = host._start(ctx3, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
  await h3.ready
  await h3.pollNow('x')
  await h3.stop()
})
