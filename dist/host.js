'use strict'
// bronos.gmail: your Gmail in lanes (Unread, Alerts, Read), sorted by jev-triage; since 0.3.0 it
// marks threads read or unread, and changes nothing else in the mailbox.
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
// Writes (0.3.0, design "Read state"): only the read state, through client.setUnread (the UNREAD
// label, nothing else; http.setThreadUnread is the plugin's only write), bounded by readstate.js's
// gate. Mark read / Mark unread on a row, `ccc gmail read|unread`, and opening a thread from the
// panel while the project setting markReadOnOpen is on (off by default since 0.4.0: a look should
// not take a thread out of Unread).

const path = require('node:path')
const { readSettings } = require('./lib/settings')
const { createAuth, AuthError } = require('./lib/auth')
const { shortClientId } = require('./lib/oauth-client')
const { createClient } = require('./lib/client')
const { isBusy, WRITE_SCOPE_TEXT } = require('./lib/http')
const { createGate, overlayCache, GateStopped } = require('./lib/readstate')
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
const F = require('./lib/feed')
const { hashOf, sha, oneLine, cut, rowId, mapLimit, gmailId } = require('./lib/util')
const { esc } = require('./lib/entities')
const J = require('./lib/jira')
const { MAX_TOTAL_CHARS } = require('./lib/images')

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
// Jira mail (0.2.0, the bronos.jira plugin's `jira` service). A poll waits for Jira at most this long
// (site() and the lookups of one triage round); what lands later re-judges the rows.
const JIRA_SITE_WAIT_MS = 2000
const JIRA_LOOKUP_WAIT_MS = 4000
// The thread view of a Jira mail: the issue beside the mail (the reviewer's `companion`, cc-cockpit
// 0.9.3+), else below it. The pictures are one budget for both in the reviewer (8 MiB and 30 in all),
// so they are split: the issue 7 pictures and 3.5 MiB of them, the mail 8 pictures and 4 MiB. Below
// the mail the issue also shares the mail's 2 MiB of html and gets at most 800 KB (its oldest
// comments give way); beside it, it is a document of its own and may take the Jira plugin's 2 MB.
const JIRA_VIEW_WAIT_MS = 15000
const JIRA_DOC = { maxHtmlBytes: 800000, maxImages: 7, maxImageChars: 3.5 * 1024 * 1024, waitMs: 8000 }
const JIRA_COMPANION_DOC = { ...JIRA_DOC, maxHtmlBytes: 2000000 }
// How long an open waits for the reviewer's features() (a host-local call; a provider still
// activating makes it wait).
const FEATURES_WAIT_MS = 2000
const MAIL_IMAGES_WITH_JIRA = { max: 8, totalChars: 4 * 1024 * 1024 }
const MAX_ASSETS = 30 // the reviewer's cap

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
  const jira = ctx.services.use('jira')
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
    // Mark read / unread shown before Gmail answers: thread id -> { unread, done, prev } (readstate.js).
    // `done`: Gmail took it; dropped after the next full poll that started later has read Gmail again.
    marks: new Map(),
    scopePromptHidden: false, // "Not now" on the sign-in-again prompt, for this run
    jiraKeys: new Map(), // row id -> the issue key of a Jira mail (classifyChanged), for the inbox-feed
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
    S.marks.clear()
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
    const marks = new Map([...S.marks].map(([id, m]) => [id, m.unread]))
    S.view = S.cache && signedIn() ? buildView({ cfg: cfg(), cache: overlayCache(S.cache, marks), verdicts: triageOn() ? S.verdicts : {} }) : { lanes: [], unread: 0 }
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
  function jiraOn() {
    return ctx.services.available('jira')
  }

  // ---- Jira mail (lib/jira.js; optional: without the jira service nothing here runs) ----

  const jiraSite = J.createSiteCache({ site: () => jira.site(), now })
  const lookups = J.createLookups({ issue: (key, o) => jira.issue(key, o), now, onLate: () => void classifyChanged() })

  /** The Jira hints of the rows that are Jira mail: row id -> `{ key, hint? , floor? }`. */
  async function jiraHints(rows, me) {
    const out = new Map()
    if (!jiraOn()) return out
    const j = await jiraSite.get(JIRA_SITE_WAIT_MS)
    if (!j) return out
    const found = []
    for (const r of rows) {
      const f = J.jiraFacts(r, j, me)
      if (f) found.push([r.id, f])
    }
    if (!found.length) return out
    // A move needs no lookup (rule 1); the others ask Jira, bounded in time.
    const wants = found.filter(([, f]) => f.key && !J.jiraHint(f, undefined)).map(([, f]) => ({ key: f.key, newestAt: f.newestAt }))
    const r = await lookups.ensure(wants, io.jiraLookupWaitMs === undefined ? JIRA_LOOKUP_WAIT_MS : io.jiraLookupWaitMs)
    if (r.late) ctx.log.info(`jira: ${r.late} issue lookup(s) still running; those rows are judged again when they land`)
    for (const [id, f] of found) {
      const h = J.jiraHint(f, f.key ? lookups.peek(f.key, f.newestAt) : undefined)
      out.set(id, { key: f.key, ...(h && h.hint ? { hint: h.hint } : {}), ...(h && h.floor ? { floor: h.floor } : {}) })
    }
    return out
  }

  /** A promise that rejects after `ms` (the Jira plugin's calls have no timeout of their own). */
  function within(p, ms) {
    let timer
    return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('the Jira plugin did not answer in time')), ms)))]).finally(() => clearTimeout(timer))
  }

  /**
   * Whether the reviewer can show a second document beside the first (annotate's `companion`): its
   * features() says so from cc-cockpit 0.9.3 on. An older reviewer has no features() (the call
   * rejects with "has no method") and would ignore a companion, so anything but a yes is a no.
   */
  async function reviewerHasCompanion() {
    try {
      const f = await within(reviewer.features(), FEATURES_WAIT_MS)
      return Array.isArray(f) && f.includes('companion')
    } catch {
      return false
    }
  }

  /**
   * The issue a thread opened in full is about, when it is Jira mail: `{ key, result, companion }`,
   * where `result` resolves (never rejects) with `{ issue, doc, note, url }` from the service,
   * started now so it runs while the mail's pictures download. `companion`: the issue is asked for
   * to be shown beside the mail (a larger html budget). Null for any other mail or without Jira.
   */
  async function jiraThread(t, { companion = false } = {}) {
    if (t.alert || !jiraOn()) return null
    const j = await jiraSite.get(JIRA_SITE_WAIT_MS)
    if (!j) return null
    const facts = t.messages.map(compactMessage)
    const texts = []
    t.messages.forEach((raw, i) => {
      if (!J.isFromJira(facts[i], j.senders)) return
      const w = walkMessage(raw)
      const extra = t.bodies && t.bodies.get(String(raw.id))
      for (const x of [w.html, w.plain, extra && extra.html, extra && extra.plain]) if (x) texts.push(decode(x))
    })
    const found = J.threadIssue({ title: t.title, facts, texts }, j)
    if (!found) return null
    const key = found.key
    const result = (async () => {
      const wait = io.jiraViewWaitMs === undefined ? JIRA_VIEW_WAIT_MS : io.jiraViewWaitMs
      const [i, d] = await Promise.allSettled([within(jira.issue(key, { maxAgeMs: 60000 }), wait), within(jira.document(key, companion ? JIRA_COMPANION_DOC : JIRA_DOC), wait)])
      const issue = i.status === 'fulfilled' && i.value && typeof i.value === 'object' ? i.value : null
      const doc = d.status === 'fulfilled' ? d.value : null
      const note = d.status === 'rejected' ? (d.reason && d.reason.message) || String(d.reason) : ''
      if (note) ctx.log.warn(`jira: the issue ${key} with the mail: ${note}`)
      const url = [doc && doc.url, issue && issue.url].find((u) => typeof u === 'string' && u.startsWith(`${j.site}/`)) || `${j.site}/browse/${key}`
      return { issue, doc, note, url }
    })()
    return { key, result, companion }
  }

  /** Jira's pictures that still fit beside the mail's: 30 and 7.5 MiB in all (the reviewer's 8 MiB, with room). */
  function fitAssets(own, extra) {
    let total = own.reduce((n, a) => n + a.dataUrl.length, 0)
    const out = []
    for (const a of extra) {
      if (own.length + out.length >= MAX_ASSETS || total + a.dataUrl.length > MAX_TOTAL_CHARS) continue
      total += a.dataUrl.length
      out.push(a)
    }
    return out
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
        // Marks Gmail took before this poll started: a full poll reads them back, so they can go.
        const settled = [...S.marks].filter(([, m]) => m.done)
        const r = await poll({ client: gmail, cfg: cfg(), cache, force, now: now(), signal: abort.signal })
        if (gen !== S.gen) return // signed out or another client meanwhile: not this account's lanes
        S.stats = r.stats
        S.laneErrors = r.laneErrors
        S.error = null
        let cleared = false
        // Only a full poll: a "no change" answer did not read the lists again.
        if (r.full) for (const [id, m] of settled) if (S.marks.get(id) === m) cleared = S.marks.delete(id) || cleared
        if (r.changed || cleared) rebuild()
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
        emitChanged()
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
      const rows = allRows(S.view)
      const jiraOf = await jiraHints(rows, me).catch((e) => {
        ctx.log.warn(`jira hints: ${e && e.message ? e.message : e}`)
        return new Map()
      })
      S.jiraKeys = new Map([...jiraOf].filter(([, v]) => v.key).map(([id, v]) => [id, v.key]))
      const items = rows.map((r) => triageItem(r, cfg().triageText, me, jiraOf.get(r.id) || null))
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
      emitChanged()
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
        // A new sign-in may be another Google account: nothing of the last one carries over. The same
        // account (signing in again to allow marking mail read, after invalid_grant) keeps its lanes
        // and verdicts, so nothing is read or judged again for it.
        const before = S.cache && S.cache.account
        let same = false
        if (before) {
          try {
            same = (await gmail.profile(abort.signal)).emailAddress === before
          } catch (e) {
            ctx.log.warn(`reading the account after the sign-in failed: ${e.message}`)
          }
        }
        if (same) {
          S.error = null
          S.scopePromptHidden = false
          rebuild()
        } else resetAccount()
        emitChanged() // Inbox hears the sign-in at once (a sync), not with the first poll
        const again = same && !r.sessionOnly ? `Signed in again as ${before}${auth.status().needsWriteScope ? '.' : ': Mark read and Mark unread work now.'}` : null
        setNotice(r.sessionOnly ? `Signed in, but only until the app closes: ${r.sessionOnly}. Fix the keychain (ccc guide settings-secrets) and sign in again to stay signed in.` : again || 'Signed in with Google. Reading your mail…', r.sessionOnly ? 'error' : 'info')
        ctx.log.info(`signed in (${from})`)
        await pollNow('signin', true)
        // A poll of the old account was running (its result is thrown away): poll this one now.
        if (S.cache && !S.cache.lastPoll) await pollNow('signin', true)
        if (!same && S.cache && S.cache.account && !r.sessionOnly) setNotice(`Signed in as ${S.cache.account}.`)
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
    let unreadThreads // the threads shown that have an unread message now (markReadOnOpen)
    const hasUnread = (msgs) => msgs.some((m) => Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'))
    if (which.thread) {
      const raw = await gmail.thread(which.thread, 'full', signal || abort.signal)
      messages = raw.messages.filter((m) => m && m.id != null)
      if (!messages.length) throw new Error('this thread has no messages')
      unreadThreads = hasUnread(messages) ? [which.thread] : []
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
      unreadThreads = ids.filter((tid, i) => got[i].ok && hasUnread(got[i].value.messages || []))
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
    return { title, sender: lead.from || lead.address, messages, url, note, key, bodies, alert: Boolean(which.alert), unreadThreads }
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
      // Not stored: a failure is retried on the next call (a poll or a thread view) instead of
      // leaving user label names out until restart.
      ctx.log.warn(`reading the label names failed: ${e.message}`)
      return {}
    }
    return S.labels
  }

  /**
   * The thread as HTML plus the image assets: the image parts chosen by images.selectImages, from
   * the cache or downloaded, waited for at most WAIT_MS. With `jx` (Jira mail) the issue comes too:
   * as `companion` (annotate's, beside the mail) when `beside` and its document came, else as a
   * section below the mail (a failed document leaves a short note there).
   */
  async function threadView(t, withAside, jx, beside = false) {
    const pics = t.messages.flatMap((m) => walkMessage(m).images.map((i) => ({ ...i, messageId: String(m.id), at: Number(m.internalDate) || 0 })))
    // With the Jira issue below the mail the picture budget is shared (JIRA_DOC).
    const { wanted } = selectImages(pics, jx ? MAIL_IMAGES_WITH_JIRA : {})
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
    let tail = ''
    let asideTail = ''
    let jiraAssets = []
    let companion = null
    if (jx) {
      const r = await jx.result
      const maxHtml = jx.companion ? JIRA_COMPANION_DOC.maxHtmlBytes : JIRA_DOC.maxHtmlBytes
      const checked = r.doc ? J.checkDocument(r.doc, maxHtml, new Set(assets.map((a) => a.id))) : null
      const ok = checked && !checked.error ? checked : null
      // A document asked for with the larger budget does not fit below the mail: there it is too long.
      const below = ok && Buffer.byteLength(ok.html, 'utf8') > JIRA_DOC.maxHtmlBytes ? null : ok
      const sec = J.jiraSection({ key: jx.key, url: r.url, issue: r.issue, doc: beside ? ok : below, note: (checked && checked.error) || (ok && !below ? 'the issue is too long to show below the mail' : '') || r.note, esc })
      if (beside && ok) {
        // Beside the mail: its own document, its own facts; the mail keeps its html and details alone.
        companion = J.jiraCompanion({ key: jx.key, checked: ok, assets: fitAssets(assets, ok.assets), url: r.url, fallbackFacts: sec.aside })
      } else {
        // Below the mail; any failure leaves the mail alone with a short note.
        tail = sec.html
        asideTail = sec.aside
        if (below) jiraAssets = fitAssets(assets, below.assets)
      }
    }
    const doc = threadDocument({ title: t.title, messages: t.messages, assets: byKey, bodies: t.bodies, url: t.url, labels: await labelNames(t.messages), note: t.note, aside: Boolean(withAside), tail, asideTail })
    return { html: doc.html, assets: [...assets, ...jiraAssets], aside: doc.aside, companion }
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
   * Jira mail: the issue goes beside the mail (annotate's `companion`) when the reviewer's features()
   * says it can; a refused companion call is tried once more with the issue below the mail, as an
   * older reviewer gets it, before text.
   * With markReadOnOpen on (off by default) the opened thread (an alert row: the threads it shows) is
   * marked read in Gmail meanwhile, as Gmail does; not when the sign-in cannot write (the panel asks
   * to sign in again instead).
   * The reviewer's overlay is up before the thread is read (its prepare, where it has one): reading a
   * thread with its pictures and its Jira issue takes seconds, with nothing on screen meanwhile
   * (real-work feedback 8). The annotate below fills that overlay; whatever else happens (a failed
   * read, our own reader page) closes it in the finally.
   */
  async function openThread(id) {
    const pre = await prepareView(id)
    // Without the reviewer our own reader page is the overlay, so it is up before the thread is read
    // (`ready: 'manual'`: its loader stays until the page has drawn the mail).
    const early = pre || annotateOn() ? null : startReader(id, (viewKeyOf(id) || {}).title)
    try {
      await showThread(id, pre, early)
    } finally {
      if (pre) await cancelView(pre)
      if (early && !early.used) early.handle.close()
    }
  }

  /**
   * The `inbox-item` type of a thread overlay (Inbox's and the buttons' key), or none for an alert
   * row (it shows several threads and is no feed item).
   */
  function overlayType(id) {
    const which = rowId(id)
    return which && which.thread ? { name: 'inbox-item', data: { source: ctx.pluginId, id: which.thread } } : null
  }

  /** The feed item an `inbox-item` overlay of ours names, or null (the data came from the opener: check it). */
  function ownItem(info) {
    const d = info && info.type && info.type.data
    if (!d || typeof d !== 'object' || d.source !== ctx.pluginId || typeof d.id !== 'string') return null
    return feedList(Infinity).find((i) => i.id === d.id) || null
  }

  /** The item's actions but open, with `run` = the same code as the feed's `act`; labels follow the item's state. */
  function overlayButtons(info) {
    const item = ownItem(info)
    if (!item) return []
    return item.actions.filter((a) => a.id !== 'open').map((a) => ({ id: a.id, label: a.label, run: async () => void (await feedAct(item.id, a.id)) }))
  }

  /** What Discuss with Claude sends for a thread overlay: subject, sender and snippet, capped. */
  function overlayDiscuss(id) {
    const item = feedList(Infinity).find((i) => i.id === id)
    if (!item) return null
    const from = item.from ? [item.from.name, item.from.address].filter(Boolean).join(' ') : ''
    return { text: cut([`Subject: ${item.title}`, from ? `From: ${from}` : '', item.preview || ''].filter(Boolean).join('\n'), 4000) }
  }

  if (ctx.overlay && typeof ctx.overlay.buttons === 'function') {
    // Dropped by the app when the plugin stops.
    ctx.overlay.buttons('inbox-item', (info) => overlayButtons(info))
  }

  /**
   * The reviewer key and title of a row before its thread is read, the ones loadThread and openThread's
   * annotate give it (`gmail:<thread>`, `gmail:alert:<hash>`), or null.
   */
  function viewKeyOf(id) {
    const which = rowId(id)
    if (!which) return null
    const row = rowOf(id)
    if (which.thread) return { key: `gmail:${which.thread}`, title: (row && row.facts && row.facts.subject) || '' }
    if (!row || row.kind !== 'alert') return null
    return { key: `gmail:alert:${sha(row.group.name, 16)}`, title: groupTitle(row.group) }
  }

  /**
   * Opens the reviewer's overlay of a row now, with its loader: `{ key }` when it did, else null (no
   * reviewer with annotate, or one without prepare, which rejects with "has no method": the overlay
   * then comes with the annotate, as before).
   */
  async function prepareView(id) {
    if (!annotateOn()) return null
    const v = viewKeyOf(id)
    if (!v) return null
    try {
      await within(reviewer.prepare({ key: v.key, title: cut(oneLine(v.title), 200) || '(no subject)' }), FEATURES_WAIT_MS)
      return { key: v.key }
    } catch {
      return null
    }
  }

  /** Closes a prepared overlay no annotate filled; a no-op once one did. */
  async function cancelView(pre) {
    await within(reviewer.cancel({ key: pre.key }), FEATURES_WAIT_MS).catch((e) => ctx.log.warn(`reviewer.cancel: ${e && e.message ? e.message : e}`))
  }

  async function showThread(id, pre, early) {
    const t = await loadThread(id)
    if (cfg().markReadOnOpen && canWrite() && t.unreadThreads.length) {
      void writeReadState(t.unreadThreads, false).then((r) => {
        if (r.failed && r.failed.length && !r.scope && !S.stopped) setNotice(`Opened, but it could not be marked read in Gmail: ${r.failed[0].message}`, 'error')
      })
    }
    // Asked only when it can matter: an html annotate this run, and Jira on.
    const beside = annotateOn() && !S.htmlRejected && jiraOn() && !t.alert ? await reviewerHasCompanion() : false
    const jx = await jiraThread(t, { companion: beside }).catch((e) => {
      ctx.log.warn(`jira: ${e && e.message ? e.message : e}`)
      return null
    })
    let text = readableText({ subject: t.title, messages: t.messages, url: t.url, note: t.note, bodies: t.bodies })
    const docs = {}
    // A thread of several mails opens at its newest (last) one; a single mail at its top (reviewer
    // `start`, app 0.9.4; an older reviewer ignores the field).
    const startAt = Array.isArray(t.messages) && t.messages.length > 1 ? { start: 'end' } : {}
    const view = async (aside = false, withCompanion = false) => {
      const k = `${aside}:${withCompanion}`
      return (docs[k] = docs[k] || (await threadView(t, aside, jx, withCompanion)))
    }
    const withJiraLine = async () => {
      if (!jx) return text
      const r = await jx.result
      return `${J.jiraLine(jx.key, r.issue, r.url)}\n\n${text}`
    }
    if (annotateOn()) {
      const pick = pickTab(await ctx.sessions.list().catch(() => []))
      const type = overlayType(id)
      // An older reviewer ignores `type`.
      const base = { title: cut(oneLine(t.title), 200) || '(no subject)', ...(t.url ? { url: t.url } : {}), key: t.key, ...(pick.tabId ? { tabId: pick.tabId } : {}), ...(type ? { type } : {}) }
      let htmlError = null
      if (!S.htmlRejected && jx && beside) {
        const v = await view(true, true)
        if (v.companion) {
          try {
            // The mail's column header: "Mail" and "Open in Gmail ↗" (the issue's says Jira).
            await reviewer.annotate({ ...base, ...startAt, label: 'Mail', urlLabel: 'Gmail', html: v.html, ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}), companion: v.companion })
            return
          } catch (e) {
            if (isMissingAnnotate(e)) noAnnotate()
            else ctx.log.info(`reviewer refused the issue beside ${id} (${e && e.message ? e.message : e}); trying it below the mail`)
          }
        }
      }
      if (!S.htmlRejected && !S.annotateMissing) {
        const v = await view(true)
        try {
          await reviewer.annotate({ ...base, ...startAt, html: v.html, ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}) })
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
          text = await withJiraLine()
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
    // Our own page instead of the reviewer's: its loader goes first (it cannot show this page).
    if (pre) await cancelView(pre)
    await plainReader(id, t, await view(false), early)
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
  /** Starts the reader page's overlay (before the thread is read when it can); null when the app refuses. */
  function startReader(id, title) {
    const type = overlayType(id)
    try {
      const handle = ctx.overlay.start({ kind: 'html', file: 'panels/thread.html', title: cut(oneLine(title || ''), 100) || 'Mail', size: 'large', ready: 'manual', ...(type ? { type } : {}) })
      if (type && typeof handle.onDiscuss === 'function') handle.onDiscuss(() => overlayDiscuss(type.data.id))
      return { handle, used: false }
    } catch (e) {
      setNotice(`Cannot open the reader: ${e.message}`, 'error')
      return null
    }
  }

  async function plainReader(id, t, v, early) {
    const started = early || startReader(id, t.title)
    if (!started) return
    started.used = true
    const handle = started.handle
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
    // The person clicked New session: the window shows the tab (an older app ignores `focus`).
    await ctx.sessions.open({ prompt, focus: true })
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

  // ---- read state (0.3.0: mark read / unread; lib/readstate.js) ----

  const gate = createGate({ now, sleep: io.sleep })
  const perThread = new Map() // thread id -> its last write: one thread's writes reach Gmail in order
  const writes = new Set() // running writeReadState calls (deactivate and the suites wait for them)

  /** Whether the sign-in may write (false: a gmail.readonly sign-in; the panel asks to sign in again). */
  function canWrite() {
    return Boolean(auth) && !auth.status().needsWriteScope
  }

  /**
   * Mark threads read (`unread` false) or unread in Gmail, shown at once: each thread's override
   * goes into S.marks and the panel gets the moved rows before the calls run (through the gate, one
   * thread's calls in order). A call that fails takes its override back (to the one before, when an
   * earlier mark of that thread is still waiting for a poll). Google refusing for the scope marks
   * the sign-in read-only (auth.scopeMissing) and shows the sign-in-again prompt. Resolves
   * `{ ok, done, failed: [{ id, message }], scope?, error? }`; never rejects.
   */
  function writeReadState(threadIds, unread) {
    const p = (async () => {
      try {
        await ready
        if (S.stopped) return { ok: false, done: 0, failed: [], error: 'the plugin is stopping' }
        if (!signedIn()) return { ok: false, done: 0, failed: [], error: auth ? auth.status().signedOutReason || 'Not signed in to Google.' : tooOld }
        if (!canWrite()) {
          S.scopePromptHidden = false
          postState()
          return { ok: false, done: 0, failed: [], scope: true, error: WRITE_SCOPE_TEXT }
        }
        const ids = [...new Set(threadIds.map((x) => gmailId(x)).filter(Boolean))]
        if (!ids.length) return { ok: true, done: 0, failed: [] }
        const gen = S.gen
        const mine = new Map()
        for (const id of ids) {
          const m = { unread, done: false, prev: S.marks.get(id) || null }
          S.marks.set(id, m)
          mine.set(id, m)
        }
        rebuild()
        postState()
        emitChanged()
        const results = await Promise.all(
          ids.map((id) => {
            const call = (perThread.get(id) || Promise.resolve())
              .catch(() => {})
              .then(() => {
                if (S.stopped || gen !== S.gen) throw new GateStopped()
                return gate.run(() => {
                  // Checked again when its turn comes: never a call on a disposed ctx.
                  if (S.stopped || gen !== S.gen) throw new GateStopped()
                  return gmail.setUnread(id, unread, abort.signal)
                })
              })
            perThread.set(id, call)
            const out = call.then(
              () => ({ id, ok: true }),
              (error) => ({ id, ok: false, error }),
            )
            void out.then(() => perThread.get(id) === call && perThread.delete(id))
            return out
          }),
        )
        if (S.stopped || gen !== S.gen) return { ok: false, done: 0, failed: [], error: 'the account changed or the plugin stopped meanwhile' }
        const failed = []
        let scope = false
        for (const r of results) {
          const m = mine.get(r.id)
          if (r.ok) {
            m.done = true
            continue
          }
          const message = r.error && r.error.message ? r.error.message : String(r.error)
          failed.push({ id: r.id, message })
          if (r.error && r.error.kind === 'scope') scope = true
          ctx.log.warn(`marking thread ${r.id} ${unread ? 'unread' : 'read'} failed: ${message}`)
          // Rolled back, unless a newer press of this thread replaced it meanwhile.
          if (S.marks.get(r.id) === m) {
            if (m.prev) S.marks.set(r.id, m.prev)
            else S.marks.delete(r.id)
          }
        }
        if (scope) {
          await auth.scopeMissing()
          S.scopePromptHidden = false
        }
        if (failed.length) {
          rebuild()
          postState()
          emitChanged() // the rolled-back rows are unread again
        }
        return { ok: !failed.length, done: ids.length - failed.length, failed, ...(scope ? { scope } : {}) }
      } catch (e) {
        ctx.log.warn(`mark ${unread ? 'unread' : 'read'}: ${e && e.message ? e.message : e}`)
        return { ok: false, done: 0, failed: [], error: e && e.message ? e.message : String(e) }
      }
    })()
    writes.add(p)
    void p.then(() => writes.delete(p))
    return p
  }

  /**
   * Mark read / Mark unread on a row (panel) or `ccc gmail read|unread`: a thread, or for read an
   * alert group (all of its unread threads). Resolves `{ ok, message }` or `{ error, scope? }`.
   */
  async function markRow(id, unread) {
    const which = rowId(id)
    if (!which) return { error: 'not a thread id' }
    let threadIds
    let what
    if (which.thread) {
      threadIds = [which.thread]
      what = labelOf(id) === 'the mail' ? `thread ${which.thread}` : labelOf(id)
    } else {
      if (unread) return { error: 'An alert group cannot be marked unread: mark one of its threads unread (its id from ccc gmail show).' }
      await ready
      const row = rowOf(id)
      if (!row || row.kind !== 'alert') return { error: 'that alert is no longer in the Alerts lane (refresh?)' }
      threadIds = row.group.threadIds
      what = labelOf(id)
    }
    const state = unread ? 'unread' : 'read'
    const r = await writeReadState(threadIds, unread)
    if (r.scope) return { error: WRITE_SCOPE_TEXT, scope: true }
    if (r.error) return { error: r.error }
    if (r.failed.length) {
      const n = threadIds.length
      return { error: `${n > 1 ? `${r.failed.length} of ${n} threads of ${what}` : what} could not be marked ${state} in Gmail: ${r.failed[0].message}. ${n > 1 ? 'Those are' : 'It is'} back where ${n > 1 ? 'they were' : 'it was'}.` }
    }
    return { ok: true, message: `Marked ${what}${threadIds.length > 1 ? ` (${threadIds.length} threads)` : ''} ${state} in Gmail.` }
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
      scope: F.scopeLine(cfg()),
      polling: Boolean(S.polling),
      error: S.error,
      laneErrors: S.laneErrors,
      triage: { on: tOn, error: tOn ? S.triageError : null },
      annotate: annotateOn(),
      // Mark read / unread: `prompt` = this sign-in only reads, ask to sign in again (until Not now).
      write: a && a.signedIn ? { allowed: !a.needsWriteScope, prompt: Boolean(a.needsWriteScope) && !S.scopePromptHidden, markReadOnOpen: cfg().markReadOnOpen } : null,
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
        case 'hideScopePrompt':
          S.scopePromptHidden = true
          return postState()
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
        case 'markRead':
        case 'markUnread': {
          // The row moved at once; only a failure says anything (the scope one is the prompt).
          const r = await markRow(id, m.type === 'markUnread')
          if (r.error && !r.scope) setNotice(r.error, 'error')
          return
        }
      }
    } catch (e) {
      ctx.log.warn(`panel ${m.type}: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  })

  // ---- the inbox-feed service (v2, lib/feed.js; Inbox reads it, cc-cockpit 0.9.7+) ----

  const feed = { sent: new Map(), state: null, stateKey: '', started: false } // what Inbox was last told: id -> item, and the Sync state (kind + message)

  /** The rows, the threads of their alert groups and the context the feed answers from. */
  function feedRows() {
    // Signed in: the view as the panel shows it (marks included). Signed out with a cache left (an
    // expired grant keeps it): the same view built from that cache, so Inbox can say "signed out,
    // showing the last items" as the contract asks.
    if (signedIn()) return { rows: allRows(S.view), threads: S.cache ? overlayThreads() : {} }
    if (!S.cache || !S.cache.lists) return { rows: [], threads: {} }
    const marks = new Map([...S.marks].map(([id, m]) => [id, m.unread]))
    const cache = overlayCache(S.cache, marks)
    return { rows: allRows(buildView({ cfg: cfg(), cache, verdicts: {} })), threads: cache.threads }
  }

  function overlayThreads() {
    return overlayCache(S.cache, new Map([...S.marks].map(([id, m]) => [id, m.unread]))).threads
  }

  /** All items of the scope (`limit`: the contract's 1000 by default). */
  function feedList(limit) {
    const { rows, threads } = feedRows()
    return F.feedItems(rows, { me: (S.cache && S.cache.account) || '', jiraKeys: S.jiraKeys, labelNames: S.labels || {}, threads, limit })
  }

  /** `ok`, `signedOut` or `error`, with the message the Sync carries. */
  function feedState() {
    const a = auth ? auth.status() : null
    if (!signedIn()) return { state: 'signedOut', message: cut(oneLine(tooOld || (a && (a.signedOutReason || (a.settingsMissing && a.settingsMissing.length ? 'Gmail is not set up in this project.' : ''))) || 'Not signed in to Google.'), 300) }
    if (S.error) return { state: 'error', message: cut(oneLine(S.error), 300) }
    return { state: 'ok' }
  }

  /** The Sync: the whole list from the cache, and the baseline the next diff starts from. */
  function feedSync() {
    const items = feedList()
    const st = feedState()
    feed.sent = new Map(items.map((i) => [i.id, i]))
    feed.state = st.state
    feed.stateKey = `${st.state}|${st.message || ''}`
    return { items, ...st, asOf: (S.cache && S.cache.lastPoll) || now() }
  }

  function feedEmit(event, data) {
    try {
      ctx.services.emit('inbox-feed', event, data)
    } catch (e) {
      ctx.log.warn(`inbox-feed ${event}:`, e && e.message ? e.message : e)
    }
  }

  /**
   * Tell Inbox what changed since it was last told (after a poll, a judgement, a mark): `item` per
   * changed or new thread, `gone` for the missing ones. A change of the Sync state (a sign-in, an
   * error, a recovery) is a `sync` instead: the source is unsure it told everything. Nothing before
   * the first sync (activate's cached view). Never throws: an older app has no listener to reach.
   */
  function emitFeed() {
    if (S.stopped || !feed.started || !ctx.services || typeof ctx.services.emit !== 'function') return
    try {
      const st = feedState()
      // The message counts too: error A -> error B or a new signed-out reason would otherwise stay stale in Inbox.
      if (`${st.state}|${st.message || ''}` !== feed.stateKey) return feedEmit('sync', feedSync())
      const next = feedList()
      const d = F.diffFeed(feed.sent, next)
      feed.sent = new Map(next.map((i) => [i.id, i]))
      for (const it of d.items) feedEmit('item', it)
      for (const ids of F.goneChunks(d.gone)) feedEmit('gone', { ids })
    } catch (e) {
      ctx.log.warn('inbox-feed:', e && e.message ? e.message : e)
    }
  }

  /** The user label names the feed's labels need, read once a run (the same call a thread's page makes). */
  async function feedLabelNames() {
    if (S.labels || !S.cache || !signedIn()) return
    const ids = new Set()
    for (const t of Object.values(S.cache.threads || {})) for (const m of t.messages || []) for (const l of m.labels || []) ids.add(l)
    await labelNames([{ labelIds: [...ids] }])
  }

  /** What a poll ends with: the label names, then the changes. */
  function emitChanged() {
    if (S.stopped) return
    void feedLabelNames().then(emitFeed, emitFeed)
  }

  void ready.then(() => {
    if (S.stopped || !ctx.services || typeof ctx.services.emit !== 'function') return
    feed.started = true
    feedEmit('sync', feedSync())
  })

  async function feedAct(id, action) {
    await ready
    const refuse = (message) => ({ ok: false, message: cut(oneLine(message), 300) })
    if (typeof id !== 'string' || typeof action !== 'string') return refuse('gmail: act takes an item id and an action id')
    const item = feedList(Infinity).find((i) => i.id === id)
    if (!item) return refuse('gmail: that thread is not in the inbox (refresh?)')
    if (!item.actions.some((a) => a.id === action)) return refuse(`gmail: this thread has no action "${cut(action, 40)}"`)
    try {
      if (action === 'open') await openThread(id)
      else {
        const r = await markRow(id, action === 'markUnread')
        if (r.error) return refuse(`gmail: ${r.error}`)
      }
      return { ok: true }
    } catch (e) {
      return refuse(`gmail: ${e && e.message ? e.message : e}`)
    }
  }

  if (ctx.services && typeof ctx.services.provide === 'function') {
    ctx.services.provide('inbox-feed', {
      describe: async () => ({ ...F.DESCRIBE, scope: F.scopeLine(cfg()) }),
      features: async () => [...F.FEATURES],
      async snapshot() {
        await ready
        return feedSync()
      },
      act: (id, action) => feedAct(id, action),
    })
  }

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
      write: a.signedIn
        ? a.needsWriteScope
          ? 'off: this sign-in only reads (from before version 0.3.0, or the Gmail box was unticked). Sign in again to allow marking mail read: ccc gmail login'
          : `mark read / unread on; opening a thread from the panel ${cfg().markReadOnOpen ? 'marks it read' : 'leaves it unread (markReadOnOpen off)'}`
        : null,
      jira: jiraOn() ? 'on (bronos.jira): Jira mail gets hints, and the issue shows beside the mail (below it with a reviewer older than cc-cockpit 0.9.3)' : 'off: enable the Jira plugin (bronos.jira) in this project for Jira mail hints and the issue beside the mail',
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
        // Bounded like refresh: a full write window (readstate.js) could make a call wait past `ccc`'s 30 s.
        async mark(id, unread) {
          let timer
          const late = new Promise((r) => {
            timer = setTimeout(() => r({ pending: true }), io.cliWaitMs || CLI_WAIT_MS)
          })
          const got = await Promise.race([markRow(id, unread), late])
          clearTimeout(timer)
          return got
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
    writesIdle: () => Promise.all([...writes]),
    stop() {
      S.stopped = true
      gate.stop()
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
