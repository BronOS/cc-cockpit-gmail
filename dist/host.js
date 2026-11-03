'use strict'
// bronos.gmail: your Gmail in lanes (Unread, Alerts, Read), sorted by jev-triage, read-only.
// Plain JavaScript with no build step; the pure logic is in ./lib (node:test suites in test/).
// Design: docs/design.md. The app API: `ccc guide api` (this file uses only what it documents).
// Built the way bronos.jira is built (its host is the model for this one).
//
// Life of a project window: activate reads the settings, the sign-in state and the stored lanes,
// then polls every `pollMinutes` while the window is open (a closed project has no host, so it does
// nothing). A poll asks Gmail's history whether anything changed (almost free); only then, or every
// 10th poll, it runs the lane searches and reads the changed threads' headers; then triage judges
// what changed, and the state goes to the panel. Nothing is polled until an OAuth client is set
// and the person signed in with Google.
//
// Read-only: no call here changes the mailbox. Opening a thread does not mark it read in Gmail.

const path = require('node:path')
const { readSettings } = require('./lib/settings')
const { createAuth, AuthError } = require('./lib/auth')
const { shortClientId } = require('./lib/oauth-client')
const { createClient } = require('./lib/client')
const { isBusy } = require('./lib/http')
const { poll, buildView, allRows, loadCache, emptyCache } = require('./lib/poll')
const { compactMessage } = require('./lib/model')
const { groupTitle } = require('./lib/alerts')
const { triageItem } = require('./lib/triage')
const { walkMessage, decodeText } = require('./lib/mime')
const { decode } = require('./lib/entities')
const { threadDocument } = require('./lib/document')
const { readableText, discussPrompt, gmailUrl, alertUrl } = require('./lib/readable')
const { selectImages, gatherImages, imageCache, MAX_IMAGE_BYTES, WAIT_MS } = require('./lib/images')
const { pickTab, isMissingAnnotate } = require('./lib/actions')
const { headerSpec } = require('./lib/header')
const { STEPS, linkUrl } = require('./lib/setup')
const { runCli } = require('./lib/cli')
const { jsonFile } = require('./lib/store')
const { hashOf, sha, oneLine, cut, rowId, mapLimit } = require('./lib/util')

const PANEL = 'main'
const SOURCE = 'gmail' // the triage source name: verdicts, overrides and cases group by it
const TRIAGE_CHUNK = 500 // triage.classify takes at most 500 items a call
const ROWS_PER_LANE = 300 // the panel message stays far below the 1 MiB post limit
const CLI_WAIT_MS = 25000 // `ccc` gives a handler 30 s
const IMAGE_TIMEOUT_MS = 20000
const BACKOFF_MAX_MINUTES = 30
const ALERT_THREADS_SHOWN = 10 // design: opening an alert row shows its newest 10 threads
const BODY_PART_MAX = 2 * 1024 * 1024 // a text body Gmail did not send inline, fetched apart
// The reader page gets the html in parts: a page message is at most 1,040,384 chars of JSON.
const PAGE_HTML_PART = 400000

let instance = null

/** What this app lacks of what the plugin needs (cc-cockpit 0.9.1); empty on a new enough app. */
function apiGaps(ctx) {
  const gaps = []
  if (!ctx.oauth || typeof ctx.oauth.authorize !== 'function' || typeof ctx.oauth.refresh !== 'function') gaps.push('ctx.oauth')
  if (!ctx.secrets || typeof ctx.secrets.get !== 'function') gaps.push('ctx.secrets')
  if (!ctx.panels || typeof ctx.panels.header !== 'function') gaps.push('ctx.panels.header')
  // ctx.openExternal came with the reviewer's `aside` (0.9.1): it stands in for that, too.
  if (typeof ctx.openExternal !== 'function') gaps.push('ctx.openExternal')
  return gaps
}

/**
 * The host, with its I/O injectable for the suites (`fetch`, timers, the clock). The app calls
 * `activate(ctx)`, which uses the real ones.
 */
function start(ctx, io = {}) {
  const fetchFn = io.fetch || globalThis.fetch
  const now = io.now || Date.now
  const triage = ctx.services.use('triage')
  const reviewer = ctx.services.use('reviewer')
  const cacheFile = jsonFile(ctx.dataDir, 'cache.json')
  const abort = new AbortController()
  const gaps = apiGaps(ctx)
  const tooOld = gaps.length ? `The Gmail plugin needs cc-cockpit 0.9.1 or later (this app has no ${gaps.join(', ')}). Update cc-cockpit, then reopen this project.` : null

  const S = {
    settings: readSettings(ctx.settings.project),
    cache: null, // poll.loadCache: the account, the lists and the threads' headers
    view: { lanes: [], unread: 0 },
    gen: 0, // bumped when the client or account changes: a poll of the old one is thrown away
    polling: null, // the running poll's promise: one at a time
    error: null, // the last poll's failure, shown as a notice
    laneErrors: {},
    stats: null,
    backoffMinutes: 0, // set while Gmail is busy (429 / 5xx): the poll interval, doubled each time
    verdicts: {}, // row id -> { priority, kind, confidence, by }
    sigs: {}, // row id -> hash of the triage item it was judged on
    triageError: null,
    classifying: Promise.resolve(),
    annotateMissing: false, // set when a call proved the reviewer has no annotate
    htmlRejected: null, // the reviewer's message when annotate took text but refused html
    labels: null, // label id -> name, read once a run when a thread shows a user label
    ui: { collapsed: {}, expanded: {} }, // per lane id; `expanded` = Show all pressed
    notice: null, // { text, kind: 'info'|'error' } after an action, until dismissed or replaced
    clientError: null, // why the pasted client file was refused (shown by the paste box)
    choose: null, // { id, tabs } when Discuss needs the person to pick a tab
    stopped: false,
  }
  const cfg = () => S.settings.cfg

  const auth = tooOld ? null : createAuth({ oauth: ctx.oauth, secrets: ctx.secrets, storage: ctx.storage, log: ctx.log, now })
  const gmail = createClient({ getToken: () => auth.token(), invalidate: () => auth.invalidate(), fetch: fetchFn })
  const signedIn = () => Boolean(auth) && auth.status().signedIn
  const clientHash = () => {
    const c = auth && auth.client()
    return c ? sha(c.clientId, 12) : ''
  }

  // ---- stored state ----

  const ready = (async () => {
    const ui = await ctx.storage.get('ui').catch(() => undefined)
    if (ui && typeof ui === 'object') {
      const obj = (v) => (v && typeof v === 'object' ? { ...v } : {})
      S.ui = { collapsed: obj(ui.collapsed), expanded: obj(ui.expanded) }
    }
    if (!auth) return
    await auth.load(cfg())
    S.cache = loadCache(await cacheFile.read(null), clientHash())
    const t = await ctx.storage.get('triage').catch(() => undefined)
    if (t && S.cache.account && t.account === S.cache.account && t.verdicts && t.sigs) {
      S.verdicts = t.verdicts
      S.sigs = t.sigs
    }
    rebuild()
  })().catch((e) => ctx.log.error('loading the stored state failed:', e && e.stack ? e.stack : e))

  function saveCache() {
    if (!S.cache) return Promise.resolve()
    return cacheFile.write(S.cache).catch((e) => ctx.log.warn('writing the thread cache failed:', e.message))
  }
  function saveTriage() {
    return ctx.storage.set('triage', { account: S.cache && S.cache.account, verdicts: S.verdicts, sigs: S.sigs }).catch((e) => ctx.log.warn('saving triage verdicts failed:', e.message))
  }

  /** Forget everything of the previous client or account: lanes, verdicts, a running poll's result. */
  function resetAccount() {
    S.gen++
    S.cache = emptyCache(clientHash())
    S.verdicts = {}
    S.sigs = {}
    S.error = null
    S.laneErrors = {}
    S.stats = null
    S.labels = null
    S.backoffMinutes = 0
    images = null
    rebuild()
    void saveCache()
    void saveTriage()
  }

  let images = null
  /** The image cache of the signed-in account. */
  function imgCache() {
    const account = (S.cache && S.cache.account) || ''
    if (!images || images.account !== account) images = { account, cache: imageCache(path.join(ctx.dataDir, 'images'), account) }
    return images.cache
  }

  // ---- the view ----

  function rebuild() {
    S.view = S.cache && signedIn() ? buildView({ cfg: cfg(), cache: S.cache, verdicts: triageOn() ? S.verdicts : {} }) : { lanes: [], unread: 0 }
    try {
      ctx.badge(PANEL, S.view.unread || null)
    } catch (e) {
      ctx.log.warn('badge:', e.message)
    }
  }

  function triageOn() {
    return ctx.services.available('triage')
  }
  function annotateOn() {
    return !S.annotateMissing && ctx.services.available('reviewer')
  }

  // ---- polling ----

  /** Poll now unless a poll is running (then that one's promise). Never rejects. */
  function pollNow(reason, force = false) {
    if (S.polling) return S.polling
    if (!auth || S.stopped) return Promise.resolve()
    S.polling = (async () => {
      try {
        await ready
        if (!signedIn()) return
        const gen = S.gen
        const cache = S.cache
        const r = await poll({ client: gmail, cfg: cfg(), cache, force, now: now(), signal: abort.signal })
        if (gen !== S.gen) return // signed out or another client meanwhile: not this account's lanes
        S.stats = r.stats
        S.laneErrors = r.laneErrors
        S.error = null
        if (r.changed) rebuild()
        for (const e of r.stats.threadErrors) ctx.log.warn(`reading thread ${e.id} failed: ${e.message}`)
        for (const [lane, m] of Object.entries(r.laneErrors)) ctx.log.warn(`${lane} search: ${m}`)
        await saveCache()
        ctx.log.info(`poll (${reason}): ${r.full ? `${r.stats.listed} listed, ${r.stats.fetched} read${r.stats.note ? `, ${r.stats.note}` : ''}` : 'no change'}`)
        // Some thread reads were refused as busy: what was read is shown, and the polls slow down.
        if (r.busy) failed(reason, r.busy)
        else if (S.backoffMinutes) {
          S.backoffMinutes = 0
          reschedule()
        }
        postState()
        if (r.changed) await classifyChanged()
      } catch (e) {
        failed(reason, e)
      } finally {
        S.polling = null
        postState()
      }
    })()
    postState()
    return S.polling
  }

  function failed(reason, e) {
    if (e instanceof AuthError && (e.kind === 'invalidGrant' || e.kind === 'signedOut')) {
      // The panel shows the sign-in again, with the reason; not an error notice on top of it.
      S.error = null
      rebuild()
      ctx.log.warn(`poll (${reason}): signed out (${e.kind})`)
      return
    }
    if (isBusy(e)) {
      S.backoffMinutes = Math.min(BACKOFF_MAX_MINUTES, (S.backoffMinutes || cfg().pollMinutes) * 2)
      reschedule()
      S.error = `${e.message} (every ${S.backoffMinutes} min for now).`
    } else {
      S.error = e && e.message ? e.message : String(e)
    }
    ctx.log.error(`poll (${reason}) failed: ${S.error}`)
  }

  let stopSchedule = null
  let scheduledMinutes = 0
  function reschedule() {
    if (tooOld) return
    const minutes = S.backoffMinutes || cfg().pollMinutes
    if (stopSchedule && minutes === scheduledMinutes) return
    if (stopSchedule) stopSchedule()
    scheduledMinutes = minutes
    // The tick only starts a poll and returns: a first poll can outlast ctx.schedule's 60 s per
    // run, and pollNow already keeps polls from overlapping.
    stopSchedule = ctx.schedule(minutes * 60, () => {
      void pollNow('schedule')
    })
  }
  reschedule()
  // Not inside activate: the poll ends in a triage call, and a service call during activate can
  // close a cycle (`ccc guide api`, Cycles).
  const firstPoll = tooOld ? null : (io.setTimeout || setTimeout)(() => void pollNow('start'), io.firstPollMs === undefined ? 1500 : io.firstPollMs)

  // ---- triage ----

  /**
   * Classify the rows whose triage item changed since they were judged (or `force`d by a triage
   * `change` event). One at a time: an event during a classify waits for it.
   */
  function classifyChanged(force = new Set()) {
    S.classifying = S.classifying.then(async () => {
      if (!triageOn() || !signedIn()) {
        S.triageError = null
        return
      }
      const me = (S.cache && S.cache.account) || ''
      const items = allRows(S.view).map((r) => triageItem(r, cfg().triageText, me))
      const ids = new Set(items.map((i) => i.id))
      const todo = items.filter((it) => force.has(it.id) || S.sigs[it.id] !== hashOf(it))
      // Forget verdicts of rows no longer shown (bounded by what the lanes hold).
      for (const k of Object.keys(S.verdicts)) if (!ids.has(k)) delete S.verdicts[k]
      for (const k of Object.keys(S.sigs)) if (!ids.has(k)) delete S.sigs[k]
      if (!todo.length) return
      try {
        for (let i = 0; i < todo.length; i += TRIAGE_CHUNK) {
          const chunk = todo.slice(i, i + TRIAGE_CHUNK)
          const { results } = await triage.classify(SOURCE, chunk)
          for (const it of chunk) {
            const v = results && results[it.id]
            if (v && !v.error && v.priority) {
              S.verdicts[it.id] = { priority: v.priority, kind: v.kind || null, confidence: typeof v.confidence === 'number' ? v.confidence : 1, by: v.by || '' }
              S.sigs[it.id] = hashOf(it)
            } else if (v && v.error) {
              ctx.log.warn(`triage of ${it.id}: ${v.error}`)
            }
          }
        }
        S.triageError = null
      } catch (e) {
        // jev-triage's own message (jev missing, a cap reached): the person reads it as is.
        S.triageError = e && e.message ? e.message : String(e)
        ctx.log.warn('triage:', S.triageError)
      }
      await saveTriage()
      rebuild()
      postState()
    })
    return S.classifying
  }

  // After a rescore, a correction or a jev-triage settings change: judge those ids again.
  triage.on('change', (data) => {
    if (!data || data.source !== SOURCE) return
    const force = new Set()
    if (data.ids === null || data.ids === undefined) S.sigs = {}
    else for (const id of data.ids) force.add(String(id))
    void classifyChanged(force)
  })

  // ---- settings ----

  ctx.onSettingsChange(async () => {
    S.settings = readSettings(ctx.settings.project)
    if (!auth) return postState()
    try {
      await ready
      // A different client id signs out (design): its refresh token is deleted in auth.js.
      if (await auth.settingsChanged(cfg())) resetAccount()
    } catch (e) {
      ctx.log.warn(`applying the settings failed: ${e.message}`)
    }
    reschedule()
    rebuild()
    postState()
    if (signedIn()) void pollNow('settings', true)
  })

  // ---- sign-in ----

  /** The browser sign-in, started from the panel or `ccc gmail login`; it settles in the background. */
  function startSignIn(from) {
    if (!auth) return { error: tooOld }
    if (!auth.client()) return { error: 'No OAuth client yet: paste the client file in the Gmail panel, or ccc gmail client <file.json>.' }
    // Already open: start over (the panel's "Start over", a second `ccc gmail login`). The stuck
    // case is Google's error page ("Access blocked"), which never comes back to the app.
    const restarted = auth.status().signingIn
    void (async () => {
      try {
        const r = await auth.signIn()
        // A new sign-in may be another Google account: nothing of the last one carries over.
        resetAccount()
        setNotice(r.sessionOnly ? `Signed in, but only until the app closes: ${r.sessionOnly}. Fix the keychain (ccc guide settings-secrets) and sign in again to stay signed in.` : 'Signed in with Google. Reading your mail…', r.sessionOnly ? 'error' : 'info')
        ctx.log.info(`signed in (${from})`)
        await pollNow('signin', true)
        // A poll of the old account was running (its result is thrown away): poll this one now.
        if (S.cache && !S.cache.lastPoll) await pollNow('signin', true)
        if (S.cache && S.cache.account && !r.sessionOnly) setNotice(`Signed in as ${S.cache.account}.`)
      } catch (e) {
        // Replaced by a newer sign-in: that one reports, this one says nothing.
        if (e && e.kind === 'superseded') return
        setNotice(e && e.message ? e.message : String(e), 'error')
      }
    })()
    postState()
    return { message: `${restarted ? 'Started over: the open sign-in is cancelled. ' : ''}Your browser opens the Google sign-in: finish it there (it gives up after 5 minutes). ccc gmail status shows the result.` }
  }

  async function signOut() {
    if (!auth) return { message: tooOld }
    await ready
    await auth.signOut()
    resetAccount()
    postState()
    return { message: 'Signed out: the stored Google sign-in of this project is deleted.' }
  }

  async function pasteClient(text) {
    if (!auth) return { ok: false, error: tooOld }
    await ready
    const r = await auth.pasteClient(text)
    if (!r.ok) {
      S.clientError = r.error
      postState()
      return r
    }
    S.clientError = null
    if (r.changed) resetAccount()
    const saved = `Client saved (${shortClientId(r.clientId)})`
    if (!r.changed) {
      setNotice(`${saved}; it is the client already in use.`)
      return { ok: true, message: `${saved}; it is the client already in use.` }
    }
    setNotice(`${saved}. Next: Sign in with Google.`)
    return { ok: true, message: `${saved}. Next: ccc gmail login.` }
  }

  async function removeClient() {
    await ready
    const r = await auth.removeClient()
    if (!r.ok) return setNotice(r.error, 'error')
    if (r.changed) resetAccount()
    setNotice(auth.client() ? 'The pasted client is removed; the client from the settings is used.' : 'The pasted client is removed.')
  }

  // ---- threads for the actions ----

  /** The row of an id in the current view, or null. */
  function rowOf(id) {
    return allRows(S.view).find((x) => x.id === id) || null
  }

  /**
   * A thread (or an alert group's newest threads) read fresh in full, for the view, `show` and
   * Discuss: `{ title, sender, messages, url, note, key, bodies }`.
   */
  async function loadThread(id, signal) {
    await ready
    if (!signedIn()) throw new Error(auth ? auth.status().signedOutReason || 'Not signed in to Google.' : tooOld)
    const which = rowId(id)
    if (!which) throw new Error('not a thread id')
    const account = (S.cache && S.cache.account) || ''
    let messages
    let title
    let url
    let note = ''
    let key
    if (which.thread) {
      const raw = await gmail.thread(which.thread, 'full', signal || abort.signal)
      messages = raw.messages.filter((m) => m && m.id != null)
      if (!messages.length) throw new Error('this thread has no messages')
      const facts = messages.map(compactMessage).sort((a, b) => a.at - b.at)
      title = (facts.find((m) => m.subject) || {}).subject || '(no subject)'
      url = gmailUrl(account, which.thread)
      key = `gmail:${which.thread}`
    } else {
      const row = rowOf(id)
      if (!row || row.kind !== 'alert') throw new Error('that alert is no longer in the Alerts lane (refresh?)')
      const ids = row.group.threadIds.slice(0, ALERT_THREADS_SHOWN)
      const got = await mapLimit(ids, 4, (tid) => gmail.thread(tid, 'full', signal || abort.signal))
      messages = got.filter((r) => r.ok).flatMap((r) => r.value.messages.filter((m) => m && m.id != null))
      const bad = got.filter((r) => !r.ok)
      if (!messages.length) throw bad.length ? bad[0].error : new Error('nothing to show: no thread of this alert')
      title = groupTitle(row.group)
      url = alertUrl(account, cfg().alertSenders, row.group.name)
      note = `${row.group.threadIds.length} thread${row.group.threadIds.length === 1 ? '' : 's'} of this alert${row.group.threadIds.length > ids.length ? `, the newest ${ids.length} shown` : ''}${bad.length ? `; ${bad.length} could not be read` : ''}`
      key = `gmail:alert:${sha(row.group.name, 16)}`
    }
    messages.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0))
    const lead = [...messages].reverse().map(compactMessage).find((m) => m.address !== account) || compactMessage(messages[messages.length - 1])
    const bodies = await bigBodies(messages, signal)
    return { title, sender: lead.from || lead.address, messages, url, note, key, bodies }
  }

  /** Text bodies Gmail did not send inline (very long mails): fetched as attachments, capped. */
  async function bigBodies(messages, signal) {
    const out = new Map()
    for (const m of messages) {
      const w = walkMessage(m)
      const part = w.html === null ? w.htmlPart : null
      const plainPart = w.plain === null ? w.plainPart : null
      const entry = {}
      for (const [k, p] of [['html', part], ['plain', plainPart]]) {
        if (!p || (p.size && p.size > BODY_PART_MAX)) continue
        try {
          const buf = await gmail.attachment(m.id, p.attachmentId, { maxBytes: BODY_PART_MAX, signal: signal || abort.signal })
          entry[k] = decodeText(buf.toString('base64url'), p.charset)
        } catch (e) {
          ctx.log.warn(`reading a long body of message ${m.id} failed: ${e.message}`)
        }
      }
      if (entry.html || entry.plain) out.set(String(m.id), entry)
    }
    return out
  }

  /** The user labels' names, read once a run (system labels need none). */
  async function labelNames(messages) {
    const ids = new Set(messages.flatMap((m) => (Array.isArray(m.labelIds) ? m.labelIds : [])))
    if (S.labels || ![...ids].some((x) => x.startsWith('Label_'))) return S.labels || {}
    try {
      S.labels = await gmail.labels(abort.signal)
    } catch (e) {
      ctx.log.warn(`reading the label names failed: ${e.message}`)
      S.labels = {}
    }
    return S.labels
  }

  /**
   * The thread as HTML plus the image assets: the image parts chosen by images.selectImages, from
   * the cache or downloaded, waited for at most WAIT_MS.
   */
  async function threadView(t, withAside) {
    const pics = t.messages.flatMap((m) => walkMessage(m).images.map((i) => ({ ...i, messageId: String(m.id), at: Number(m.internalDate) || 0 })))
    const { wanted } = selectImages(pics)
    let assets = []
    let byKey = new Map()
    if (wanted.length) {
      const r = await gatherImages({
        wanted,
        download: (img, signal) => gmail.attachment(img.messageId, img.attachmentId, { maxBytes: MAX_IMAGE_BYTES, signal: signal || abort.signal, timeoutMs: IMAGE_TIMEOUT_MS }),
        cache: imgCache(),
        waitMs: io.imageWaitMs === undefined ? WAIT_MS : io.imageWaitMs,
        signal: abort.signal,
      })
      assets = r.assets
      byKey = r.byKey
      for (const f of r.failed) ctx.log.warn(`image ${f.name}: ${f.message}`)
      if (r.late) ctx.log.info(`${r.late} image(s) not downloaded in time, listed by name (cached for the next open)`)
    }
    const doc = threadDocument({ title: t.title, messages: t.messages, assets: byKey, bodies: t.bodies, url: t.url, labels: await labelNames(t.messages), note: t.note, aside: Boolean(withAside) })
    return { html: doc.html, assets, aside: doc.aside }
  }

  function setNotice(text, kind = 'info') {
    S.notice = { text: cut(oneLine(text), 600), kind }
    postState()
  }

  /**
   * Open: the thread as clean HTML with its pictures in the reviewer, else as plain text in the
   * reviewer (a reviewer whose annotate takes text only), else in our own page. The chain, each
   * step taken once a call proved the one before is not there (as bronos.jira):
   *   annotate({ html, assets, aside }) -> rejected (not "no method") -> annotate({ text })
   *   -> "no method annotate" or no reviewer -> panels/thread.html with the same HTML.
   * Opening never marks the thread read in Gmail (read-only).
   */
  async function openThread(id) {
    const t = await loadThread(id)
    const text = readableText({ subject: t.title, messages: t.messages, url: t.url, note: t.note, bodies: t.bodies })
    const docs = {}
    const view = async (aside = false) => (docs[aside] = docs[aside] || (await threadView(t, aside)))
    if (annotateOn()) {
      const pick = pickTab(await ctx.sessions.list().catch(() => []))
      const base = { title: cut(oneLine(t.title), 200) || '(no subject)', ...(t.url ? { url: t.url } : {}), key: t.key, ...(pick.tabId ? { tabId: pick.tabId } : {}) }
      let htmlError = null
      if (!S.htmlRejected) {
        const v = await view(true)
        try {
          await reviewer.annotate({ ...base, html: v.html, ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}) })
          return
        } catch (e) {
          if (isMissingAnnotate(e)) noAnnotate()
          else {
            htmlError = e && e.message ? e.message : String(e)
            ctx.log.info(`reviewer refused the html of ${id} (${htmlError}); trying text`)
          }
        }
      }
      if (!S.annotateMissing) {
        try {
          await reviewer.annotate({ ...base, text: cut(text, 400000) })
          if (htmlError) {
            S.htmlRejected = htmlError
            ctx.log.info('reviewer.annotate takes text only: using text for this run')
            postState()
          }
          return
        } catch (e) {
          if (!isMissingAnnotate(e)) return setNotice(`The reviewer could not open the mail: ${e.message}${htmlError && htmlError !== e.message ? ` (html: ${htmlError})` : ''}`, 'error')
          noAnnotate()
        }
      }
    }
    await plainReader(id, t, await view(false))
  }

  function noAnnotate() {
    S.annotateMissing = true
    ctx.log.info("reviewer has no annotate (or none is enabled): using the plugin's reader page")
    postState()
  }

  /**
   * Without the reviewer's annotate: our own read-only page with Discuss, New session and ↗. It
   * gets the same HTML in parts, then one message per image, so no message passes the page limit.
   * A link click in the page comes back as `{ open }`.
   */
  async function plainReader(id, t, v) {
    let handle
    try {
      handle = ctx.overlay.start({ kind: 'html', file: 'panels/thread.html', title: cut(oneLine(t.title), 100) || 'Mail', size: 'large' })
    } catch (e) {
      return setNotice(`Cannot open the reader: ${e.message}`, 'error')
    }
    const parts = []
    for (let i = 0; i < v.html.length; i += PAGE_HTML_PART) parts.push(v.html.slice(i, i + PAGE_HTML_PART))
    try {
      handle.post({ type: 'doc', title: t.title, parts: parts.length, assets: v.assets.length })
      parts.forEach((part, i) => handle.post({ type: 'html', i, part }))
      for (const a of v.assets) handle.post({ type: 'asset', id: a.id, dataUrl: a.dataUrl })
    } catch (e) {
      ctx.log.warn(`posting to the reader: ${e.message}`)
    }
    // The links the page may ask to open: the ones this host put into the document (sanitize.js
    // kept only http(s) and mailto, normalised by URL as the page's a.href is). The guide's rule for
    // ctx.openExternal: a URL the host chose, never one taken from the page as is, so a page that
    // misbehaved still cannot send the browser anywhere the mail did not link to.
    const links = new Set([...v.html.matchAll(/<a href="([^"]*)"/g)].map((x) => decode(x[1])).filter((u) => /^https?:\/\//i.test(u)))
    handle.onMessage((m) => {
      if (m && typeof m.open === 'string' && links.has(m.open)) void openUrl(m.open)
    })
    const res = await handle.result.catch((e) => {
      setNotice(`The reader failed: ${e.message}`, 'error')
      return null
    })
    const action = res && res.kind === 'value' && res.value && typeof res.value === 'object' ? res.value.action : null
    if (action === 'discuss') await discuss(id)
    else if (action === 'newSession') await newSession(id)
    else if (action === 'browser') await openBrowser(id)
  }

  async function threadPrompt(id) {
    const t = await loadThread(id)
    return discussPrompt(t.title, t.sender, readableText({ subject: t.title, messages: t.messages, url: t.url, note: t.note, bodies: t.bodies }))
  }

  function labelOf(id) {
    const r = rowOf(id)
    if (!r) return 'the mail'
    return r.kind === 'alert' ? `the alert "${cut(r.group.name, 60)}"` : `"${cut(oneLine(r.facts.subject), 60)}"`
  }

  async function discuss(id, tabId) {
    const pick = pickTab(await ctx.sessions.list(), tabId)
    if (pick.error) return setNotice(pick.error, 'error')
    if (pick.choose) {
      S.choose = { id, label: labelOf(id), tabs: pick.choose }
      return postState()
    }
    S.choose = null
    const prompt = await threadPrompt(id)
    const r = await ctx.sessions.send(pick.tabId, prompt)
    setNotice(r && r.delivered ? `Sent ${labelOf(id)} to "${pick.label}".` : `Queued for "${pick.label}": it gets ${labelOf(id)} when Claude is waiting for input.`)
  }

  async function newSession(id) {
    const prompt = await threadPrompt(id)
    await ctx.sessions.open({ prompt })
    setNotice(`Opened a new Claude tab about ${labelOf(id)}.`)
  }

  async function openBrowser(id) {
    const which = rowId(id)
    const account = (S.cache && S.cache.account) || ''
    let url = null
    if (which && which.thread) url = gmailUrl(account, which.thread)
    else if (which && which.alert) url = alertUrl(account, cfg().alertSenders, which.alert)
    if (!url) return setNotice('No Gmail link for that row (the account is not known yet).', 'error')
    return openUrl(url)
  }

  /**
   * An http(s) address in the person's browser (↗, a setup link, a link in the reader page), with
   * ctx.openExternal. When the app refuses (its limit is 3 a 10 s), the address is shown so it can
   * be copied: the fallback that always works.
   */
  async function openUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return setNotice(`Only web links open from here; the address: ${cut(String(url), 300)}`)
    try {
      await ctx.openExternal(url)
    } catch (e) {
      setNotice(`Could not open the browser (${e && e.message ? e.message : e}). The address: ${url}`, 'error')
    }
  }

  async function wrong(id, priority) {
    if (!['urgent', 'action', 'fyi', 'noise'].includes(priority)) return
    await triage.override(SOURCE, id, { priority })
    delete S.sigs[id]
    await classifyChanged(new Set([id]))
    setNotice(`${labelOf(id)} is now ${priority} (your correction). Record why with Wrong? in the Jev triage panel, so it becomes a case for its eval.`)
  }

  async function undoWrong(id) {
    const had = await triage.clear(SOURCE, id)
    delete S.sigs[id]
    await classifyChanged(new Set([id]))
    setNotice(had ? `${labelOf(id)}: your correction is gone.` : `${labelOf(id)} had no correction.`)
  }

  // ---- panel ----

  function stateMessage() {
    const a = auth ? auth.status() : null
    const tOn = triageOn()
    const st = S.settings
    return {
      type: 'state',
      tooOld,
      // The setup guide while there is no sign-in; the page draws the steps and asks for the links.
      auth: a
        ? {
            client: a.client ? { source: a.client.source, id: a.client.id } : null,
            pasted: a.pasted,
            pastedBroken: a.pastedBroken,
            settingsMissing: a.settingsMissing,
            signedIn: a.signedIn,
            sessionOnly: a.sessionOnly,
            signingIn: a.signingIn,
            signedOutReason: a.signedOutReason,
          }
        : null,
      steps: STEPS,
      clientError: S.clientError,
      problems: st.problems,
      account: (S.cache && S.cache.account) || '',
      lastPoll: (S.cache && S.cache.lastPoll) || 0,
      polling: Boolean(S.polling),
      error: S.error,
      laneErrors: S.laneErrors,
      triage: { on: tOn, error: tOn ? S.triageError : null },
      annotate: annotateOn(),
      notice: S.notice,
      choose: S.choose,
      unread: S.view.unread,
      lanes: S.view.lanes.map((l) => ({
        id: l.id,
        title: l.title,
        collapsed: Boolean(S.ui.collapsed[l.id]),
        // Only the rows the panel draws are sent: `limit` from the setting, all (capped) after Show all.
        expanded: Boolean(S.ui.expanded[l.id]),
        limit: cfg().rowsPerLane,
        total: l.rows.length,
        rows: l.rows.slice(0, S.ui.expanded[l.id] ? ROWS_PER_LANE : cfg().rowsPerLane).map(rowJson),
      })),
    }
  }

  function rowJson(r) {
    if (r.kind === 'alert') {
      const g = r.group
      return { id: r.id, kind: 'alert', lane: r.lane, from: g.latest.from || g.latest.address, subject: groupTitle(g), snippet: '', at: r.at, unread: true, count: g.count, firing: g.firing, resolved: g.resolved, verdict: r.verdict }
    }
    const f = r.facts
    return { id: r.id, kind: 'thread', lane: r.lane, from: f.lead.from || f.lead.address, address: f.lead.address, subject: f.subject, snippet: f.lead.snippet, at: r.at, unread: r.unread, count: f.count, verdict: r.verdict }
  }

  function postState() {
    if (S.stopped) return
    try {
      ctx.panels.post(PANEL, stateMessage())
    } catch (e) {
      ctx.log.warn('panel post:', e.message)
    }
    setHeader()
  }

  // ---- the title bar ----

  let lastHeader = ''
  function setHeader() {
    if (tooOld || S.stopped) return
    const spec = headerSpec({ ready: signedIn(), polling: Boolean(S.polling), lastPoll: (S.cache && S.cache.lastPoll) || 0, account: (S.cache && S.cache.account) || '' }, now())
    // Every state message calls this (a click, a triage answer): unchanged headers are not resent.
    const json = JSON.stringify(spec)
    if (json === lastHeader) return
    lastHeader = json
    try {
      ctx.panels.header(PANEL, spec)
    } catch (e) {
      ctx.log.warn('panel header:', e.message)
    }
  }
  if (!tooOld) {
    ctx.panels.onAction(PANEL, (id) => {
      if (id === 'refresh') void pollNow('header', true)
    })
  }
  // "just now" turns into "5 min ago" with nothing else happening.
  const headerTimer = tooOld ? null : (io.setInterval || setInterval)(setHeader, 60000)

  ctx.panels.onMessage(PANEL, async (m) => {
    if (!m || typeof m !== 'object') return
    try {
      switch (m.type) {
        case 'hello':
          await ready
          return postState()
        case 'refresh':
          return void pollNow('panel', true)
        case 'toggle':
        case 'expand':
          if (typeof m.lane === 'string' && ['unread', 'alerts', 'read'].includes(m.lane)) {
            const key = m.type === 'toggle' ? 'collapsed' : 'expanded'
            S.ui[key][m.lane] = !S.ui[key][m.lane]
            ctx.storage.set('ui', S.ui).catch(() => {})
            return postState()
          }
          return
        case 'dismiss':
          S.notice = null
          S.choose = null
          S.clientError = null
          return postState()
        case 'link': {
          // A setup link: the page names it, the URL is ours (setup.js).
          const url = linkUrl(m.id)
          if (url) await openUrl(url)
          return
        }
        case 'client':
          if (typeof m.text === 'string') await pasteClient(m.text)
          return
        case 'removeClient':
          return await removeClient()
        case 'signIn': {
          const r = startSignIn('panel')
          if (r.error) setNotice(r.error, 'error')
          return
        }
        case 'signOut':
          await signOut()
          return setNotice('Signed out: the stored Google sign-in of this project is deleted.')
      }
      // The page is ours, but its id still goes into a URL path and a Gmail request: checked.
      const id = typeof m.id === 'string' && rowId(m.id) ? m.id : null
      if (!id) return
      switch (m.type) {
        case 'open':
          return await openThread(id)
        case 'discuss':
          return await discuss(id, typeof m.tabId === 'string' ? m.tabId : undefined)
        case 'newSession':
          return await newSession(id)
        case 'browser':
          return await openBrowser(id)
        case 'wrong':
          return await wrong(id, m.priority)
        case 'undoWrong':
          return await undoWrong(id)
      }
    } catch (e) {
      ctx.log.warn(`panel ${m.type}: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  })

  // ---- CLI ----

  function status() {
    const a = auth ? auth.status() : {}
    return {
      tooOld,
      client: a.client || null,
      pasted: a.pasted,
      pastedBroken: a.pastedBroken,
      settingsMissing: a.settingsMissing || [],
      signedIn: Boolean(a.signedIn),
      sessionOnly: a.sessionOnly,
      signingIn: a.signingIn,
      signedOutReason: a.signedOutReason,
      problems: S.settings.problems,
      account: (S.cache && S.cache.account) || '',
      lastPoll: (S.cache && S.cache.lastPoll) || 0,
      polling: Boolean(S.polling),
      pollMinutes: cfg().pollMinutes,
      backoffMinutes: S.backoffMinutes,
      counts: S.cache && S.cache.lists && signedIn() ? S.view.lanes.map((l) => ({ id: l.id, title: l.title, total: l.rows.length, unread: l.rows.filter((r) => r.unread).length })) : null,
      triage: triageOn() ? (S.triageError ? `error: ${S.triageError}` : 'on (bronos.jev-triage)') : 'off: install and enable Jev triage (bronos.jev-triage) to sort the lanes',
      annotate: annotateOn()
        ? S.htmlRejected
          ? `reviewer.annotate, text only (its html mode was refused: ${S.htmlRejected})`
          : 'reviewer.annotate (the thread as clean HTML with its pictures, notes on it)'
        : "the plugin's reader page (no reviewer with annotate in this project)",
      error: S.error,
      laneErrors: S.laneErrors,
      threadErrors: S.stats ? S.stats.threadErrors : [],
    }
  }

  ctx.cli.register('gmail', async (argv, call) => {
    await ready
    return runCli(
      argv,
      {
        status,
        async refresh() {
          const p = pollNow('cli', true)
          let timer
          const late = new Promise((r) => {
            timer = setTimeout(() => r('late'), io.cliWaitMs || CLI_WAIT_MS)
          })
          const got = await Promise.race([p.then(() => 'done'), late])
          clearTimeout(timer)
          if (got === 'late') return { pending: true }
          return S.error ? { error: S.error } : {}
        },
        view: () => S.view,
        async show(id, signal) {
          const t = await loadThread(id, signal)
          return readableText({ subject: t.title, messages: t.messages, url: t.url, note: t.note, bodies: t.bodies })
        },
        login: async () => startSignIn('cli'),
        logout: () => signOut(),
        client: (text) => pasteClient(text),
      },
      call,
    )
  })

  return {
    S,
    auth,
    ready,
    pollNow,
    classifyChanged,
    stop() {
      S.stopped = true
      abort.abort()
      if (headerTimer) (io.clearInterval || clearInterval)(headerTimer)
      if (firstPoll) (io.clearTimeout || clearTimeout)(firstPoll)
      if (stopSchedule) stopSchedule()
      return Promise.all([cacheFile.flush().catch(() => {}), images ? images.cache.flush() : null])
    },
  }
}

exports.activate = (ctx) => {
  instance = start(ctx)
  const gaps = apiGaps(ctx)
  ctx.log.info(gaps.length ? `activated on an app that is too old (no ${gaps.join(', ')})` : 'activated')
}

exports.deactivate = () => {
  const i = instance
  instance = null
  return i ? i.stop() : undefined
}

// For the suites: the host with fakes in place of fetch and timers.
exports._start = start
exports._apiGaps = apiGaps
