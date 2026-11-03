'use strict'
// Polling against the fake Gmail: the cheap history check, a full refresh on a change / every
// 10th poll / force / a 404, only changed threads read again, lane precedence, side-lane failures,
// and the view with its badge; then the triage items built from that view.
const test = require('node:test')
const assert = require('node:assert/strict')
const { poll, buildView, allRows, emptyCache, loadCache, FULL_EVERY, CONCURRENCY } = require('../dist/lib/poll')
const { createClient } = require('../dist/lib/client')
const { readSettings } = require('../dist/lib/settings')
const { triageItem, TO_TEXT } = require('../dist/lib/triage')
const { fakeGmail, tokens, ME, NOW, T } = require('./fakes')

function setup(opts = {}, settings = { alertSenders: ['alerts@example.com'] }) {
  const reg = tokens()
  reg.valid.add('tok')
  const g = fakeGmail({ tokens: reg, ...opts })
  const client = createClient({ getToken: async () => 'tok', invalidate: () => {}, fetch: g.fetch })
  const cfg = readSettings(settings).cfg
  const cache = emptyCache('c1')
  const run = (o = {}) => poll({ client, cfg, cache, now: NOW, ...o })
  const paths = () => g.calls.map((c) => c.path.replace('/gmail/v1/users/me', ''))
  return { g, client, cfg, cache, run, paths }
}

test('the first poll: profile, the three searches, every thread read with metadata', async () => {
  const s = setup()
  const r = await s.run()
  assert.equal(r.full, true)
  assert.equal(s.cache.account, ME)
  assert.equal(s.cache.historyId, '1000')
  const p = s.paths()
  assert.equal(p[0], '/profile')
  assert.equal(p.filter((x) => x === '/threads').length, 3)
  assert.equal(p.filter((x) => x.startsWith('/threads/')).length, 7)
  assert.ok(s.g.calls.filter((c) => c.path.includes('/threads/')).every((c) => new URL(c.url).searchParams.get('format') === 'metadata'))
  assert.deepEqual(s.cache.lists, { unread: [T.t1, T.t2, T.c1], alerts: [T.a1, T.a2, T.a3], read: [T.t3] })
  assert.equal(r.stats.fetched, 7)
})

test('no change: one history call, nothing else', async () => {
  const s = setup()
  await s.run()
  const n = s.g.calls.length
  const r = await s.run()
  assert.equal(r.full, false)
  assert.equal(r.changed, false)
  assert.deepEqual(s.paths().slice(n), ['/history'])
  assert.equal(s.cache.sinceFull, 1)
})

test('every 10th poll is a full refresh even without a change', async () => {
  const s = setup()
  await s.run()
  // The full poll and nine cheap ones: the tenth is full again.
  for (let k = 1; k < FULL_EVERY; k++) assert.equal((await s.run()).full, false)
  assert.equal((await s.run()).full, true)
  assert.equal(s.cache.sinceFull, 0)
})

test('a change: the searches again, only threads whose historyId moved are read', async () => {
  const s = setup()
  await s.run()
  s.g.state.historyId = '1010'
  s.g.threads[T.t2] = { ...s.g.threads[T.t2], historyId: '1009' }
  const n = s.g.calls.length
  const r = await s.run()
  assert.equal(r.full, true)
  assert.deepEqual(s.paths().slice(n).filter((p) => p.startsWith('/threads/')), [`/threads/${T.t2}`])
  assert.equal(s.cache.historyId, '1010')
  assert.equal(s.cache.threads[T.t2].historyId, '1009')
})

test('force skips the history check; a 404 from history is a full refresh with a note', async () => {
  const s = setup()
  await s.run()
  const n = s.g.calls.length
  await s.run({ force: true })
  assert.ok(!s.paths().slice(n).includes('/history'))
  // A start id Gmail no longer has (about a week old): history answers 404.
  const s2 = setup({ fail: { history: 404 } })
  s2.cache.account = ME
  s2.cache.lists = { unread: [], alerts: [], read: [] }
  s2.cache.historyId = '1'
  const r = await s2.run()
  assert.equal(r.full, true)
  assert.equal(r.stats.note, 'history too old')
  assert.equal(s2.cache.historyId, '1000', 'the new baseline from the profile')
})

test('a thread in two searches shows once: Alerts, then Unread, then Read', async () => {
  const s = setup({ lists: { unread: [T.t1, T.a1], alerts: [T.a1], read: [T.t1, T.t3] } })
  await s.run()
  assert.deepEqual(s.cache.lists, { unread: [T.t1], alerts: [T.a1], read: [T.t3] })
})

test('the Read lane leaves out threads whose newest message is from an alert sender, and keeps maxRead', async () => {
  const s = setup({ lists: { unread: [], alerts: [], read: [T.a3, T.t3, T.t1] } }, { alertSenders: ['alerts@example.com'], maxRead: 1 })
  await s.run()
  assert.deepEqual(s.cache.lists.read, [T.t3])
})

test('threads that left every search are dropped from the cache', async () => {
  const s = setup()
  await s.run()
  s.g.state.lists = { unread: [T.t1], alerts: [], read: [] }
  s.g.state.historyId = '1100'
  await s.run()
  assert.deepEqual(Object.keys(s.cache.threads), [T.t1])
})

test('a failed side search keeps that lane\'s last list; Unread, auth, scope and busy fail the poll', async () => {
  const fail = {}
  const s = setup({ fail })
  await s.run()
  fail['list:read'] = 400
  s.g.state.historyId = '1200'
  const r = await s.run()
  assert.match(r.laneErrors.read, /Gmail answered 400/)
  assert.deepEqual(s.cache.lists.read, [T.t3])
  for (const [route, status, kind] of [['list:unread', 400, 'http'], ['list:alerts', 403, 'scope'], ['list:read', 429, 'rate'], ['list:read', 503, 'server']]) {
    for (const k of Object.keys(fail)) delete fail[k]
    fail[route] = status
    s.g.state.historyId = String(Number(s.g.state.historyId) + 1)
    await assert.rejects(s.run(), (e) => e.kind === kind, route)
  }
})

test('a thread that cannot be read is left out and reported; busy thread reads mark the poll busy', async () => {
  const s = setup({ fail: { [`thread:${T.t2}`]: 500 } })
  const r = await s.run()
  assert.deepEqual(r.stats.threadErrors.map((e) => e.id), [T.t2])
  assert.ok(!s.cache.lists.unread.includes(T.t2))
  assert.equal(r.busy.kind, 'server')
  const n = setup({ fail: { [`thread:${T.t2}`]: 404 } })
  const r2 = await n.run()
  assert.equal(r2.busy, undefined)
})

test('thread reads run at most CONCURRENCY at once', async () => {
  let running = 0
  let peak = 0
  const s = setup({
    routes: async (u) => {
      if (!/\/threads\/./.test(u.pathname)) return null
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 3))
      running--
      return null
    },
  })
  await s.run()
  assert.equal(peak, CONCURRENCY)
})

test('loadCache keeps a cache only for the same client', () => {
  const c = { ...emptyCache('a'), account: ME, threads: { x: {} } }
  assert.equal(loadCache(c, 'a').account, ME)
  assert.equal(loadCache(c, 'b').account, null)
  assert.equal(loadCache(null, 'a').account, null)
  assert.equal(loadCache({ clientHash: 'a', threads: 'junk' }, 'a').account, null)
})

test('buildView: lanes, alert groups, sort by verdict then time, the badge counts real unread mail', async () => {
  const s = setup()
  await s.run()
  const v = buildView({ cfg: s.cfg, cache: s.cache, verdicts: { [T.t2]: { priority: 'urgent' } } })
  assert.deepEqual(v.lanes.map((l) => [l.id, l.rows.map((r) => r.id)]), [
    ['unread', [T.t2, T.t1]],
    ['alerts', ['alert:HighCPU', T.a3]],
    ['read', [T.t3]],
  ])
  assert.equal(v.unread, 2)
  assert.equal(allRows(v).length, 5)
  const g = v.lanes[1].rows[0]
  assert.equal(g.kind, 'alert')
  assert.equal(g.group.count, 3)
  assert.deepEqual(buildView({ cfg: s.cfg, cache: emptyCache('x') }), { lanes: [], unread: 0 })
  const off = buildView({ cfg: readSettings({ lanes: { read: false } }).cfg, cache: s.cache })
  assert.deepEqual(off.lanes.map((l) => l.id), ['unread'], 'no senders: no Alerts lane; Read off')
})

test('triage items: a thread with who, how addressed, context and the new message', async () => {
  const s = setup()
  await s.run()
  const v = buildView({ cfg: s.cfg, cache: s.cache })
  const row = v.lanes[0].rows.find((r) => r.id === T.t1)
  const it = triageItem(row, 'full', ME)
  assert.equal(it.id, T.t1)
  assert.deepEqual(it.fields, { from: 'ann@acme.com', to: 'Me <me@example.com>', lane: 'unread', list: '' })
  assert.equal(it.hint, undefined)
  const lines = it.text.split('\n')
  assert.equal(lines[0], 'Email from Ann Smith <ann@acme.com>, subject: Re: Q4 budget')
  assert.equal(lines[1], `Addressed to: ${TO_TEXT.to}`)
  assert.ok(lines.includes('Cc: Bob <bob@acme.com>'))
  assert.ok(lines.includes('The thread has 3 messages, from Ann Smith.'))
  assert.ok(lines.includes('Earlier in the thread (context only, do not judge these):'))
  assert.ok(lines.includes('  Me <me@example.com>: Sure, working on it.'))
  assert.equal(lines[lines.length - 2], 'New message to judge:')
  assert.match(lines[lines.length - 1], /^ {2}Ann Smith <ann@acme\.com>: Thanks! Also "the logo"/)
  assert.equal(triageItem(row, 'summary', ME).text, 'Email from Ann Smith <ann@acme.com>, subject: Re: Q4 budget')
  const news = triageItem(v.lanes[0].rows.find((r) => r.id === T.t2), 'full', ME)
  assert.match(news.text, /Mailing list: <weekly\.letters\.example>/)
  assert.equal(news.fields.list, '<weekly.letters.example>')
  const read = triageItem(v.lanes[2].rows[0], 'full', ME)
  assert.match(read.text, /Latest message \(already read\) to judge:/)
  assert.equal(read.fields.lane, 'read')
})

test('triage items: an alert group is hinted noise with its own field', async () => {
  const s = setup()
  await s.run()
  const v = buildView({ cfg: s.cfg, cache: s.cache })
  const it = triageItem(v.lanes[1].rows[0], 'full', ME)
  assert.equal(it.id, 'alert:HighCPU')
  assert.deepEqual(it.hint, { priority: 'noise' })
  assert.equal(it.fields.alert, 'HighCPU: node1, node2')
  assert.equal(it.fields.lane, 'alerts')
  assert.match(it.text, /^Email, Grafana alert 'HighCPU' from Grafana <alerts@example\.com>\n3 unread alert mails, resolved now, nodes: node1, node2\./)
  const plain = triageItem(v.lanes[1].rows[1], 'full', ME)
  assert.equal(plain.hint, undefined, 'a plain mail from the alert sender is judged by Jev')
  // Every item stays inside the triage limits.
  for (const r of allRows(v)) {
    const x = triageItem(r, 'full', ME)
    assert.ok(x.id.length >= 1 && x.id.length <= 256)
    assert.ok(x.text.length <= 8000)
    for (const val of Object.values(x.fields)) assert.ok(typeof val === 'string' && val.length <= 200)
  }
})
