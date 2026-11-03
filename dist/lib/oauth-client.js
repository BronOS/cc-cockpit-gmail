'use strict'
// The person's own Google OAuth client (design "Auth": no shared client, ever; Gmail scopes are
// "restricted", so a shared one would need Google's verification and a paid yearly assessment).
// Two ways in: the settings fields (clientId, clientSecret), or the client file Google offers to
// download, pasted into the panel or read by `ccc gmail client <file>`. This file checks that file,
// and builds the `ctx.oauth` spec. The URLs here are constants: the ones in the file are only
// checked to be Google's, never used, so a doctored file cannot point the sign-in elsewhere.

// Without access_type=offline Google sends no refresh token; without prompt=consent it sends one
// only on the very first consent of a client, so a second sign-in (another project, after a sign
// out) would get none. `ctx.oauth` adds response_type, client_id, redirect_uri, state, PKCE and scope.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Read-only on purpose (design "Left out of v1": writing needs gmail.modify).
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

// What Google writes into a downloaded client file (both spellings of each are in use: the v1
// auth URI is what the console writes today, gws and older files have the others).
const GOOGLE_AUTH_URIS = new Set(['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'])
const GOOGLE_TOKEN_URIS = new Set(['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token', 'https://www.googleapis.com/oauth2/v4/token'])
const CLIENT_SUFFIX = '.apps.googleusercontent.com'
const MAX_FILE = 64 * 1024 // a client file is under 1 KB; anything this big is not one

/** Whether `id` looks like a Google OAuth client id: `<digits>-<letters>.apps.googleusercontent.com`. */
function checkClientId(id) {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'no client id' }
  if (id.length > 300) return { ok: false, error: 'the client id is too long to be a Google one' }
  if (!id.endsWith(CLIENT_SUFFIX)) return { ok: false, error: `a Google client id ends in ${CLIENT_SUFFIX}` }
  const head = id.slice(0, -CLIENT_SUFFIX.length)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(head)) return { ok: false, error: 'the client id has characters a Google one does not' }
  return { ok: true }
}

/** Whether a client secret can be sent as is (printable, no white space; Google's are `GOCSPX-...`). */
function checkClientSecret(secret) {
  if (typeof secret !== 'string' || !secret) return { ok: false, error: 'no client secret' }
  if (secret.length > 4096 || !/^[\x21-\x7e]+$/.test(secret)) return { ok: false, error: 'the client secret has characters a Google one does not' }
  return { ok: true }
}

/**
 * The client from a downloaded client file (`{"installed": {"client_id", "client_secret",
 * "auth_uri", "token_uri", ...}}`, also what the gws CLI keeps in ~/.config/gws/client_secret.json).
 * Returns `{ ok: true, clientId, clientSecret }` or `{ ok: false, error }`; the error never quotes the
 * secret (it may end up in a notice or a log).
 *
 * @param {string} text the file's text
 */
function parseClientFile(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The client file is empty: paste the whole JSON file Google offers to download.' }
  if (text.length > MAX_FILE) return { ok: false, error: 'That is too long to be a Google client file (under 1 KB as downloaded).' }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That is not JSON: paste the whole client file, from the first { to the last }.' }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'That is not a Google client file (a JSON object with "installed").' }
  if (!body.installed) {
    if (body.web) return { ok: false, error: 'This is a "Web application" client. Create a client of type "Desktop app" (it can sign in through 127.0.0.1) and paste its file.' }
    if (body.type === 'service_account') return { ok: false, error: 'This is a service account key, not an OAuth client. Create an OAuth client of type "Desktop app".' }
    if (body.type === 'authorized_user') return { ok: false, error: 'This is a saved sign-in (authorized_user), not the client file. Download the client of type "Desktop app" from the console.' }
    return { ok: false, error: 'No "installed" client in that file. Create a client of type "Desktop app" and paste the file Google offers to download.' }
  }
  const c = body.installed
  if (typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: '"installed" is not an object.' }
  const id = checkClientId(c.client_id)
  if (!id.ok) return { ok: false, error: `client_id: ${id.error}.` }
  const secret = checkClientSecret(c.client_secret)
  if (!secret.ok) return { ok: false, error: `client_secret: ${secret.error}.` }
  if (!GOOGLE_AUTH_URIS.has(c.auth_uri)) return { ok: false, error: 'auth_uri is not Google\'s sign-in address: this is not a Google client file.' }
  if (!GOOGLE_TOKEN_URIS.has(c.token_uri)) return { ok: false, error: 'token_uri is not Google\'s token address: this is not a Google client file.' }
  return { ok: true, clientId: c.client_id, clientSecret: c.client_secret }
}

/** The `ctx.oauth` spec of a client. */
function oauthSpec(client) {
  return { authUrl: AUTH_URL, tokenUrl: TOKEN_URL, clientId: client.clientId, clientSecret: client.clientSecret || '', scopes: [SCOPE] }
}

/** `123456789012…`, the client id without its `.apps.googleusercontent.com`: enough to tell two apart, for a person. */
function shortClientId(id) {
  const s = String(id || '')
  const head = s.endsWith(CLIENT_SUFFIX) ? s.slice(0, -CLIENT_SUFFIX.length) : s
  return head.length > 14 ? `${head.slice(0, 12)}…` : head
}

module.exports = { AUTH_URL, TOKEN_URL, SCOPE, CLIENT_SUFFIX, MAX_FILE, checkClientId, checkClientSecret, parseClientFile, oauthSpec, shortClientId }
