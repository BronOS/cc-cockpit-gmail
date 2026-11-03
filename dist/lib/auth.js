'use strict'
// The Google sign-in of one project (design "Auth (per project)"): which OAuth client is in use,
// the refresh token in ctx.secrets, the access token in memory only.
//
// - The client: a pasted client file wins over the settings fields until it is removed. Since 0.2.0
//   it is kept whole (id and secret) in this project's ctx.storage, so it survives an uninstall and
//   a reinstall: cc-cockpit deletes a plugin's ctx.secrets on uninstall (on purpose: no credential
//   outlives the plugin) but keeps its ctx.storage. A Desktop app client's secret is not a secret in
//   Google's own terms (an installed app cannot keep one; Google's docs say so, and the downloaded
//   file sits in plain text in the person's Downloads), unlike the refresh token, which stays in
//   ctx.secrets. 0.1.0 kept the client's secret in ctx.secrets under `client:<projectKey>:<...>`;
//   load() moves one it finds into the storage record and deletes the old key.
// - ctx.secrets is app-wide while accounts are per project (a personal and a work project use
//   different Google accounts), so the refresh token's key carries a project key and the client:
//   `refresh:<projectKey>:<sha256(clientId) 12>`. The project key is a random id kept in this
//   project's ctx.storage: per project (each project has its own storage), kept over an uninstall
//   with the rest of the storage, and naming nothing about the project. Nothing in ctx is steadier:
//   ctx.storage and ctx.dataDir both follow the app's project id (a hash of the folder's real path),
//   and ctx.projectDir is the path itself. A key is 41 characters, under the 128 the app allows.
// - The refresh token cannot survive an uninstall (the app deletes it with the other secrets). A
//   storage marker (`signedIn`: the client's hash) remembers that this project was signed in, so
//   after a reinstall the panel says why the sign-in is gone instead of showing a first setup.
// - The access token is refreshed through ctx.oauth.refresh a minute before `expiresAt`, one
//   refresh at a time (the app allows 4 in flight; a burst of thread reads must not spend them).
// - `invalid_grant` from Google = signed out: the refresh token is deleted and the reason kept for
//   the panel. The usual cause is a client still in "Testing" (Google lets its refresh tokens expire
//   after 7 days), so the message says that and how to fix it.
// - Changing the client (another id in the settings, a pasted file of another client, removing the
//   pasted one) signs out: the old client's refresh token is deleted.
// - The granted scope (0.3.0: gmail.modify, for mark read / unread). A sign-in from 0.1.0 / 0.2.0
//   holds gmail.readonly: its refresh token keeps reading (a refresh sends no scope, the grant keeps
//   its own), so nothing breaks, but a write gets 403 insufficientPermissions. `A.scope` is 'modify',
//   'readonly' or null (not known), kept in the `signedIn` storage marker next to the client's hash:
//   a 0.2.0 marker has no `scope`, which is how an old sign-in is told without a request. A sign-in
//   by 0.3.0 asked for gmail.modify, so it is taken as 'modify' unless the token response's `scope`
//   says otherwise (cc-cockpit's ctx.oauth passes none as of 0.9.3; read when it does) or the first
//   write is refused for the scope (`scopeMissing`, called by the host). 'readonly' makes the panel
//   ask to sign in again; reading goes on.
//
// Nothing here logs or returns a token or a secret: errors carry Google's error code at most (the
// app's own `ctx.oauth` messages do the same, `the token endpoint refused the request: HTTP 400
// (invalid_grant)`).

const crypto = require('node:crypto')
const { oauthSpec, parseClientFile, shortClientId, grantedScope } = require('./oauth-client')
const { sha } = require('./util')

const EARLY_MS = 60000 // refresh this long before the access token expires (clock skew, a slow call)

const GONE_TEXT =
  'The stored Google sign-in of this project is gone: cc-cockpit deletes a plugin\'s keychain entries when it is uninstalled. ' +
  'Your OAuth client is kept: press Sign in with Google again.'

const INVALID_GRANT_TEXT =
  'Google no longer accepts the stored sign-in (invalid_grant). Sign in again. ' +
  'If this happens about every 7 days, your OAuth client is in "Testing": Google expires its sign-ins after 7 days. ' +
  'In the Google Cloud console > Google Auth Platform > Audience, press Publish app (In production), or for a Workspace account set the user type to Internal.'

/** Why there is no access token: `kind` is signedOut (no sign-in), invalidGrant, noClient, keyring, oauth, superseded (a newer sign-in replaced it). */
class AuthError extends Error {
  constructor(message, kind) {
    super(message)
    this.name = 'AuthError'
    this.kind = kind
  }
}

/** Whether a ctx.oauth rejection is Google's invalid_grant (the refresh token is dead). */
function isInvalidGrant(err) {
  const m = err && err.message ? err.message : String(err || '')
  return /\binvalid_grant\b/.test(m) || Boolean(err && err.code === 'invalid_grant')
}

/** The ctx.secrets key of a client's refresh token in a project. */
function refreshKey(projectKey, clientId) {
  return `refresh:${projectKey}:${sha(clientId, 12)}`
}
/** The ctx.secrets key where 0.1.0 kept a pasted client's secret (moved to ctx.storage since 0.2.0). */
function clientKey(projectKey, clientId) {
  return `client:${projectKey}:${sha(clientId, 12)}`
}

/**
 * @param {object} o
 * @param {object} o.oauth ctx.oauth
 * @param {object} o.secrets ctx.secrets
 * @param {object} o.storage ctx.storage
 * @param {{ info: Function, warn: Function }} o.log ctx.log
 * @param {() => number} [o.now]
 */
function createAuth(o) {
  const now = o.now || Date.now
  const A = {
    projectKey: null,
    pasted: null, // { clientId, clientSecret } of a pasted client file
    pastedBroken: null, // why the pasted client cannot be used (its secret is gone)
    fromSettings: null, // { clientId, clientSecret } from the settings fields, when both are set
    settingsMissing: [], // 'clientId' / 'clientSecret' when only one of the two is set
    hasRefresh: false, // a refresh token is stored for the current client
    access: null, // { token, expiresAt } in memory only
    refreshing: null, // the running refresh: one at a time
    signedOutReason: null, // shown in the panel after invalid_grant
    signingIn: false,
    signInGen: 0,
    scope: null, // 'modify' | 'readonly' | null (not known): what the current sign-in may do
  }

  /** The client in use: the pasted one, else the settings one, else null. */
  function client() {
    if (A.pasted) return { ...A.pasted, source: 'pasted' }
    if (A.fromSettings) return { ...A.fromSettings, source: 'settings' }
    return null
  }

  async function ensureProjectKey() {
    if (A.projectKey) return A.projectKey
    let k = await o.storage.get('projectKey').catch(() => undefined)
    if (typeof k !== 'string' || !/^[a-f0-9]{12}$/.test(k)) {
      k = crypto.randomBytes(6).toString('hex')
      await o.storage.set('projectKey', k)
    }
    A.projectKey = k
    return k
  }

  /** Reads the project key, the pasted client and whether a refresh token is stored. */
  async function load(settingsCfg) {
    await ensureProjectKey()
    const stored = await o.storage.get('client').catch(() => undefined)
    if (stored && typeof stored.clientId === 'string') {
      if (typeof stored.clientSecret === 'string' && stored.clientSecret) {
        A.pasted = { clientId: stored.clientId, clientSecret: stored.clientSecret }
      } else {
        // 0.1.0 kept the secret in ctx.secrets: move it into the storage record (then it survives an uninstall).
        let secret = null
        try {
          secret = await o.secrets.get(clientKey(A.projectKey, stored.clientId))
        } catch (e) {
          A.pastedBroken = `the pasted client's secret cannot be read: ${e.message}`
        }
        if (secret) {
          A.pasted = { clientId: stored.clientId, clientSecret: secret }
          try {
            await o.storage.set('client', { clientId: stored.clientId, clientSecret: secret })
            await o.secrets.delete(clientKey(A.projectKey, stored.clientId)).catch(() => {})
            o.log.info('moved the pasted OAuth client from the keychain to the plugin storage (it survives a reinstall now)')
          } catch (e) {
            o.log.warn(`moving the pasted client to the plugin storage failed, kept in the keychain: ${e.message}`)
          }
        } else if (!A.pastedBroken) {
          A.pastedBroken = 'the pasted client\'s secret is gone (an uninstall deletes the keychain entries where version 0.1.0 kept it): paste the client file again; from now on it survives a reinstall'
        }
      }
    }
    applySettings(settingsCfg)
    await checkRefresh()
    // Signed in before, and the refresh token is gone: the plugin was uninstalled (or the keychain was
    // reset). Say so instead of looking like a first setup.
    const c = client()
    const mark = c ? await o.storage.get('signedIn').catch(() => undefined) : undefined
    const ours = Boolean(mark && c && mark.client === sha(c.clientId, 12))
    if (c && !A.hasRefresh && !A.signedOutReason && ours) A.signedOutReason = GONE_TEXT
    // A marker without `scope` was written by 0.1.0 / 0.2.0, whose sign-in asked for gmail.readonly.
    if (A.hasRefresh && ours) A.scope = mark.scope === 'modify' ? 'modify' : 'readonly'
  }

  function applySettings(cfg) {
    const id = cfg && cfg.clientId ? cfg.clientId : ''
    const secret = cfg && cfg.clientSecret ? cfg.clientSecret : ''
    A.fromSettings = id && secret ? { clientId: id, clientSecret: secret } : null
    A.settingsMissing = []
    if (id && !secret) A.settingsMissing.push('clientSecret')
    if (!id && secret) A.settingsMissing.push('clientId')
  }

  async function checkRefresh() {
    const c = client()
    if (!c) {
      A.hasRefresh = false
      return
    }
    try {
      A.hasRefresh = Boolean(await o.secrets.get(refreshKey(A.projectKey, c.clientId)))
    } catch (e) {
      o.log.warn(`reading the stored sign-in failed: ${e.message}`)
      A.hasRefresh = false
    }
  }

  /** Forget the current client's sign-in: its refresh token and the access token. */
  async function dropSignIn(clientId) {
    A.access = null
    A.hasRefresh = false
    A.scope = null
    await o.storage.delete('signedIn').catch(() => {})
    if (clientId && A.projectKey) await o.secrets.delete(refreshKey(A.projectKey, clientId)).catch((e) => o.log.warn(`deleting the stored sign-in failed: ${e.message}`))
  }

  /**
   * After a settings save. Returns true when the client in use changed (then the old one's sign-in
   * is gone and the host forgets the account's data).
   */
  async function settingsChanged(cfg) {
    const before = client()
    applySettings(cfg)
    const after = client()
    if ((before && before.clientId) === (after && after.clientId)) {
      // Same id, maybe a new secret: the refresh token still belongs to this client id.
      return false
    }
    if (before) await dropSignIn(before.clientId)
    A.signedOutReason = null
    await checkRefresh()
    return true
  }

  /**
   * A pasted client file (the panel's box or `ccc gmail client`). Returns `{ ok, changed, error?,
   * clientId? }`. Kept whole in ctx.storage (see the top of this file); when the store refuses,
   * nothing changes.
   */
  async function pasteClient(text) {
    const p = parseClientFile(text)
    if (!p.ok) return { ok: false, error: p.error }
    await ensureProjectKey()
    const stored = await o.storage.get('client').catch(() => undefined)
    try {
      await o.storage.set('client', { clientId: p.clientId, clientSecret: p.clientSecret })
    } catch (e) {
      return { ok: false, error: `The client could not be stored: ${e.message}` }
    }
    const before = client()
    A.pasted = { clientId: p.clientId, clientSecret: p.clientSecret }
    A.pastedBroken = null
    // A 0.1.0 copy of the secret in the keychain is not needed any more.
    if (stored && typeof stored.clientId === 'string') await o.secrets.delete(clientKey(A.projectKey, stored.clientId)).catch(() => {})
    const changed = !before || before.clientId !== p.clientId
    if (changed) {
      if (before) await dropSignIn(before.clientId)
      A.signedOutReason = null
      await checkRefresh()
    }
    return { ok: true, changed, clientId: p.clientId }
  }

  /** Remove the pasted client; the settings fields (if set) are used again. */
  async function removeClient() {
    if (!A.pasted && !A.pastedBroken) return { ok: false, error: 'No pasted client to remove.' }
    await ensureProjectKey()
    const before = client()
    const stored = await o.storage.get('client').catch(() => undefined)
    const id = A.pasted ? A.pasted.clientId : stored && stored.clientId
    if (id) await o.secrets.delete(clientKey(A.projectKey, id)).catch(() => {}) // a 0.1.0 copy
    await o.storage.delete('client').catch(() => {})
    A.pasted = null
    A.pastedBroken = null
    const after = client()
    const changed = (before && before.clientId) !== (after && after.clientId)
    if (changed) {
      if (before) await dropSignIn(before.clientId)
      A.signedOutReason = null
      await checkRefresh()
    }
    return { ok: true, changed }
  }

  /**
   * The browser sign-in. Resolves `{ sessionOnly }` (true when the keychain refused the refresh
   * token: signed in until the access token expires). Rejects with an AuthError.
   */
  async function signIn() {
    const c = client()
    if (!c) throw new AuthError('No OAuth client yet: paste the client file or set clientId and clientSecret first.', 'noClient')
    // A second call while one is open starts over: cc-cockpit 0.9.2+ cancels the pending authorize
    // (Google's "Access blocked" page never redirects back, so the first one would wait 5 minutes).
    // Only the newest call owns `signingIn`; an older one that ends (cancelled) is 'superseded', and
    // the caller drops it quietly. An older app refuses the second authorize: that error is shown.
    const gen = ++A.signInGen
    A.signingIn = true
    let tokens
    try {
      tokens = await o.oauth.authorize(oauthSpec(c))
    } catch (e) {
      if (gen !== A.signInGen) throw new AuthError('A newer sign-in replaced this one.', 'superseded')
      throw new AuthError(`Google sign-in did not finish: ${e && e.message ? e.message : e}`, 'oauth')
    } finally {
      if (gen === A.signInGen) A.signingIn = false
    }
    if (gen !== A.signInGen) throw new AuthError('A newer sign-in replaced this one.', 'superseded')
    // The client may have changed while the browser was open (a paste, a settings save): these
    // tokens belong to `c`, so they are kept only when it is still the client in use.
    const still = client()
    if (!still || still.clientId !== c.clientId) throw new AuthError('The OAuth client changed during the sign-in: sign in again.', 'oauth')
    A.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt }
    A.signedOutReason = null
    // Asked for gmail.modify: granted unless the token response says otherwise (or a write tells).
    A.scope = grantedScope(tokens.scope) || 'modify'
    let sessionOnly = false
    if (tokens.refreshToken) {
      try {
        await ensureProjectKey()
        await o.secrets.set(refreshKey(A.projectKey, c.clientId), tokens.refreshToken)
        A.hasRefresh = true
        await o.storage.set('signedIn', { client: sha(c.clientId, 12), scope: A.scope }).catch(() => {})
      } catch (e) {
        // The keyring is locked or missing: no file fallback (by design); signed in for now.
        o.log.warn(`storing the sign-in failed, signed in until the access token expires: ${e.message}`)
        sessionOnly = e.message
      }
    } else {
      // access_type=offline&prompt=consent should always bring one; without it the sign-in lasts an hour.
      o.log.warn('Google sent no refresh token: signed in until the access token expires')
      sessionOnly = 'Google sent no refresh token'
    }
    return { sessionOnly }
  }

  async function signOut() {
    const c = client()
    await dropSignIn(c && c.clientId)
    A.signedOutReason = null
  }

  /**
   * A live access token: the one in memory, else a refresh with the stored refresh token. Rejects
   * with an AuthError: signedOut (never signed in), invalidGrant (Google refused it: now signed
   * out), or oauth (a refresh that failed for another reason: network, Google down; still signed in).
   */
  async function token() {
    if (A.access && A.access.expiresAt - now() > EARLY_MS) return A.access.token
    if (A.refreshing) return A.refreshing
    A.refreshing = (async () => {
      const c = client()
      if (!c) throw new AuthError('No OAuth client yet.', 'noClient')
      let rt = null
      try {
        rt = await o.secrets.get(refreshKey(await ensureProjectKey(), c.clientId))
      } catch (e) {
        throw new AuthError(`The stored sign-in cannot be read: ${e.message}`, 'keyring')
      }
      if (!rt) {
        A.hasRefresh = false
        A.access = null
        throw new AuthError(A.signedOutReason || 'Not signed in to Google.', 'signedOut')
      }
      let t
      try {
        t = await o.oauth.refresh(oauthSpec(c), rt)
      } catch (e) {
        if (isInvalidGrant(e)) {
          await dropSignIn(c.clientId)
          A.signedOutReason = INVALID_GRANT_TEXT
          o.log.warn('Google refused the refresh token (invalid_grant): signed out')
          throw new AuthError(INVALID_GRANT_TEXT, 'invalidGrant')
        }
        throw new AuthError(`Refreshing the Google sign-in failed: ${e && e.message ? e.message : e}`, 'oauth')
      }
      // Google does not rotate refresh tokens today; if it sends one, it replaces the stored one.
      if (t.refreshToken && t.refreshToken !== rt) await o.secrets.set(refreshKey(A.projectKey, c.clientId), t.refreshToken).catch((e) => o.log.warn(`storing the new refresh token failed: ${e.message}`))
      A.access = { token: t.accessToken, expiresAt: t.expiresAt }
      A.hasRefresh = true
      // Should the app ever pass the token response's scope, it is the surest answer.
      const g = grantedScope(t.scope)
      if (g && g !== A.scope) await setScope(g)
      return t.accessToken
    })()
    try {
      return await A.refreshing
    } finally {
      A.refreshing = null
    }
  }

  /** Keep what the sign-in may do, in memory and in the storage marker (when there is a stored sign-in). */
  async function setScope(scope) {
    A.scope = scope
    const c = client()
    if (!c || !A.hasRefresh) return
    await o.storage.set('signedIn', { client: sha(c.clientId, 12), scope }).catch((e) => o.log.warn(`keeping the sign-in's scope failed: ${e.message}`))
  }

  /** Google refused a write for the scope: this sign-in only reads until the person signs in again. */
  function scopeMissing() {
    if (A.scope === 'readonly') return Promise.resolve()
    o.log.warn('Google refused marking mail read for the scope (a gmail.readonly sign-in): asking to sign in again')
    return setScope('readonly')
  }

  /** After a 401 from Gmail: the access token is no good, the next `token()` refreshes. */
  function invalidate() {
    A.access = null
  }

  /** What the panel and `ccc gmail status` show about the sign-in (no token, no secret). */
  function status() {
    const c = client()
    return {
      client: c ? { source: c.source, id: shortClientId(c.clientId), fullId: c.clientId } : null,
      pasted: Boolean(A.pasted),
      pastedBroken: A.pastedBroken,
      settingsMissing: [...A.settingsMissing],
      signedIn: Boolean(c) && (A.hasRefresh || Boolean(A.access && A.access.expiresAt > now())),
      sessionOnly: Boolean(c) && !A.hasRefresh && Boolean(A.access && A.access.expiresAt > now()),
      signingIn: A.signingIn,
      signedOutReason: A.signedOutReason,
      // Signed in, but only with gmail.readonly: the panel asks to sign in again before a write.
      needsWriteScope: Boolean(c) && A.scope === 'readonly' && (A.hasRefresh || Boolean(A.access && A.access.expiresAt > now())),
    }
  }

  return { A, load, client, settingsChanged, pasteClient, removeClient, signIn, signOut, token, invalidate, status, ensureProjectKey, scopeMissing }
}

module.exports = { createAuth, AuthError, isInvalidGrant, refreshKey, clientKey, INVALID_GRANT_TEXT, GONE_TEXT, EARLY_MS }
