'use strict'
// The sign-in on its own: the client (pasted or settings), the refresh token per project and
// client in ctx.secrets, the access token in memory, invalid_grant, a locked keyring.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAuth, isInvalidGrant, refreshKey, clientKey, AuthError, EARLY_MS } = require('../dist/lib/auth')
const { readSettings } = require('../dist/lib/settings')
const { fakeOAuth, fakeSecrets, fakeStorage, tokens, fixture, NOW, CLIENT_ID, CLIENT_SECRET, SETTINGS_CLIENT } = require('./fakes')

const FILE = JSON.stringify(fixture('client_secret.json'))

function make(opts = {}) {
  const reg = tokens()
  let clock = NOW
  const oauth = fakeOAuth(reg, { now: () => clock, ...(opts.oauth || {}) })
  const secrets = opts.secrets || fakeSecrets()
  const storage = opts.storage || fakeStorage()
  const logs = []
  const auth = createAuth({ oauth, secrets, storage, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, now: () => clock })
  return { auth, oauth, secrets, storage, logs, reg, tick: (ms) => (clock += ms) }
}

const cfg = (p = {}) => readSettings(p).cfg

test('keys: the project key and a hash of the client id, inside the app\'s key rules', () => {
  assert.match(refreshKey('0123456789ab', CLIENT_ID), /^refresh:0123456789ab:[a-f0-9]{12}$/)
  assert.match(clientKey('0123456789ab', CLIENT_ID), /^client:0123456789ab:[a-f0-9]{12}$/)
  assert.notEqual(refreshKey('0123456789ab', CLIENT_ID), refreshKey('0123456789ab', SETTINGS_CLIENT.clientId))
  assert.ok(refreshKey('0123456789ab', CLIENT_ID).length <= 128)
})

test('isInvalidGrant reads the app\'s message for a refused refresh token', () => {
  assert.equal(isInvalidGrant(new Error('the token endpoint refused the request: HTTP 400 (invalid_grant)')), true)
  assert.equal(isInvalidGrant(new Error('the token endpoint refused the request: HTTP 401 (invalid_client)')), false)
  assert.equal(isInvalidGrant(new Error('network down')), false)
  assert.equal(isInvalidGrant(null), false)
})

test('no client: signIn and token say so', async () => {
  const { auth } = make()
  await auth.load(cfg())
  assert.equal(auth.client(), null)
  await assert.rejects(auth.signIn(), (e) => e instanceof AuthError && e.kind === 'noClient')
  await assert.rejects(auth.token(), (e) => e.kind === 'noClient')
  assert.equal(auth.status().signedIn, false)
})

test('the project key is made once and kept', async () => {
  const storage = fakeStorage()
  const a = make({ storage })
  await a.auth.load(cfg())
  const k = await storage.get('projectKey')
  assert.match(k, /^[a-f0-9]{12}$/)
  const b = make({ storage })
  await b.auth.load(cfg())
  assert.equal(b.auth.A.projectKey, k)
  await storage.set('projectKey', '../bad')
  const c = make({ storage })
  await c.auth.load(cfg())
  assert.match(c.auth.A.projectKey, /^[a-f0-9]{12}$/)
})

test('pasteClient stores the secret in ctx.secrets and only the id in storage', async () => {
  const { auth, secrets, storage } = make()
  await auth.load(cfg())
  const r = await auth.pasteClient(FILE)
  assert.deepEqual(r, { ok: true, changed: true, clientId: CLIENT_ID })
  assert.equal(await secrets.get(clientKey(auth.A.projectKey, CLIENT_ID)), CLIENT_SECRET)
  assert.deepEqual(await storage.get('client'), { clientId: CLIENT_ID })
  assert.deepEqual(auth.status().client, { source: 'pasted', id: '123456789012…', fullId: CLIENT_ID })
  assert.deepEqual(await auth.pasteClient(FILE), { ok: true, changed: false, clientId: CLIENT_ID })
})

test('a pasted client survives a restart; a secret gone from the keychain is reported, not used', async () => {
  const a = make()
  await a.auth.load(cfg())
  await a.auth.pasteClient(FILE)
  const b = make({ secrets: a.secrets, storage: a.storage })
  await b.auth.load(cfg())
  assert.equal(b.auth.client().clientId, CLIENT_ID)
  await a.secrets.delete(clientKey(a.auth.A.projectKey, CLIENT_ID))
  const c = make({ secrets: a.secrets, storage: a.storage })
  await c.auth.load(cfg())
  assert.equal(c.auth.client(), null)
  assert.match(c.auth.status().pastedBroken, /gone from the keychain/)
  assert.deepEqual(await c.auth.removeClient(), { ok: true, changed: false })
  assert.equal(c.auth.status().pastedBroken, null)
})

test('a refused keychain write leaves the old client in place', async () => {
  const { auth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  secrets.failSet = 'locked'
  const r = await auth.pasteClient(FILE)
  assert.equal(r.ok, false)
  assert.match(r.error, /could not be stored: locked/)
  assert.equal(auth.client().source, 'settings')
})

test('sign in: the spec, the refresh token stored, the access token kept in memory', async () => {
  const { auth, oauth, secrets } = make()
  await auth.load(cfg())
  await auth.pasteClient(FILE)
  assert.deepEqual(await auth.signIn(), { sessionOnly: false })
  assert.equal(oauth.authorizes[0].clientSecret, CLIENT_SECRET)
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, CLIENT_ID)), '1//refresh-1')
  assert.equal(await auth.token(), 'ya29.access-1')
  assert.equal(oauth.refreshes.length, 0)
  assert.deepEqual(auth.status(), { client: { source: 'pasted', id: '123456789012…', fullId: CLIENT_ID }, pasted: true, pastedBroken: null, settingsMissing: [], signedIn: true, sessionOnly: false, signingIn: false, signedOutReason: null })
  assert.ok(!JSON.stringify(auth.status()).includes(CLIENT_SECRET))
})

test('a second sign-in starts over: the first one ends as superseded, the newest owns signingIn', async () => {
  const { auth, oauth } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  let open
  oauth.gate = new Promise((r) => (open = r))
  const first = auth.signIn()
  assert.equal(auth.status().signingIn, true)
  const second = auth.signIn()
  open()
  await assert.rejects(first, (e) => e.kind === 'superseded')
  await second
  assert.equal(auth.status().signingIn, false)
  assert.equal(auth.status().signedIn, true)
})

test('a client changed during the sign-in: the tokens are not kept', async () => {
  const { auth, oauth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  let open
  oauth.gate = new Promise((r) => (open = r))
  const p = auth.signIn()
  await auth.pasteClient(FILE)
  open()
  await assert.rejects(p, /changed during the sign-in/)
  assert.equal((await secrets.keys()).filter((k) => k.startsWith('refresh:')).length, 0)
})

test('the access token refreshes a minute before it expires, one refresh at a time', async () => {
  const { auth, oauth, tick } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  tick(3600000 - EARLY_MS - 1000)
  assert.equal(await auth.token(), 'ya29.access-1')
  tick(2000)
  const [a, b, c] = await Promise.all([auth.token(), auth.token(), auth.token()])
  assert.equal(oauth.refreshes.length, 1)
  assert.equal(a, 'ya29.access-2')
  assert.equal(b, a)
  assert.equal(c, a)
  assert.equal(oauth.refreshes[0].refreshToken, '1//refresh-1')
})

test('a rotated refresh token replaces the stored one', async () => {
  const { auth, oauth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  oauth.rotate = true
  auth.invalidate()
  await auth.token()
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, SETTINGS_CLIENT.clientId)), '1//rotated-2')
})

test('invalid_grant: signed out, the refresh token deleted, the reason names the 7-day Testing expiry', async () => {
  const { auth, oauth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  oauth.invalidGrant = true
  auth.invalidate()
  await assert.rejects(auth.token(), (e) => e.kind === 'invalidGrant' && /7 days/.test(e.message))
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, SETTINGS_CLIENT.clientId)), null)
  const st = auth.status()
  assert.equal(st.signedIn, false)
  assert.match(st.signedOutReason, /Testing/)
  assert.match(st.signedOutReason, /Publish app|In production/)
  assert.match(st.signedOutReason, /Internal/)
  await assert.rejects(auth.token(), (e) => e.kind === 'signedOut' && /7 days/.test(e.message), 'the reason stays until a new sign-in')
  oauth.invalidGrant = false
  await auth.signIn()
  assert.equal(auth.status().signedOutReason, null)
})

test('another refresh failure keeps the sign-in (Google down is not a sign out)', async () => {
  const { auth, oauth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  oauth.refreshError = 'fetch failed'
  auth.invalidate()
  await assert.rejects(auth.token(), (e) => e.kind === 'oauth' && /fetch failed/.test(e.message))
  assert.ok(await secrets.get(refreshKey(auth.A.projectKey, SETTINGS_CLIENT.clientId)))
  assert.equal(auth.status().signedIn, true)
})

test('a keychain that refuses the refresh token: signed in for the session only', async () => {
  const { auth, secrets, tick } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  secrets.failSet = 'no Secret Service'
  assert.deepEqual(await auth.signIn(), { sessionOnly: 'no Secret Service' })
  assert.equal(auth.status().sessionOnly, true)
  assert.equal(auth.status().signedIn, true)
  tick(3600001)
  assert.equal(auth.status().signedIn, false)
  await assert.rejects(auth.token(), (e) => e.kind === 'signedOut')
})

test('Google sends no refresh token: session only, said in the log', async () => {
  const { auth, logs } = make({ oauth: { noRefreshToken: true } })
  await auth.load(cfg(SETTINGS_CLIENT))
  assert.deepEqual(await auth.signIn(), { sessionOnly: 'Google sent no refresh token' })
  assert.ok(logs.some((l) => /no refresh token/.test(l)))
})

test('a keychain that cannot be read: the token call says so', async () => {
  const { auth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  auth.invalidate()
  secrets.get = async () => {
    throw new Error('locked')
  }
  await assert.rejects(auth.token(), (e) => e.kind === 'keyring' && /locked/.test(e.message))
})

test('settingsChanged: the same client keeps the sign-in, another drops the old one\'s token', async () => {
  const { auth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  assert.equal(await auth.settingsChanged(cfg({ ...SETTINGS_CLIENT, pollMinutes: 5 })), false)
  assert.equal(auth.status().signedIn, true)
  assert.equal(await auth.settingsChanged(cfg({ clientId: '999-x.apps.googleusercontent.com', clientSecret: 's' })), true)
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, SETTINGS_CLIENT.clientId)), null)
  assert.equal(auth.status().signedIn, false)
  assert.equal(await auth.settingsChanged(cfg({ clientId: '999-x.apps.googleusercontent.com' })), true)
  assert.deepEqual(auth.status().settingsMissing, ['clientSecret'])
  assert.equal(auth.client(), null)
})

test('a pasted client wins over the settings; pasting another drops the first one\'s sign-in and secret', async () => {
  const { auth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  assert.equal((await auth.pasteClient(FILE)).changed, true)
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, SETTINGS_CLIENT.clientId)), null)
  await auth.signIn()
  const other = fixture('client_secret.json')
  other.installed.client_id = '222222222222-other.apps.googleusercontent.com'
  other.installed.client_secret = 'GOCSPX-other'
  assert.equal((await auth.pasteClient(JSON.stringify(other))).changed, true)
  assert.equal(await secrets.get(clientKey(auth.A.projectKey, CLIENT_ID)), null, 'the first pasted secret is deleted')
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, CLIENT_ID)), null)
  const r = await auth.removeClient()
  assert.deepEqual(r, { ok: true, changed: true })
  assert.equal(auth.client().source, 'settings')
  assert.deepEqual((await secrets.keys()).filter((k) => k.startsWith('client:')), [])
  assert.deepEqual(await auth.removeClient(), { ok: false, error: 'No pasted client to remove.' })
})

test('sign out deletes the refresh token and the access token', async () => {
  const { auth, secrets } = make()
  await auth.load(cfg(SETTINGS_CLIENT))
  await auth.signIn()
  await auth.signOut()
  assert.equal(await secrets.get(refreshKey(auth.A.projectKey, SETTINGS_CLIENT.clientId)), null)
  assert.equal(auth.status().signedIn, false)
  await assert.rejects(auth.token(), (e) => e.kind === 'signedOut')
})

test('two projects with the same client have separate sign-ins (app-wide secrets)', async () => {
  const secrets = fakeSecrets()
  const a = make({ secrets })
  const b = make({ secrets })
  await a.auth.load(cfg(SETTINGS_CLIENT))
  await b.auth.load(cfg(SETTINGS_CLIENT))
  assert.notEqual(a.auth.A.projectKey, b.auth.A.projectKey)
  await a.auth.signIn()
  assert.equal(b.auth.status().signedIn, false)
  await b.auth.signIn()
  await a.auth.signOut()
  assert.equal(b.auth.status().signedIn, true)
  assert.ok(await secrets.get(refreshKey(b.auth.A.projectKey, SETTINGS_CLIENT.clientId)))
})
