'use strict'
// The Gmail REST v1 client: read-only GETs on users/me (design "Fetching (Gmail API v1, read-only)").
// No method here writes: there is no modify, send, trash or label call, and the scope
// (gmail.readonly) would refuse one anyway.
//
// The access token comes from `getToken` (auth.js) on every request. A 401 means it died early
// (revoked, the clock): the client drops it (`invalidate`), takes a fresh one and retries once.

const { GmailError, gmailGet } = require('./http')
const { gmailId } = require('./util')

const BASE = '/gmail/v1/users/me'
const LIST_PAGE = 100 // threads.list takes up to 500; the plugin never needs more than 200
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Id']
const MAX_THREAD_BYTES = 30 * 1024 * 1024 // a format=full thread with inline parts can be big
const MAX_ATTACHMENT_JSON = 1200000 // 700 KiB of picture as base64url in JSON, with room

/**
 * @param {object} o
 * @param {(signal?: AbortSignal) => Promise<string>} o.getToken
 * @param {() => void} o.invalidate
 * @param {typeof fetch} o.fetch
 */
function createClient(o) {
  async function get(path, params, extra = {}) {
    let token = await o.getToken()
    try {
      return await gmailGet(path, { token, params, fetch: o.fetch, ...extra })
    } catch (e) {
      if (!(e instanceof GmailError) || e.kind !== 'auth') throw e
      o.invalidate()
      token = await o.getToken()
      return gmailGet(path, { token, params, fetch: o.fetch, ...extra })
    }
  }

  /** `{ emailAddress, historyId }` of the signed-in account. */
  async function profile(signal) {
    const p = await get(`${BASE}/profile`, null, { signal })
    if (!p || typeof p.emailAddress !== 'string') throw new GmailError('Gmail did not say whose mailbox this is (profile)', { kind: 'json' })
    return { emailAddress: p.emailAddress.toLowerCase(), historyId: typeof p.historyId === 'string' || typeof p.historyId === 'number' ? String(p.historyId) : null }
  }

  /**
   * The newest threads a search finds, up to `cap`, in Gmail's order (newest first):
   * `[{ id, historyId, snippet }]`. Paged by nextPageToken; every page adds at least one thread or
   * the loop ends, so `cap` bounds it even when a server keeps handing out tokens.
   */
  async function listThreads(q, cap, signal) {
    const out = []
    const seen = new Set()
    let pageToken = null
    for (let page = 0; page < 20 && out.length < cap; page++) {
      const params = { q, maxResults: String(Math.min(LIST_PAGE, cap - out.length)) }
      if (pageToken) params.pageToken = pageToken
      const body = (await get(`${BASE}/threads`, params, { signal })) || {}
      const got = Array.isArray(body.threads) ? body.threads : []
      for (const t of got) {
        const id = t && gmailId(t.id)
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push({ id, historyId: t.historyId != null ? String(t.historyId) : '', snippet: typeof t.snippet === 'string' ? t.snippet : '' })
      }
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null
      if (!pageToken || !got.length) break
    }
    return out.slice(0, cap)
  }

  /** A thread: `format` metadata (the headers the lanes need) or full (the bodies, for the view). */
  async function thread(id, format, signal) {
    const tid = gmailId(id)
    if (!tid) throw new GmailError('not a thread id', { kind: 'unsafe' })
    // metadataHeaders is a repeated parameter (`&metadataHeaders=From&metadataHeaders=To`).
    const params = [['format', format === 'full' ? 'full' : 'metadata']]
    if (format !== 'full') for (const h of METADATA_HEADERS) params.push(['metadataHeaders', h])
    const t = await get(`${BASE}/threads/${tid}`, params, { signal, ...(format === 'full' ? { maxBytes: MAX_THREAD_BYTES, timeoutMs: 30000 } : {}) })
    if (!t || !Array.isArray(t.messages)) throw new GmailError(`thread ${tid}: Gmail sent no messages`, { kind: 'json' })
    return t
  }

  /**
   * Whether anything changed since `startHistoryId` (design: polling starts with this cheap call):
   * `{ changed, historyId }`, historyId the mailbox's current one. One page of one record is enough
   * to know. A 404 (the id is too old, about a week) rejects with kind notfound: the caller does a
   * full refresh.
   */
  async function history(startHistoryId, signal) {
    if (!/^[0-9]{1,30}$/.test(String(startHistoryId))) throw new GmailError('not a history id', { kind: 'unsafe' })
    const body = (await get(`${BASE}/history`, { startHistoryId: String(startHistoryId), maxResults: '1' }, { signal })) || {}
    const changed = (Array.isArray(body.history) && body.history.length > 0) || Boolean(body.nextPageToken)
    return { changed, historyId: body.historyId != null ? String(body.historyId) : String(startHistoryId) }
  }

  /**
   * An attachment's bytes (users.messages.attachments.get: `{ size, data }` with data base64url),
   * at most `maxBytes` once decoded. Only for pictures (images.js decides which).
   */
  async function attachment(messageId, attachmentId, opts = {}) {
    const mid = gmailId(messageId)
    if (!mid) throw new GmailError('not a message id', { kind: 'unsafe' })
    const aid = String(attachmentId || '')
    // Attachment ids are long base64url strings; nothing else goes into the path.
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(aid)) throw new GmailError('not an attachment id', { kind: 'unsafe' })
    const max = opts.maxBytes || 700 * 1024
    const body = await get(`${BASE}/messages/${mid}/attachments/${aid}`, null, { signal: opts.signal, timeoutMs: opts.timeoutMs, maxBytes: Math.max(MAX_ATTACHMENT_JSON, Math.ceil((max * 4) / 3) + 4096) })
    if (!body || typeof body.data !== 'string') throw new GmailError('Gmail sent no attachment data', { kind: 'json' })
    const buf = Buffer.from(body.data, 'base64url')
    if (buf.length > max) throw new GmailError(`the attachment is over ${max} bytes`, { kind: 'toolarge' })
    return buf
  }

  /** The labels of the mailbox, id -> name (the view shows user labels by name). */
  async function labels(signal) {
    const body = (await get(`${BASE}/labels`, null, { signal })) || {}
    const out = {}
    for (const l of Array.isArray(body.labels) ? body.labels : []) if (l && typeof l.id === 'string' && typeof l.name === 'string') out[l.id] = l.name
    return out
  }

  return { get, profile, listThreads, thread, history, attachment, labels }
}

module.exports = { createClient, METADATA_HEADERS, BASE }
