'use strict'
// The small pure parts: util, settings, the searches, the client file, lane order.
const test = require('node:test')
const assert = require('node:assert/strict')
const { cut, oneLine, mapLimit, hashOf, sha, ago, gmailId, rowId, emailAddress } = require('../dist/lib/util')
const { readSettings, alertsOn } = require('../dist/lib/settings')
const { queries, fromAny, alertSearch } = require('../dist/lib/query')
const { parseClientFile, checkClientId, checkClientSecret, oauthSpec, shortClientId, AUTH_URL, TOKEN_URL, SCOPE } = require('../dist/lib/oauth-client')
const { sortRows } = require('../dist/lib/lanes')
const { fixture, CLIENT_ID, CLIENT_SECRET } = require('./fakes')

test('cut and oneLine', () => {
  assert.equal(cut('hello', 5), 'hello')
  assert.equal(cut('hello world', 6), 'hello…')
  assert.equal(cut(null, 3), '')
  assert.equal(oneLine(' a\n\tb  c '), 'a b c')
})

test('mapLimit runs at most `limit` at once, keeps the order, and one failure fails nothing else', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 2))
    running--
    if (n === 5) throw new Error('five')
    return n * 2
  })
  assert.equal(peak, 4)
  assert.deepEqual(out.map((r) => (r.ok ? r.value : r.error.message)), [2, 4, 6, 8, 'five', 12, 14, 16, 18])
  assert.deepEqual(await mapLimit([], 4, async () => 1), [])
})

test('hashes are stable and short', () => {
  assert.equal(hashOf({ a: 1 }), hashOf({ a: 1 }))
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }))
  assert.match(sha('x'), /^[a-f0-9]{12}$/)
  assert.match(sha('x', 16), /^[a-f0-9]{16}$/)
})

test('ago', () => {
  assert.equal(ago(0), 'never')
  assert.equal(ago(1000, 31000), '30 s ago')
  assert.equal(ago(0 + 1, 1 + 5 * 60000), '5 min ago')
  assert.equal(ago(1, 1 + 3 * 3600000), '3 h ago')
})

test('gmailId and rowId let nothing through that could change a URL path', () => {
  assert.equal(gmailId('18f0a1b2c3d4e5f1'), '18f0a1b2c3d4e5f1')
  for (const bad of ['', '../x', 'a/b', 'a?b', 'a#b', 'a b', 'a%2fb', 'x'.repeat(65), null]) assert.equal(gmailId(bad), null, String(bad))
  assert.deepEqual(rowId('18f0a1b2c3d4e5f1'), { thread: '18f0a1b2c3d4e5f1' })
  assert.deepEqual(rowId('alert:HighCPU'), { alert: 'HighCPU' })
  for (const bad of ['alert:', 'alert: ', 'alert:a\nb', `alert:${'x'.repeat(201)}`, '/etc']) assert.equal(rowId(bad), null, bad)
})

test('emailAddress lower-cases and refuses search syntax', () => {
  assert.equal(emailAddress(' Alerts@Example.COM '), 'alerts@example.com')
  for (const bad of ['no-at', 'a@b', 'a b@x.org', 'a@x.org OR from:b', '{a@x.org}', 'a"@x.org', 'a@x.org)', '(a@x.org', 'a@x/y.org', '']) assert.equal(emailAddress(bad), null, bad)
})

test('readSettings: defaults, clamps, lane switches, alert senders checked in code', () => {
  const { cfg, problems } = readSettings({})
  assert.deepEqual(cfg, { clientId: '', clientSecret: '', lanes: { unread: true, alerts: true, read: true }, alertSenders: [], rowsPerLane: 10, unreadDays: 14, maxUnread: 15, readDays: 2, maxRead: 10, pollMinutes: 2, triageText: 'full' })
  assert.deepEqual(problems, [])
  const r = readSettings({ clientId: 'nope', maxUnread: 1000, pollMinutes: 0, readDays: 'x', lanes: { read: false, unread: 'yes' }, alertSenders: ['A@x.org', 'a@x.org', '', 'bad one', 7], triageText: 'summary' })
  assert.equal(r.cfg.clientId, '')
  assert.equal(r.cfg.maxUnread, 100)
  assert.equal(r.cfg.pollMinutes, 1)
  assert.equal(r.cfg.readDays, 2)
  assert.deepEqual(r.cfg.lanes, { unread: true, alerts: true, read: false })
  assert.deepEqual(r.cfg.alertSenders, ['a@x.org'])
  assert.equal(r.cfg.triageText, 'summary')
  assert.equal(r.problems.length, 3)
  assert.match(r.problems[0], /^clientId: a Google client id ends in/)
  assert.match(r.problems[1], /"bad one" is not an email address/)
  assert.equal(readSettings({ clientId: CLIENT_ID }).cfg.clientId, CLIENT_ID)
})

test('alertsOn needs the switch and a sender', () => {
  assert.equal(alertsOn(readSettings({}).cfg), false)
  assert.equal(alertsOn(readSettings({ alertSenders: ['a@x.org'] }).cfg), true)
  assert.equal(alertsOn(readSettings({ alertSenders: ['a@x.org'], lanes: { alerts: false } }).cfg), false)
})

test('queries: the three searches of the design', () => {
  const q = queries(readSettings({ alertSenders: ['alerts@example.com', 'grafana@x.org'] }).cfg)
  assert.deepEqual(q, {
    unread: { q: 'is:unread -in:spam -in:trash newer_than:14d -from:alerts@example.com -from:grafana@x.org', cap: 15 },
    alerts: { q: 'is:unread -in:spam -in:trash newer_than:14d {from:alerts@example.com from:grafana@x.org}', cap: 100 },
    read: { q: '-is:unread in:inbox newer_than:2d', cap: 20 },
  })
  assert.deepEqual(Object.keys(queries(readSettings({}).cfg)), ['unread', 'read'], 'no senders: no Alerts search')
  assert.deepEqual(Object.keys(queries(readSettings({ lanes: { unread: false, read: false } }).cfg)), [])
  assert.equal(queries(readSettings({ maxRead: 100 }).cfg).read.cap, 200)
  assert.equal(queries(readSettings({ alertSenders: ['a@x.org'] }).cfg).alerts.q, 'is:unread -in:spam -in:trash newer_than:14d from:a@x.org')
  assert.equal(fromAny(['a@x.org']), 'from:a@x.org')
  assert.equal(alertSearch(['a@x.org'], 'High "CPU"'), 'from:a@x.org subject:"High  CPU "')
})

test('parseClientFile: the downloaded Desktop client', () => {
  const r = parseClientFile(JSON.stringify(fixture('client_secret.json')))
  assert.deepEqual(r, { ok: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  const v2 = fixture('client_secret.json')
  v2.installed.auth_uri = 'https://accounts.google.com/o/oauth2/v2/auth'
  v2.installed.token_uri = 'https://www.googleapis.com/oauth2/v4/token'
  assert.equal(parseClientFile(JSON.stringify(v2)).ok, true)
})

test('parseClientFile: every wrong file gets its own reason, and no error quotes the secret', () => {
  const good = fixture('client_secret.json')
  const variant = (f) => {
    const c = structuredClone(good)
    f(c.installed, c)
    return JSON.stringify(c)
  }
  const cases = [
    ['', /empty/],
    ['   ', /empty/],
    ['{', /not JSON/],
    ['[]', /not a Google client file/],
    ['null', /not a Google client file/],
    [JSON.stringify(fixture('client-web.json')), /Web application/],
    [JSON.stringify({ type: 'service_account', private_key: 'k' }), /service account/],
    [JSON.stringify({ type: 'authorized_user', refresh_token: 'r' }), /authorized_user/],
    [JSON.stringify({ other: 1 }), /No "installed" client/],
    [JSON.stringify({ installed: [] }), /not an object/],
    [variant((c) => (c.client_id = 'abc.example.com')), /client_id: a Google client id ends in/],
    [variant((c) => (c.client_id = 'a b.apps.googleusercontent.com')), /client_id: .*characters/],
    [variant((c) => delete c.client_secret), /client_secret: no client secret/],
    [variant((c) => (c.client_secret = GOOD_SECRET_WITH_SPACE)), /client_secret: .*characters/],
    [variant((c) => (c.auth_uri = 'https://evil.example/auth')), /auth_uri is not Google/],
    [variant((c) => (c.token_uri = 'https://evil.example/token')), /token_uri is not Google/],
    ['x'.repeat(70000), /too long/],
  ]
  for (const [text, re] of cases) {
    const r = parseClientFile(text)
    assert.equal(r.ok, false, text.slice(0, 80))
    assert.match(r.error, re, text.slice(0, 80))
    assert.ok(!r.error.includes(CLIENT_SECRET) && !r.error.includes('GOCSPX'), 'no secret in the error')
  }
  assert.equal(parseClientFile(undefined).ok, false)
})
const GOOD_SECRET_WITH_SPACE = 'GOCSPX-has space'

test('checkClientId and checkClientSecret', () => {
  assert.equal(checkClientId(CLIENT_ID).ok, true)
  assert.equal(checkClientId('').ok, false)
  assert.equal(checkClientId(`${'1'.repeat(300)}.apps.googleusercontent.com`).ok, false)
  assert.equal(checkClientSecret('GOCSPX-abc').ok, true)
  assert.equal(checkClientSecret('a\nb').ok, false)
  assert.equal(checkClientSecret('é').ok, false)
})

test('oauthSpec: Google\'s fixed endpoints and the read-only scope, never the file\'s URLs', () => {
  assert.deepEqual(oauthSpec({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), { authUrl: AUTH_URL, tokenUrl: TOKEN_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: [SCOPE] })
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly')
  assert.match(AUTH_URL, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?access_type=offline&prompt=consent$/)
  assert.equal(TOKEN_URL, 'https://oauth2.googleapis.com/token')
  assert.equal(oauthSpec({ clientId: CLIENT_ID }).clientSecret, '')
  assert.equal(shortClientId(CLIENT_ID), '123456789012…')
  assert.equal(shortClientId('short.apps.googleusercontent.com'), 'short')
})

test('sortRows: priority, then the newest, verdict-less last', () => {
  const rows = [
    { id: 'a', at: 5, verdict: { priority: 'fyi' } },
    { id: 'b', at: 9, verdict: null },
    { id: 'c', at: 1, verdict: { priority: 'urgent' } },
    { id: 'd', at: 7, verdict: { priority: 'fyi' } },
    { id: 'e', at: 3, verdict: { priority: 'weird' } },
  ]
  assert.deepEqual(sortRows(rows).map((r) => r.id), ['c', 'd', 'a', 'b', 'e'])
})
