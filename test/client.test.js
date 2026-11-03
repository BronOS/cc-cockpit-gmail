'use strict'
// The Gmail REST client: the token only to gmail.googleapis.com, no redirect followed, statuses as
// kinds the host acts on, Google's error reasons, size caps, JSON checks, paging, a 401 retry.
const test = require('node:test')
const assert = require('node:assert/strict')
const { gmailGet, GmailError, isBusy, googleError, readLimited } = require('../dist/lib/http')
const { createClient, METADATA_HEADERS } = require('../dist/lib/client')
const { fakeGmail, tokens, fixture, json, T } = require('./fakes')

function recorder(answer) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return typeof answer === 'function' ? answer(url, init) : answer.clone()
  }
  return { calls, fetch }
}

test('gmailGet: bearer token, Accept JSON, redirect manual, the params in the query', async () => {
  const r = recorder(json({ ok: 1 }))
  assert.deepEqual(await gmailGet('/gmail/v1/users/me/threads', { token: 'tok', params: [['q', 'is:unread a&b'], ['x', '1']], fetch: r.fetch }), { ok: 1 })
  const { url, init } = r.calls[0]
  assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads?q=is%3Aunread+a%26b&x=1')
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.redirect, 'manual')
  assert.equal(init.method, 'GET')
})

test('gmailGet: a path that could leave the API never gets the token', async () => {
  const r = recorder(json({}))
  for (const p of ['/gmail/v2/x', 'https://evil/gmail/v1/', '/gmail/v1/../../x', '/gmail/v1//evil.example/x', '/gmail/v1/x?y', '/gmail/v1/x#y', '/gmail/v1/a b', '/gmail/v1/a\\b', '/gmail/v1/%2e%2e/x', '@evil/gmail/v1/', null]) {
    await assert.rejects(gmailGet(p, { token: 't', fetch: r.fetch }), (e) => e.kind === 'unsafe', String(p))
  }
  assert.equal(r.calls.length, 0)
})

test('gmailGet: a redirect is an error, never followed', async () => {
  const r = recorder(new Response('', { status: 302, headers: { location: 'https://evil.example/' } }))
  await assert.rejects(gmailGet('/gmail/v1/users/me/profile', { token: 't', fetch: r.fetch }), (e) => e.kind === 'http' && e.status === 302 && /not followed/.test(e.message))
  assert.equal(r.calls.length, 1)
})

test('statuses become kinds with Google\'s reasons', async () => {
  const at = (body, status, headers) => gmailGet('/gmail/v1/users/me/profile', { token: 't', fetch: async () => json(body, status, headers) }).catch((e) => e)
  let e = await at(fixture('error-401.json'), 401)
  assert.equal(e.kind, 'auth')
  e = await at(fixture('error-429.json'), 429, { 'retry-after': '30' })
  assert.equal(e.kind, 'rate')
  assert.equal(e.retryAfter, 30)
  assert.equal(isBusy(e), true)
  e = await at({ error: { code: 403, message: 'Rate', errors: [{ reason: 'userRateLimitExceeded' }] } }, 403)
  assert.equal(e.kind, 'rate')
  e = await at(fixture('error-403-scope.json'), 403)
  assert.equal(e.kind, 'scope')
  assert.match(e.message, /ticked/)
  e = await at({ error: { code: 403, message: 'Gmail API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } }, 403)
  assert.equal(e.kind, 'forbidden')
  assert.match(e.message, /enable it/)
  e = await at({ error: { code: 403, message: 'no' } }, 403)
  assert.equal(e.kind, 'forbidden')
  e = await at({ error: { code: 404, message: 'Requested entity was not found.' } }, 404)
  assert.equal(e.kind, 'notfound')
  e = await at({}, 503)
  assert.equal(e.kind, 'server')
  assert.equal(isBusy(e), true)
  e = await at('x', 418)
  assert.equal(e.kind, 'http')
  assert.equal(isBusy(e), false)
})

test('googleError reads the error body, and nothing else', () => {
  assert.match(googleError(JSON.stringify(fixture('error-403-scope.json'))).reason, /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/)
  assert.deepEqual(googleError('not json'), { message: '', reason: '' })
  assert.deepEqual(googleError('{"error":"x"}'), { message: '', reason: '' })
  assert.equal(googleError(JSON.stringify({ error: { message: 'a\n\nb'.repeat(200) } })).message.length, 200)
})

test('a body that is not JSON, an empty body, network failure, timeout, cancel', async () => {
  const at = (fetch, o = {}) => gmailGet('/gmail/v1/users/me/profile', { token: 't', fetch, ...o }).catch((e) => e)
  assert.equal((await at(async () => new Response('<html>', { status: 200 }))).kind, 'json')
  assert.equal(await at(async () => new Response(null, { status: 204 })), null)
  const net = await at(async () => {
    throw new Error('ECONNREFUSED')
  })
  assert.equal(net.kind, 'network')
  assert.match(net.message, /cannot reach gmail\.googleapis\.com: ECONNREFUSED/)
  const slow = await at((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))), { timeoutMs: 20 })
  assert.equal(slow.kind, 'timeout')
  const ac = new AbortController()
  const p = at((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))), { signal: ac.signal })
  ac.abort()
  assert.match((await p).message, /cancelled/)
})

test('size caps: a declared length over the cap is refused unread, a long stream is cut', async () => {
  const big = new Response('x'.repeat(100), { headers: { 'content-length': '100' } })
  await assert.rejects(readLimited(big, 50), (e) => e.kind === 'toolarge')
  const stream = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(40)) } }))
  await assert.rejects(readLimited(stream, 100), (e) => e.kind === 'toolarge')
  assert.equal((await readLimited(new Response('abc'), 10)).toString(), 'abc')
  await assert.rejects(gmailGet('/gmail/v1/users/me/profile', { token: 't', maxBytes: 10, fetch: async () => json({ long: 'x'.repeat(100) }) }), (e) => e.kind === 'toolarge')
})

function client(opts = {}) {
  const reg = tokens()
  reg.valid.add('good')
  const g = fakeGmail({ tokens: reg, ...opts })
  let tok = opts.startToken || 'good'
  const invalidated = []
  const c = createClient({ getToken: async () => tok, invalidate: () => (invalidated.push(1), (tok = 'good')), fetch: g.fetch })
  return { c, g, invalidated }
}

test('a 401 invalidates the token and retries once with a new one', async () => {
  const { c, g, invalidated } = client({ startToken: 'stale' })
  assert.deepEqual(await c.profile(), { emailAddress: 'me@example.com', historyId: '1000' })
  assert.equal(invalidated.length, 1)
  assert.deepEqual(g.calls.map((x) => x.auth), ['Bearer stale', 'Bearer good'])
  // A second 401 is the answer, not a loop.
  const reg = tokens()
  const g2 = fakeGmail({ tokens: reg })
  const c2 = createClient({ getToken: async () => 'dead', invalidate: () => {}, fetch: g2.fetch })
  await assert.rejects(c2.profile(), (e) => e.kind === 'auth')
  assert.equal(g2.calls.length, 2)
})

test('profile: the address lower-cased; a profile without one is refused', async () => {
  const { c } = client({ routes: async (u) => (u.pathname.endsWith('/profile') ? json({ emailAddress: 'Me@Example.com', historyId: 77 }) : null) })
  assert.deepEqual(await c.profile(), { emailAddress: 'me@example.com', historyId: '77' })
  const bad = client({ routes: async () => json({ historyId: '1' }) })
  await assert.rejects(bad.c.profile(), (e) => e.kind === 'json')
})

test('listThreads pages up to the cap, skips bad and repeated ids, and stops on a server that never ends', async () => {
  const ids = Array.from({ length: 250 }, (_, k) => `18f0${String(k).padStart(12, '0')}`)
  const { c, g } = client({ lists: { unread: ids } })
  const got = await c.listThreads('is:unread', 230)
  assert.equal(got.length, 230)
  assert.equal(got[0].id, ids[0])
  assert.deepEqual(g.calls.map((x) => new URL(x.url).searchParams.get('maxResults')), ['100', '100', '30'])
  const endless = client({ routes: async () => json({ threads: [{ id: '../x' }, { id: 'a1' }, { id: 'a1' }], nextPageToken: 'again' }) })
  const e = await endless.c.listThreads('q', 50)
  assert.deepEqual(e.map((t) => t.id), ['a1'])
  assert.ok(endless.g.calls.length <= 20)
  const empty = client({ routes: async () => json({ resultSizeEstimate: 0 }) })
  assert.deepEqual(await empty.c.listThreads('q', 10), [])
})

test('thread: metadata asks for the six headers; full has a bigger cap; an id is checked first', async () => {
  const { c, g } = client()
  const t = await c.thread(T.t1, 'metadata')
  assert.equal(t.id, T.t1)
  assert.deepEqual(new URL(g.calls[0].url).searchParams.getAll('metadataHeaders'), METADATA_HEADERS)
  assert.equal(new URL(g.calls[0].url).searchParams.get('format'), 'metadata')
  const full = await c.thread(T.t1, 'full')
  assert.ok(full.messages[0].payload.parts || full.messages[0].payload.body)
  await assert.rejects(c.thread('../profile', 'full'), (e) => e.kind === 'unsafe')
  const bad = client({ routes: async () => json({ id: 'x' }) })
  await assert.rejects(bad.c.thread(T.t1), (e) => e.kind === 'json')
})

test('history: changed or not, the current id, 404 as notfound, the start id checked', async () => {
  const { c } = client({ historyId: '1005' })
  assert.deepEqual(await c.history('1005'), { changed: false, historyId: '1005' })
  assert.deepEqual(await c.history('1000'), { changed: true, historyId: '1005' })
  await assert.rejects(c.history('1&x=1'), (e) => e.kind === 'unsafe')
  const old = client({ historyTooOld: true })
  await assert.rejects(old.c.history('1'), (e) => e.kind === 'notfound')
  const page = client({ routes: async () => json({ historyId: '9', nextPageToken: 'p' }) })
  assert.equal((await page.c.history('1')).changed, true, 'a next page means records')
})

test('attachment: base64url decoded, capped, ids checked', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
  const { c } = client({ attachments: { '18f0a1b2c3d4e503': bytes } })
  assert.deepEqual(await c.attachment('18f0a1b2c3d4e503', 'ANGjdJ_logo_att_id_1'), bytes)
  await assert.rejects(c.attachment('18f0a1b2c3d4e503', 'ANGjdJ_logo_att_id_1', { maxBytes: 4 }), (e) => e.kind === 'toolarge')
  await assert.rejects(c.attachment('../x', 'a'), (e) => e.kind === 'unsafe')
  await assert.rejects(c.attachment('18f0a1b2c3d4e503', 'a/b'), (e) => e.kind === 'unsafe')
  const none = client({ routes: async () => json({ size: 1 }) })
  await assert.rejects(none.c.attachment('m1', 'a1'), (e) => e.kind === 'json')
})

test('labels: id to name, junk skipped', async () => {
  const { c } = client()
  const l = await c.labels()
  assert.equal(l.Label_7, 'Finance')
  const junk = client({ routes: async () => json({ labels: [null, { id: 1, name: 'x' }, { id: 'L', name: 'ok' }] }) })
  assert.deepEqual(await junk.c.labels(), { L: 'ok' })
})

test('GmailError carries its kind and status', () => {
  const e = new GmailError('m', { kind: 'rate', status: 429, retryAfter: 5 })
  assert.equal(e.name, 'GmailError')
  assert.equal(e.kind, 'rate')
  assert.equal(e.retryAfter, 5)
  assert.equal(isBusy(null), false)
})
