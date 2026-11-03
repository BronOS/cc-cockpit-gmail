'use strict'
// Fakes shared by the suites: the Gmail API behind a fake fetch (answers from the recorded shapes
// in fixtures/, never the network), Google's OAuth through a fake ctx.oauth, and a cc-cockpit ctx
// written from `ccc guide api` and `ccc guide types` (secrets, oauth, openExternal, the header).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const API = 'https://gmail.googleapis.com'
const ME = 'me@example.com'
const NOW = Date.parse('2026-11-03T08:00:00Z')
const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-test-secret-0123456789ab'
const SETTINGS_CLIENT = { clientId: '555555555555-settingsclient.apps.googleusercontent.com', clientSecret: 'GOCSPX-settings-secret' }

const T = {
  t1: '18f0a1b2c3d4e5f1',
  t2: '18f0a1b2c3d4e5f2',
  t3: '18f0a1b2c3d4e5f3',
  a1: '18f0a1b2c3d4e5a1',
  a2: '18f0a1b2c3d4e5a2',
  a3: '18f0a1b2c3d4e5a3',
  c1: '18f0a1b2c3d4e5c1',
}

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Bytes that sniff as a picture of the type (the magic number, then filler up to `size`). */
function picture(type = 'png', size = 64) {
  const head = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    gif: Buffer.from('GIF89a', 'latin1'),
    webp: Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]),
  }[type]
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)])
}

/** A token registry the fake OAuth hands out and the fake Gmail accepts. */
function tokens() {
  return { valid: new Set(), n: 0 }
}

/**
 * A fake Gmail. `lists`: { unread, alerts, read } thread-id lists the searches answer (by the shape
 * of the query: `-is:unread` is Read, a positive `from:` is Alerts, the rest Unread). `threads`:
 * id -> a format=full thread (default: the fixtures). `historyId`: the mailbox's current one;
 * `changedSince(start)` says whether history has records (default: start !== historyId);
 * `historyTooOld`: history answers 404. `fail`: { [route]: status } for `profile`, `list:<lane>`,
 * `thread:<id>`, `history`. `attachments`: `<messageId>` -> bytes (any attachment id of that message).
 */
function fakeGmail(opts = {}) {
  const calls = []
  const reg = opts.tokens || tokens()
  const state = { historyId: opts.historyId || '1000', lists: opts.lists || { unread: [T.t1, T.t2, T.c1], alerts: [T.a1, T.a2, T.a3], read: [T.t3] } }
  const threads = opts.threads || Object.fromEntries(Object.entries({ t1: T.t1, t2: T.t2, t3: T.t3, a1: T.a1, a2: T.a2, a3: T.a3, c1: T.c1 }).map(([k, id]) => [id, fixture(`thread-${k}.json`)]))
  const failOf = (route) => (opts.fail && opts.fail[route]) || 0
  const errorBody = (status) => (status === 401 ? fixture('error-401.json') : status === 429 ? fixture('error-429.json') : status === 403 ? fixture('error-403-scope.json') : { error: { code: status, message: 'boom' } })
  async function fetch(url, init = {}) {
    const headers = init.headers || {}
    const u = new URL(url)
    calls.push({ url, path: u.pathname, auth: headers.Authorization, redirect: init.redirect, q: u.searchParams.get('q') })
    if (opts.routes) {
      const r = await opts.routes(u, init)
      if (r) return r
    }
    if (u.origin !== API) throw new Error(`fake gmail: unexpected host ${u.origin}`)
    const token = String(headers.Authorization || '').replace(/^Bearer /, '')
    if (!reg.valid.has(token)) return json(fixture('error-401.json'), 401)
    const p = u.pathname.replace(/^\/gmail\/v1\/users\/me/, '')
    if (p === '/profile') {
      if (failOf('profile')) return json(errorBody(failOf('profile')), failOf('profile'))
      return json({ ...fixture('profile.json'), historyId: state.historyId })
    }
    if (p === '/labels') return json(fixture('labels.json'))
    if (p === '/history') {
      if (failOf('history')) return json(errorBody(failOf('history')), failOf('history'))
      if (opts.historyTooOld) return json({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404)
      const start = u.searchParams.get('startHistoryId')
      const changed = opts.changedSince ? opts.changedSince(start) : start !== state.historyId
      return json(changed ? { history: [{ id: state.historyId, messages: [{ id: 'x' }] }], historyId: state.historyId, nextPageToken: 'more' } : { historyId: state.historyId })
    }
    if (p === '/threads') {
      const q = u.searchParams.get('q') || ''
      const lane = /^-is:unread/.test(q) ? 'read' : /(^|\s)\{?from:/.test(q) ? 'alerts' : 'unread'
      if (failOf(`list:${lane}`)) return json(errorBody(failOf(`list:${lane}`)), failOf(`list:${lane}`))
      const ids = state.lists[lane] || []
      const max = Number(u.searchParams.get('maxResults')) || 100
      const start = Number(u.searchParams.get('pageToken') || 0)
      const page = ids.slice(start, start + max)
      const next = start + max < ids.length ? String(start + max) : undefined
      return json({ threads: page.map((id) => ({ id, snippet: '', historyId: threads[id] ? threads[id].historyId : '1' })), resultSizeEstimate: ids.length, ...(next ? { nextPageToken: next } : {}) })
    }
    const tm = /^\/threads\/([A-Za-z0-9_-]+)$/.exec(p)
    if (tm) {
      if (failOf(`thread:${tm[1]}`)) return json(errorBody(failOf(`thread:${tm[1]}`)), failOf(`thread:${tm[1]}`))
      const t = threads[tm[1]]
      if (!t) return json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404)
      if (u.searchParams.get('format') === 'full') return json(t)
      const want = new Set(u.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase()))
      return json({
        id: t.id,
        historyId: t.historyId,
        messages: t.messages.map((m) => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, historyId: m.historyId, internalDate: m.internalDate, payload: { mimeType: m.payload.mimeType, headers: m.payload.headers.filter((h) => want.has(h.name.toLowerCase())) } })),
      })
    }
    const am = /^\/messages\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+)$/.exec(p)
    if (am) {
      const bytes = opts.attachments && opts.attachments[am[1]]
      if (opts.attachmentDelay) await new Promise((r) => setTimeout(r, opts.attachmentDelay))
      if (!bytes) return json({ error: { code: 404, message: 'no such attachment' } }, 404)
      return json({ size: bytes.length, data: Buffer.from(bytes).toString('base64url') })
    }
    return json({ error: { code: 404, message: 'not found' } }, 404)
  }
  return { fetch, calls, state, threads, tokens: reg }
}

/**
 * A fake ctx.oauth. `authorize` and `refresh` record their specs and hand out tokens the fake
 * Gmail accepts. `invalidGrant: true` makes refresh fail the way the app's ctx.oauth does.
 * `noRefreshToken`: authorize sends none. `authorizeError`: authorize rejects with it.
 */
function fakeOAuth(reg, opts = {}) {
  const o = {
    authorizes: [],
    refreshes: [],
    invalidGrant: Boolean(opts.invalidGrant),
    async authorize(spec) {
      o.authorizes.push(structuredClone(spec))
      if (o.authorizeError) throw new Error(o.authorizeError)
      if (o.gate) await o.gate
      const t = `ya29.access-${++reg.n}`
      reg.valid.add(t)
      return { accessToken: t, refreshToken: opts.noRefreshToken ? null : `1//refresh-${reg.n}`, expiresAt: (opts.now || (() => NOW))() + 3600000 }
    },
    async refresh(spec, refreshToken) {
      o.refreshes.push({ spec: structuredClone(spec), refreshToken })
      if (o.invalidGrant) throw new Error('the token endpoint refused the request: HTTP 400 (invalid_grant)')
      if (o.refreshError) throw new Error(o.refreshError)
      const t = `ya29.access-${++reg.n}`
      reg.valid.add(t)
      return { accessToken: t, refreshToken: o.rotate ? `1//rotated-${reg.n}` : null, expiresAt: (opts.now || (() => NOW))() + 3600000 }
    },
  }
  return o
}

/** A fake ctx.secrets: a Map, with `failSet` to play a locked keyring. */
function fakeSecrets() {
  const m = new Map()
  const s = {
    map: m,
    failSet: null,
    async get(k) {
      return m.has(k) ? m.get(k) : null
    },
    async set(k, v) {
      if (s.failSet) throw new Error(s.failSet)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(k)) throw new Error(`bad secret key ${k}`)
      if (typeof v !== 'string' || v.length > 65536) throw new Error('bad secret value')
      m.set(k, v)
    },
    async delete(k) {
      m.delete(k)
    },
    async keys() {
      return [...m.keys()].sort()
    },
  }
  return s
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-'))
}

/** An in-memory ctx.storage (structured clones both ways, like the app's JSON store). */
function fakeStorage() {
  const store = new Map()
  return {
    map: store,
    async get(k) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined
    },
    async set(k, v) {
      store.set(k, structuredClone(v))
    },
    async delete(k) {
      store.delete(k)
    },
    async keys() {
      return [...store.keys()]
    },
  }
}

/**
 * A ctx good enough for dist/host.js: in-memory storage and secrets, recorded posts, headers,
 * badges, sessions, overlays, openExternal; services `triage` and `reviewer` from `opts`.
 * `opts.old`: the members cc-cockpit 0.9.1 added are left out.
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const services = { triage: opts.triage || null, reviewer: opts.reviewer || null, jira: opts.jira || null }
  const ctx = {
    api: 1,
    pluginId: 'bronos.gmail',
    projectDir: dataDir,
    dataDir,
    settings: Object.freeze({ project: opts.project || {}, app: {} }),
    posts: [],
    headers: [],
    badges: [],
    logs: [],
    sent: [],
    opened: [],
    external: [],
    overlays: [],
    schedules: [],
    sessionList: opts.sessions || [],
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    storage: opts.storage || fakeStorage(),
    secrets: opts.secrets || fakeSecrets(),
    oauth: opts.oauth,
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    schedule(seconds, fn) {
      const s = { seconds, fn, stopped: false }
      ctx.schedules.push(s)
      return () => {
        s.stopped = true
      }
    },
    async exec(argv) {
      throw new Error(`the plugin must not exec (${argv[0]})`)
    },
    async openExternal(url) {
      if (ctx.externalError) throw new Error(ctx.externalError)
      ctx.external.push(url)
    },
    panels: {
      post: (panel, m) => {
        if (JSON.stringify(m).length > 1024 * 1024) throw new Error('panel message over 1 MiB')
        ctx.posts.push(structuredClone(m))
      },
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => {}
      },
      header: (panel, spec) => {
        if (spec && spec.meta && spec.meta.length > 120) throw new TypeError('meta over 120')
        ctx.headers.push(structuredClone(spec))
      },
      onAction: (panel, fn) => {
        actionListeners.push(fn)
        return () => {}
      },
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(m)
    },
    async clickAction(id) {
      for (const fn of actionListeners) await fn(id)
    },
    overlay: {
      start(spec) {
        const o = { spec, posts: [], listeners: [], answer: opts.overlayAnswer || { kind: 'dismissed' } }
        ctx.overlays.push(o)
        const result = Promise.resolve(o.answer)
        o.send = (m) => o.listeners.forEach((fn) => fn(structuredClone(m)))
        return {
          result,
          post: (m) => {
            if (JSON.stringify(m).length > 1040384) throw new Error('overlay message over 1,040,384 chars of JSON')
            o.posts.push(structuredClone(m))
          },
          onMessage: (fn) => (o.listeners.push(fn), () => {}),
          close() {},
          focus() {},
        }
      },
    },
    sessions: {
      async list() {
        return ctx.sessionList
      },
      async send(tabId, text) {
        ctx.sent.push({ tabId, text })
        return { delivered: true }
      },
      async open(o) {
        ctx.opened.push(o)
        return { tabId: 'new1' }
      },
    },
    cli: {
      register: (name, fn) => {
        ctx.cliName = name
        ctx.cliHandler = fn
        return () => {}
      },
    },
    async runCli(argv, cwd = dataDir) {
      return ctx.cliHandler(argv, { stdin: '', cwd, signal: new AbortController().signal })
    },
    services: {
      use: (name) => {
        const handle = { on: (ev, fn) => ((handle.listeners[ev] = handle.listeners[ev] || []).push(fn), () => {}), listeners: {} }
        ctx.handles[name] = handle
        return new Proxy(handle, {
          get(target, prop) {
            if (prop in target) return target[prop]
            return async (...args) => {
              const impl = services[name]
              if (!impl) throw new Error(`no enabled plugin in this project provides service "${name}"`)
              if (typeof impl[prop] !== 'function') throw new Error(`service "${name}" (plugin cockpit.${name}) has no method "${String(prop)}"`)
              return structuredClone(await impl[prop](...structuredClone(args)))
            }
          },
        })
      },
      available: (name) => Boolean(services[name]),
      provide() {},
      emit() {},
      caller: () => undefined,
    },
    handles: {},
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  if (opts.old) {
    delete ctx.oauth
    delete ctx.secrets
    delete ctx.openExternal
    delete ctx.panels.header
    delete ctx.panels.onAction
  }
  return ctx
}

/** A fake triage service: a hint decides, else priority by lane; records every call. */
function fakeTriage() {
  const t = {
    calls: [],
    overrides: {},
    async classify(source, items) {
      t.calls.push({ source, items })
      const results = {}
      for (const it of items) {
        const o = t.overrides[it.id]
        if (o) results[it.id] = { priority: o.priority, kind: null, confidence: 1, by: 'override' }
        else if (it.hint) results[it.id] = { priority: it.hint.priority, kind: null, confidence: 1, by: 'hint' }
        else results[it.id] = { priority: it.fields.lane === 'unread' ? 'action' : 'fyi', kind: 'request', confidence: 0.4, by: 'jev' }
      }
      return { results, stats: { items: items.length } }
    },
    async override(source, id, v) {
      t.overrides[id] = v
    },
    async clear(source, id) {
      const had = id in t.overrides
      delete t.overrides[id]
      return had
    },
  }
  return t
}

const JIRA_SITE = 'https://acme.atlassian.net'

/**
 * A fake bronos.jira `jira` service (v1): `issues` key -> what issue() answers (merged over a
 * default open issue), `docs` key -> extra fields of document()'s answer. `issueDelay` / `docDelay`
 * (ms), `docError` (document rejects with it), `site` (what site() answers). Records every call.
 */
function fakeJiraService(opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const j = {
    calls: [],
    issues: opts.issues || {},
    async site() {
      j.calls.push(['site'])
      return opts.site || { ready: true, site: JIRA_SITE, senders: ['jira@acme.atlassian.net'], account: { accountId: 'acc-1', displayName: 'Oleg Example' } }
    },
    async issue(key, o) {
      j.calls.push(['issue', key, o])
      if (opts.issueDelay) await sleep(opts.issueDelay)
      const i = j.issues[key]
      if (!i) throw new Error(`jira: issue ${key}: Issue does not exist or you do not have permission to see it.`)
      return { key, summary: `Summary of ${key}`, status: 'In Progress', category: 'indeterminate', done: false, priority: 'High', type: 'Bug', assignee: 'Oleg Example', mine: true, lane: 'inProgress', url: `${JIRA_SITE}/browse/${key}`, updatedAt: 0, source: 'poll', at: 0, ...i }
    },
    async document(key, o) {
      j.calls.push(['document', key, o])
      if (opts.docDelay) await sleep(opts.docDelay)
      if (opts.docError) throw new Error(opts.docError)
      return {
        key,
        title: `${key}: Summary of ${key}`,
        url: `${JIRA_SITE}/browse/${key}`,
        html: `<div class="card"><h1>${key}: Summary of ${key}</h1></div>\n<h2>Description</h2>\n<p>The issue text of ${key}.</p>\n<p><img data-asset="att501" alt="shot.png"></p>`,
        aside: '<dl class="facts"><dt>Status</dt><dd>In Progress</dd></dl>',
        assets: [{ id: 'att501', name: 'shot.png', mime: 'image/png', dataUrl: `data:image/png;base64,${picture('png', 30).toString('base64')}` }],
        ...((opts.docs && opts.docs[key]) || {}),
      }
    },
  }
  return j
}

module.exports = { fakeJiraService, JIRA_SITE, fakeGmail, fakeOAuth, fakeSecrets, fakeStorage, fakeCtx, fakeTriage, tokens, fixture, tmpDir, picture, json, API, ME, NOW, T, CLIENT_ID, CLIENT_SECRET, SETTINGS_CLIENT }
