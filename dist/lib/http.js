'use strict'
// Token-to-host safety: the one place the Google access token leaves the plugin (the OAuth
// endpoints are reached by the app's ctx.oauth, never from here). Also the one write: since 0.3.0
// `setThreadUnread` (threads.modify with the UNREAD label and nothing else) is the only request that
// is not a GET, and the only one that can change the mailbox (see there).
//
// The rule (design "Auth": tokens are sent only to https://gmail.googleapis.com and the OAuth
// endpoints): every request is built here from a fixed origin and a path, so no address from a
// response (a link in a mail, a `nextPageToken`) can point the token elsewhere. Redirects are not
// followed at all (`redirect: 'manual'`): the Gmail API answers its JSON directly, so a 3xx means
// something is off (a proxy, a captive portal) and is an error, never a hop with the token.

const ORIGIN = 'https://gmail.googleapis.com'
const TIMEOUT_MS = 20000
// What the person reads when Google refuses the write for the scope (the panel's prompt says the same).
const WRITE_SCOPE_TEXT = 'Sign in again to allow marking mail read: this Google sign-in only lets the plugin read your mail (a sign-in from before version 0.3.0, or the Gmail box was unticked on the consent page).'

/** Why a request failed, as a kind the host and the panel can act on. */
class GmailError extends Error {
  /**
   * @param {string} message what the person reads
   * @param {{ kind: string, status?: number, retryAfter?: number, reason?: string }} info kind:
   *   auth (401), forbidden (403), scope (403 insufficient permissions), notfound (404), rate
   *   (429, or 403 rateLimitExceeded), server (5xx), http (another status), network, timeout,
   *   unsafe (a path that would leave the API), json, toolarge
   */
  constructor(message, info) {
    super(message)
    this.name = 'GmailError'
    this.kind = info.kind
    if (info.status !== undefined) this.status = info.status
    if (info.retryAfter !== undefined) this.retryAfter = info.retryAfter
    if (info.reason) this.reason = info.reason
  }
}

/** Whether an error is worth backing off for (design: 429 and 5xx double the poll interval). */
function isBusy(err) {
  return Boolean(err) && (err.kind === 'rate' || err.kind === 'server')
}

/**
 * GET `path` (`/gmail/v1/users/me/profile`) on the Gmail API with the bearer token.
 *
 * @param {string} path starts with `/gmail/v1/`; no `..`, no `//`
 * @param {object} o
 * @param {string} o.token the access token
 * @param {URLSearchParams|Record<string,string>|Array<[string,string]>} [o.params]
 * @param {typeof fetch} o.fetch injected (tests pass a fake; nothing here reaches the network itself)
 * @param {AbortSignal} [o.signal] the caller's cancel (a `ccc` Ctrl+C, deactivate)
 * @param {number} [o.timeoutMs] the whole request with its body (default 20 s)
 * @param {number} [o.maxBytes] the body's cap (default 8 MiB)
 * @returns {Promise<any>} the JSON body
 */
async function gmailGet(path, o) {
  return request('GET', path, o, null)
}

/** The one label the plugin ever changes. */
const UNREAD = 'UNREAD'

/**
 * The body of the plugin's only write: exactly `{ removeLabelIds: ['UNREAD'] }` (mark read) or
 * `{ addLabelIds: ['UNREAD'] }` (mark unread), from a boolean, never from a caller's label list, so
 * no call path can archive (remove INBOX), label, star, trash or send. Null for anything but a
 * boolean.
 */
function readStateBody(unread) {
  if (unread === true) return { addLabelIds: [UNREAD] }
  if (unread === false) return { removeLabelIds: [UNREAD] }
  return null
}

/**
 * Mark a whole thread read (`unread` false) or unread (true): `POST users/me/threads/<id>/modify`
 * (needs the gmail.modify scope; a sign-in with gmail.readonly gets 403 insufficientPermissions,
 * kind `scope`). Gmail applies the label change to every message of the thread. The thread id is
 * checked (it goes into the path) and the body is built here from the boolean (readStateBody): this
 * is the only function in the plugin that sends anything but a GET.
 *
 * @param {string} threadId
 * @param {boolean} unread
 * @param {object} o as gmailGet (token, fetch, signal, timeoutMs)
 * @returns {Promise<any>} Gmail's answer (the thread with its messages' labelIds)
 */
async function setThreadUnread(threadId, unread, o) {
  const id = typeof threadId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? threadId : null
  if (!id) throw new GmailError('not a thread id', { kind: 'unsafe' })
  const body = readStateBody(unread)
  if (!body) throw new GmailError('mark read or unread takes true or false', { kind: 'unsafe' })
  return request('POST', `/gmail/v1/users/me/threads/${id}/modify`, { ...o, params: null, maxBytes: 2 * 1024 * 1024 }, JSON.stringify(body))
}

/** GET (no body) or the one POST (setThreadUnread's body) on the Gmail API with the bearer token. */
async function request(method, path, o, body) {
  if (typeof path !== 'string' || !path.startsWith('/gmail/v1/') || path.includes('..') || path.includes('//') || /[?#%\s\\]/.test(path)) {
    throw new GmailError('not a Gmail API path: the token is not sent', { kind: 'unsafe' })
  }
  const qs = o.params ? new URLSearchParams(o.params).toString() : ''
  const url = ORIGIN + path + (qs ? `?${qs}` : '')
  // The URL parser must agree that this is still the API origin (a path cannot change it, but the
  // check costs nothing and keeps the rule in one visible place).
  if (new URL(url).origin !== ORIGIN) throw new GmailError('not a Gmail API address: the token is not sent', { kind: 'unsafe' })
  const ms = o.timeoutMs || TIMEOUT_MS
  const timeout = AbortSignal.timeout(ms)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  let res
  try {
    const headers = { Authorization: `Bearer ${o.token}`, Accept: 'application/json' }
    if (body !== null) headers['Content-Type'] = 'application/json'
    res = await o.fetch(url, { method, headers, redirect: 'manual', signal, ...(body !== null ? { body } : {}) })
  } catch (e) {
    if (timeout.aborted) throw new GmailError(`Gmail did not answer within ${Math.round(ms / 1000)} s`, { kind: 'timeout' })
    if (o.signal && o.signal.aborted) throw new GmailError('cancelled', { kind: 'network' })
    throw new GmailError(`cannot reach gmail.googleapis.com: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  let text
  try {
    text = (await readLimited(res, o.maxBytes || 8 * 1024 * 1024)).toString('utf8')
  } catch (e) {
    if (e instanceof GmailError) throw e
    if (timeout.aborted) throw new GmailError(`Gmail did not answer within ${Math.round(ms / 1000)} s`, { kind: 'timeout' })
    throw new GmailError(`reading Gmail's answer failed: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  if (res.status >= 200 && res.status < 300) {
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new GmailError('Gmail answered with something that is not JSON', { kind: 'json', status: res.status })
    }
  }
  throw statusError(res, text, method !== 'GET')
}

/**
 * A GmailError for a status that is not 2xx, with Google's own reason when it gave one. `write`: the
 * request was the mark read / unread call, where a missing scope means a sign-in from before 0.3.0
 * (gmail.readonly) or a consent with the Gmail box unticked, not a lack of read access.
 */
function statusError(res, text, write = false) {
  const status = res.status
  if (status >= 300 && status < 400) return new GmailError(`Gmail answered with a redirect (${status}): not followed, the token stays here. A proxy in the way?`, { kind: 'http', status })
  const g = googleError(text)
  const detail = g.message ? ` (${g.message})` : ''
  if (status === 401) return new GmailError(`Google refused the access token (401)${detail}`, { kind: 'auth', status })
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(g.reason))) {
    const ra = Number(res.headers.get('retry-after'))
    return new GmailError('Gmail is rate limiting the plugin; it polls less often until Gmail answers again', { kind: 'rate', status, ...(Number.isFinite(ra) ? { retryAfter: ra } : {}) })
  }
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(g.reason + ' ' + g.message)) {
    if (write) return new GmailError(WRITE_SCOPE_TEXT, { kind: 'scope', status, reason: g.reason })
    return new GmailError('Google gave the plugin no read access to Gmail: sign in again and leave "View your email messages and settings" ticked on the consent page', { kind: 'scope', status, reason: g.reason })
  }
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED/.test(g.reason + ' ' + g.message)) {
    return new GmailError('The Gmail API is not enabled in your Google Cloud project: enable it (APIs & Services > Library > Gmail API), then refresh', { kind: 'forbidden', status, reason: g.reason })
  }
  if (status === 403) return new GmailError(`Gmail refused the request (403)${detail}`, { kind: 'forbidden', status, reason: g.reason })
  if (status === 404) return new GmailError(`not found in Gmail (404)${detail}`, { kind: 'notfound', status })
  if (status >= 500) return new GmailError(`Gmail had a problem (${status}); it polls less often until Gmail answers again`, { kind: 'server', status })
  return new GmailError(`Gmail answered ${status}${detail}`, { kind: 'http', status })
}

/** Google's error body (`{ error: { code, message, errors: [{ reason }], status } }`) as short plain text. */
function googleError(text) {
  try {
    const body = JSON.parse(text)
    const e = body && body.error
    if (!e || typeof e !== 'object') return { message: '', reason: '' }
    const reasons = [...(Array.isArray(e.errors) ? e.errors.map((x) => x && x.reason) : []), e.status, ...(Array.isArray(e.details) ? e.details.map((x) => x && x.reason) : [])].filter((x) => typeof x === 'string')
    return { message: typeof e.message === 'string' ? e.message.replace(/\s+/g, ' ').slice(0, 200) : '', reason: reasons.join(' ') }
  } catch {
    // Not JSON (an HTML error page from a proxy): no detail rather than markup in a notice.
    return { message: '', reason: '' }
  }
}

/**
 * A response body as a Buffer, refused past `max` bytes (a declared Content-Length over it is
 * refused before reading; a body that keeps coming is cut off at the limit and cancelled).
 */
async function readLimited(res, max) {
  const tooLarge = () => new GmailError(`Gmail's answer is over ${max} bytes`, { kind: 'toolarge', status: res.status })
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    if (res.body) await res.body.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw tooLarge()
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks, total)
}

module.exports = { ORIGIN, GmailError, gmailGet, setThreadUnread, readStateBody, readLimited, isBusy, googleError, UNREAD, WRITE_SCOPE_TEXT }
