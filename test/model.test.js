'use strict'
// Messages and threads as the cache keeps them, the row facts, and the Grafana alert grouping.
const test = require('node:test')
const assert = require('node:assert/strict')
const { header, parseAddress, parseAddressList, compactMessage, compactThread, threadFacts, addressedTo } = require('../dist/lib/model')
const { parseAlert, groupAlerts, groupTitle, MAX_NODES } = require('../dist/lib/alerts')
const { decode } = require('../dist/lib/entities')
const { fixture, ME, T } = require('./fakes')

const SENDERS = ['alerts@example.com']
const th = (k) => compactThread(fixture(`thread-${k}.json`))

test('header: any letter case, the first one, empty when absent', () => {
  const m = { payload: { headers: [{ name: 'subject', value: 'a' }, { name: 'Subject', value: 'b' }, { name: 'X', value: 1 }] } }
  assert.equal(header(m, 'SUBJECT'), 'a')
  assert.equal(header(m, 'X'), '')
  assert.equal(header({}, 'From'), '')
})

test('parseAddress and parseAddressList', () => {
  assert.deepEqual(parseAddress('"Smith, Ann" <Ann@Acme.com>'), { name: 'Smith, Ann', address: 'ann@acme.com' })
  assert.deepEqual(parseAddress('ann@acme.com'), { name: '', address: 'ann@acme.com' })
  assert.deepEqual(parseAddress('undisclosed-recipients:;'), { name: 'undisclosed-recipients:;', address: '' })
  assert.deepEqual(parseAddress('"A \\"Q\\" B" <a@b.c>'), { name: 'A "Q" B', address: 'a@b.c' })
  assert.deepEqual(parseAddressList('"Smith, Ann" <ann@acme.com>, bob@acme.com,  , Me <ME@example.com>').map((a) => a.address), ['ann@acme.com', 'bob@acme.com', 'me@example.com'])
  assert.equal(parseAddressList(Array.from({ length: 300 }, (_, k) => `a${k}@x.org`).join(',')).length, 200)
})

test('compactMessage: decoded snippet, unread from the label, cuts', () => {
  const m = compactMessage({ id: 'm1', internalDate: '1793689800000', labelIds: ['UNREAD', 'INBOX', 3], snippet: 'it&#39;s &amp; done', payload: { headers: [{ name: 'From', value: 'Ann <ann@acme.com>' }, { name: 'Subject', value: 'a\r\n b'.repeat(200) }, { name: 'List-Id', value: '<l.x.org>' }] } })
  assert.equal(m.snippet, "it's & done")
  assert.equal(m.unread, true)
  assert.deepEqual(m.labels, ['UNREAD', 'INBOX'])
  assert.ok(m.subject.length <= 300 && m.subject.endsWith('…'))
  assert.equal(m.at, 1793689800000)
  assert.equal(m.listId, '<l.x.org>')
  assert.equal(compactMessage({ id: 1, internalDate: 'x' }).at, 0)
})

test('compactThread: oldest first, Chat copies left out', () => {
  const t1 = th('t1')
  assert.equal(t1.id, T.t1)
  assert.deepEqual(t1.messages.map((m) => m.from), ['Ann Smith', 'Me', 'Ann Smith'])
  assert.ok(t1.messages.every((m, k) => !k || m.at >= t1.messages[k - 1].at))
  assert.deepEqual(th('c1').messages, [])
  assert.equal(compactThread({ id: 'x', messages: [null, { id: 'a', internalDate: '2' }, { id: 'b', internalDate: '1' }] }, 99).historyId, '99')
})

test('threadFacts: the newest unread message of others speaks for the thread', () => {
  const f = threadFacts(th('t1'), ME)
  assert.equal(f.lead.snippet, 'Thanks! Also "the logo" for the deck, it\'s attached.')
  assert.equal(f.subject, 'Re: Q4 budget')
  assert.equal(f.unread, true)
  assert.equal(f.unreadCount, 1)
  assert.equal(f.count, 3)
  assert.deepEqual(f.participants, ['Ann Smith'])
  assert.equal(threadFacts(th('c1'), ME), null)
  // Only my own messages: the newest of them.
  const mine = { messages: [{ address: ME, from: 'Me', subject: '', at: 1, unread: false }] }
  assert.equal(threadFacts(mine, ME).subject, '(no subject)')
})

test('addressedTo: To, Cc or neither', () => {
  const t = th('t1').messages
  assert.equal(addressedTo(t, ME), 'to')
  assert.equal(addressedTo(t, 'bob@acme.com'), 'cc')
  assert.equal(addressedTo(t, 'zed@x.org'), 'other')
  assert.equal(addressedTo(t, ''), 'unknown')
})

test('entities.decode: named, numeric, the unsafe code points', () => {
  assert.equal(decode('&lt;&gt;&amp;&quot;&#39;&nbsp;&hellip;&#x41;&#66;&unknown;&amp'), '<>&"\' …AB&unknown;&amp')
  assert.equal(decode('&#0;&#xD800;&#1114112;&#128;'), '���€')
})

test('parseAlert: Grafana subjects from an alert sender; the name from the body; node from nodename or the labels', () => {
  const [a1] = th('a1').messages
  assert.deepEqual(parseAlert(a1, SENDERS), { name: 'HighCPU', node: 'node1', resolved: false })
  const a2 = th('a2').messages
  assert.equal(parseAlert(a2[1], SENDERS).resolved, true)
  assert.equal(parseAlert(th('a3').messages[0], SENDERS), null, 'not an alert subject')
  assert.equal(parseAlert(a1, ['other@x.org']), null, 'not an alert sender')
  const m = (subject, snippet = '') => ({ address: 'alerts@example.com', subject, snippet })
  assert.deepEqual(parseAlert(m('[FIRING:2] DiskFull (prod)', 'nodename=db-1 job=x'), SENDERS), { name: 'DiskFull', node: 'db-1', resolved: false })
  assert.deepEqual(parseAlert(m('[firing] Plain name'), SENDERS), { name: 'Plain name', node: '', resolved: false })
  assert.deepEqual(parseAlert(m('[RESOLVED] X', '📁 Prod › Latency high 🔥'), SENDERS), { name: 'Latency high', node: '', resolved: true })
  assert.equal(parseAlert(m('[FIRING:1] (only labels)'), SENDERS), null)
  assert.equal(parseAlert(m('FIRING: no brackets'), SENDERS), null)
  assert.ok(parseAlert(m(`[FIRING] ${'n'.repeat(500)}`), SENDERS).name.length <= 200)
})

test('groupAlerts: one group per name across threads, nodes still firing, the newest decides resolved', () => {
  const { groups, plain } = groupAlerts([th('a1'), th('a2'), th('a3')], SENDERS)
  assert.equal(groups.length, 1)
  const g = groups[0]
  assert.equal(g.id, 'alert:HighCPU')
  assert.equal(g.count, 3)
  assert.equal(g.firing, 2)
  assert.equal(g.resolved, true)
  assert.deepEqual(g.nodes, ['node1', 'node2'])
  assert.deepEqual(g.threadIds, [T.a2, T.a1], 'newest first')
  assert.equal(g.latest.subject, '[RESOLVED:1] HighCPU Prod (node2 prod)')
  assert.deepEqual(plain.map((t) => t.id), [T.a3], 'a plain mail from the alert sender stays a row')
  assert.equal(groupTitle(g), 'HighCPU: node1, node2')
})

test('groupAlerts: while the newest fires, only the nodes still firing are named', () => {
  const { groups } = groupAlerts([th('a1'), th('a2')].map((t) => ({ ...t, messages: t.messages.filter((m) => !/RESOLVED/.test(m.subject)) })), SENDERS)
  assert.deepEqual(groups[0].nodes, ['node1', 'node2'])
  const resolvedOne = groupAlerts([th('a2'), { id: 'z', messages: [{ ...th('a1').messages[0], at: 1 }] }], SENDERS).groups[0]
  assert.equal(resolvedOne.resolved, true)
  const later = { id: 'later', messages: [{ ...th('a1').messages[0], at: Date.parse('2026-12-01') }] }
  const g = groupAlerts([th('a2'), later], SENDERS).groups[0]
  assert.equal(g.resolved, false)
  assert.deepEqual(g.nodes, ['node1'], 'node2 resolved, node1 fires')
  assert.equal(groupTitle({ name: 'X', nodes: [] }), 'X')
})

test('groupAlerts: a thread with any unread message that is not an alert is a plain row; read messages do not count', () => {
  const mixed = { id: 'm', messages: [...th('a1').messages, { ...th('a3').messages[0], at: 9e12 }] }
  assert.deepEqual(groupAlerts([mixed], SENDERS).plain.map((t) => t.id), ['m'])
  const read = { id: 'r', messages: th('a1').messages.map((m) => ({ ...m, unread: false })) }
  const r = groupAlerts([read], SENDERS)
  assert.deepEqual([r.groups.length, r.plain.length], [0, 1])
  assert.deepEqual(groupAlerts([{ id: 'e', messages: [] }], SENDERS), { groups: [], plain: [] })
})

test('groupAlerts: at most MAX_NODES nodes named', () => {
  const many = Array.from({ length: 15 }, (_, k) => ({ id: `n${k}`, messages: [{ address: 'alerts@example.com', subject: `[FIRING:1] Up (n${String(k).padStart(2, '0')})`, snippet: '', unread: true, at: k }] }))
  const g = groupAlerts(many, SENDERS).groups[0]
  assert.equal(g.nodes.length, MAX_NODES)
  assert.equal(g.count, 15)
})
