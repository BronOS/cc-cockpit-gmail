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
const { readSettings, readAppSettings } = require('./lib/settings')
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
const { threadDocument, buildCards, ACTION_SHOW, ACTION_ALWAYS, REMOTE_BAR_PART } = require('./lib/document')
const { htmlToText } = require('./lib/sanitize')
const R = require('./lib/remote')
const { readableText, discussPrompt, gmailUrl, alertUrl } = require('./lib/readable')
const { selectImages, gatherImages, imageCache, dataUrlLength, MAX_IMAGE_BYTES, WAIT_MS } = require('./lib/images')
const { pickTab, isMissingAnnotate } = require('./lib/actions')
const { headerSpec } = require('./lib/header')
const { STEPS, linkUrl } = require('./lib/setup')
const { runCli } = require('./lib/cli')
const { jsonFile } = require('./lib/store')
const F = require('./lib/feed')
const { hashOf, sha, oneLine, cut, rowId, mapLimit, gmailId, emailAddress, ALERT } = require('./lib/util')
const { esc } = require('./lib/entities')
const J = require('./lib/jira')
const { MAX_TOTAL_CHARS } = require('./lib/images')
const V = require('./lib/views')

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
// ctx.overlay.start gives no "shown" signal: main's refusal (3 open, 10 a minute) rejects the handle's
// `result` within one host-to-main round trip, while an overlay that opened settles only when it
// closes. Our reader page counts as up once this long passed without a rejection (the bundled
// reviewer's prepare and annotate wait the same).
const OVERLAY_SETTLE_MS = 500
const MAIL_IMAGES_WITH_JIRA = { max: 8, totalChars: 4 * 1024 * 1024 }
const MAX_ASSETS = 30 // the reviewer's cap
// The mails opened in the reviewer's mail layout whose Show images can still be answered (S.views):
// a click on an older one's bar is told to open the mail again. Each keeps its pictures' URLs only.
const VIEWS_KEPT = 10
// ctx.appStorage key of the always-show senders (app-wide: the settings page edits it in any window).
const SENDERS_KEY = 'imageSenders'
// The reviewer an older app's overlays are trusted from (one without ctx.services.provider, which
// cannot name the provider a project picked): the bundled one, since a `cockpit.*` id loads only from
// the app's own bundle. A newer app names the picked `reviewer` instead (reviewerId), so a
// replacement reviewer gets our item buttons and the bundled one, not picked, does not.
const FALLBACK_REVIEWER_ID = 'cockpit.reviewer'

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
    // Remote pictures (0.6.0): the app settings (Ask / Always, the proxy), the always-show senders as
    // last read from ctx.appStorage (read again on every open: another window may have changed it),
    // the reviewer keys the person pressed Show images on this run, and the open mails' pictures not
    // loaded yet (key -> { rest, room, address, loading }, the newest VIEWS_KEPT).
    app: readAppSettings(ctx.settings && ctx.settings.app),
    senders: [],
    shownKeys: new Set(),
    views: new Map(),
    // The Original | Reader view (0.6.0, the reviewer's 'original'): the reviewer key of each mail
    // opened with originals -> its sender's address, so the `view` event's switch is remembered for
    // that sender (the newest VIEWS_KEPT).
    viewSenders: new Map(),
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
    await loadSenders()
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

  /** The cache with the pending marks laid over it (what the panel and the feed show before the calls land). */
  function markedCache() {
    return overlayCache(S.cache, new Map([...S.marks].map(([id, m]) => [id, m.unread])))
  }

  function rebuild() {
    S.view = S.cache && signedIn() ? buildView({ cfg: cfg(), cache: markedCache(), verdicts: triageOn() ? S.verdicts : {} }) : { lanes: [], unread: 0 }
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

  /** Resolves null once an overlay is up (no refusal within OVERLAY_SETTLE_MS, or it already ended), else main's refusal. */
  function overlayRefusal(handle) {
    let timer
    const wait = new Promise((resolve) => (timer = setTimeout(resolve, OVERLAY_SETTLE_MS, null)))
    return Promise.race([handle.result.then(() => null, (e) => e || new Error('refused')), wait]).finally(() => clearTimeout(timer))
  }

  /** A promise that rejects after `ms` (the Jira plugin's calls have no timeout of their own). */
  function within(p, ms) {
    let timer
    return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('the Jira plugin did not answer in time')), ms)))]).finally(() => clearTimeout(timer))
  }

  /**
   * What the reviewer says it can do (its features(), cc-cockpit 0.9.3 on): 'companion' (a second
   * document beside the first), and from 0.13.0 'mail' (annotate's `kind: 'mail'`, the reading
   * layout), 'actions' (a document's `data-action` buttons, told as the service event `action`) and
   * 'update' (assets added to an open document). An older reviewer has no features() (the call
   * rejects with "has no method") and would ignore those fields, so anything but a yes is a no.
   */
  async function reviewerFeatures() {
    try {
      const f = await within(reviewer.features(), FEATURES_WAIT_MS)
      return Array.isArray(f) ? f.filter((x) => typeof x === 'string') : []
    } catch {
      return []
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
    let newest = null // the newest mail from Jira: its status change goes on the mail layout's card
    t.messages.forEach((raw, i) => {
      if (!J.isFromJira(facts[i], j.senders)) return
      const w = walkMessage(raw)
      const extra = t.bodies && t.bodies.get(String(raw.id))
      for (const x of [w.html, w.plain, extra && extra.html, extra && extra.plain]) if (x) texts.push(decode(x))
      if (!newest || (Number(raw.internalDate) || 0) >= newest.at) newest = { at: Number(raw.internalDate) || 0, w, extra }
    })
    const found = J.threadIssue({ title: t.title, facts, texts }, j)
    if (!found) return null
    const key = found.key
    // "Backlog → Ready to Test" as the mail states it: the plain part, else the html as text with the
    // pictures' alts (Jira draws the arrow as a picture). Read even when the issue lookup fails.
    let change = null
    if (newest) {
      const plain = newest.w.plain || (newest.extra && newest.extra.plain)
      const html = newest.w.html || (newest.extra && newest.extra.html)
      try {
        change = J.statusChange(plain || (html ? htmlToText(html, { alts: true }) : ''))
      } catch (e) {
        ctx.log.warn(`jira: reading the status change of ${key}: ${e.message}`)
      }
    }
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
    return { key, result, companion, change }
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
        emitWithLabels()
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
      emitWithLabels()
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

  // A click on our document's buttons in the reviewer (0.13.0): see onReviewerAction.
  if (typeof reviewer.on === 'function') reviewer.on('action', (d) => void onReviewerAction(d).catch((e) => ctx.log.warn(`reviewer action: ${e && e.message ? e.message : e}`)))
  // The Original | Reader switch on our mail (0.6.0): remembered per sender (onReviewerView).
  if (typeof reviewer.on === 'function') reviewer.on('view', (d) => void onReviewerView(d).catch((e) => ctx.log.warn(`reviewer view: ${e && e.message ? e.message : e}`)))

  // ---- settings ----

  // The always-show senders' page (settings/index.html, app scope). Every message is checked: the
  // page is a web page. An older app has no ctx.settingsPage (the form alone works there).
  if (ctx.settingsPage && typeof ctx.settingsPage === 'object' && typeof ctx.settingsPage.onOpen === 'function') {
    ctx.settingsPage.onOpen((page) => {
      const send = (m) => {
        try {
          page.post(m)
        } catch {}
      }
      page.onMessage(async (m) => {
        if (!m || typeof m !== 'object') return
        try {
          if (m.type === 'ready') return send({ type: 'senders', list: await loadSenders() })
          if (m.type !== 'add' && m.type !== 'remove') return
          const address = typeof m.address === 'string' ? emailAddress(m.address) : null
          if (!address) return send({ type: 'refused', reason: 'Not an email address: type one like ann@example.com.' })
          send({ type: 'senders', list: await changeSenders(address, m.type === 'add'), added: m.type === 'add' })
        } catch (e) {
          send({ type: 'refused', reason: `Not saved: ${e.message}` })
        }
      })
    })
  }

  ctx.onSettingsChange(async () => {
    const groupsBefore = cfg().alertGroupsInInbox
    const before = S.settings
    S.settings = readSettings(ctx.settings.project)
    S.app = readAppSettings(ctx.settings.app)
    // An app settings save (Remote images, the proxy) changes nothing a poll reads: no poll for it.
    if (JSON.stringify(before) === JSON.stringify(S.settings)) return postState()
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
    // Grouping on or off changes every alert item's id (a group's `alert:<name>` against its thread
    // ids): a `sync`, so Inbox drops the old ids at once, rather than a diff of gone and new items.
    if (cfg().alertGroupsInInbox !== groupsBefore && told.started && !S.stopped) feedEmit('sync', feedSync())
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
        emitWithLabels() // Inbox hears the sign-in at once (a sync), not with the first poll
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
   * `mode.mail` (a reviewer with the 'mail' feature): the reading layout, remote pictures as
   * placeholders the reviewer fills when update() brings them, the issue as a card under the subject,
   * no details column unless the issue is beside. Else remote pictures loaded are written as
   * pictures and the others as their labels (an older reviewer, our own reader page).
   * Remote pictures are loaded now only where showRemote allows (Always, a listed sender, Show images
   * pressed on this mail this run), alongside the mail's own pictures and the issue; `remote` in the
   * answer is what is left for a Show images press: `{ rest, room, address }`.
   */
  async function threadView(t, withAside, jx, beside = false, mode = {}) {
    const mail = Boolean(mode.mail)
    const pics = t.messages.flatMap((m) => walkMessage(m).images.map((i) => ({ ...i, messageId: String(m.id), at: Number(m.internalDate) || 0 })))
    // With the Jira issue below the mail the picture budget is shared (JIRA_DOC).
    const { wanted } = selectImages(pics, jx ? MAIL_IMAGES_WITH_JIRA : {})
    // Remote pictures get what the mail's own pictures (as budgeted, before they are downloaded) and
    // the issue's (its JIRA_DOC share, whether it uses it or not) leave of the reviewer's 30 / 7.5 MiB,
    // so the three can be fetched at once and none has to be dropped once they are in.
    const room = {
      count: Math.max(0, MAX_ASSETS - wanted.length - (jx ? JIRA_DOC.maxImages : 0)),
      chars: Math.max(0, MAX_TOTAL_CHARS - wanted.reduce((n, i) => n + dataUrlLength(i.size === null || i.size === undefined ? MAX_IMAGE_BYTES : i.size, i.mime), 0) - (jx ? JIRA_DOC.maxImageChars : 0)),
    }
    const remoteLoad = startRemote(t, mail, room, mail && Boolean(mode.original))
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
    const remoteAssets = remoteLoad ? (await remoteLoad).assets : []
    const loadedIds = new Set(remoteAssets.map((a) => a.id))
    assets = [...assets, ...remoteAssets]
    let tail = ''
    let asideTail = ''
    let jiraAssets = []
    let companion = null
    let related = ''
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
      // The mail layout's card: Jira's summary and status when the lookup answered, else the mail's own
      // words (its subject, "Backlog → Ready to Test"); Open is a link to the issue, which needs no
      // Jira call of ours (the reviewer opens links in the browser).
      if (mail) related = J.relatedCard({ key: jx.key, url: r.url, issue: r.issue, change: jx.change, subject: t.title, esc })
    }
    const opts = { title: t.title, messages: t.messages, assets: byKey, bodies: t.bodies, url: t.url, labels: await labelNames(t.messages), note: t.note, mail, original: mail && Boolean(mode.original), now: now(), remote: { loaded: (id) => loadedIds.has(id) } }
    const built = buildCards(opts)
    const rest = byWeight(built.remote.filter((r) => !loadedIds.has(r.id)))
    // The bar's Always show names the newest sender whose pictures wait (buildCards lists oldest first).
    const waiting = rest.filter((r) => !r.minor)
    const address = waiting.length ? emailAddress(waiting[waiting.length - 1].address) || '' : ''
    // The mail layout drops the details column (its header has the facts) unless the issue is beside.
    const aside = Boolean(withAside) && !(mail && !companion)
    const doc = threadDocument({ ...opts, built, aside, tail, asideTail, related, images: { actions: Boolean(mode.actions), address } })
    const all = [...assets, ...jiraAssets, ...(companion && Array.isArray(companion.assets) ? companion.assets : [])]
    const left = { count: Math.max(0, MAX_ASSETS - all.length), chars: Math.max(0, MAX_TOTAL_CHARS - all.reduce((n, a) => n + a.dataUrl.length, 0)) }
    return { html: doc.html, assets: [...assets, ...jiraAssets], aside: doc.aside, companion, remote: { rest, room: left, address }, originals: doc.originals || [] }
  }

  // ---- remote pictures (0.6.0; lib/remote.js has the fetch and its address rules) ----

  /** The non-minor pictures first: with a tight budget the content goes before logos and avatars. */
  function byWeight(refs) {
    return [...refs.filter((r) => !r.minor), ...refs.filter((r) => r.minor)]
  }

  /**
   * The remote pictures of `t` that may load as it opens, loading within `room`; null when none may
   * (the usual case under Ask: then the thread is not read an extra time for their addresses).
   */
  function startRemote(t, mail, room, original = false) {
    if (S.app.proxyBroken || room.count < 1 || room.chars < 1024) return null
    const shown = S.shownKeys.has(t.key)
    const allow = (address) => R.showRemote({ mode: S.app.remoteImages, senders: S.senders, address, shown })
    if (!t.messages.some((m) => allow(compactMessage(m).address))) return null
    // Their addresses: the thread built once without its own pictures (those do not change which remote
    // ones there are); threadView builds it again with everything once they are in.
    const refs = buildCards({ messages: t.messages, bodies: t.bodies, mail, original }).remote.filter((r) => allow(r.address))
    return refs.length ? loadPictures(byWeight(refs), room) : null
  }

  /** loadRemote with the app settings; failures logged by host only (a picture URL can carry a tracking token). */
  async function loadPictures(refs, room) {
    const r = await R.loadRemote(refs, { maxCount: room.count, budgetChars: room.chars, proxy: S.app.proxy, resolve: io.resolve, send: io.send, waitMs: io.remoteWaitMs, signal: abort.signal })
    for (const f of r.failed) ctx.log.warn(`remote image from ${hostOf(f.url)}: ${f.message}`)
    return r
  }

  function hostOf(url) {
    try {
      return new URL(url).host
    } catch {
      return '?'
    }
  }

  /** Whether ctx.appStorage is there (cc-cockpit 0.3.0 on; the plugin needs 0.9.1, so only a fake lacks it). */
  function appStore() {
    return ctx.appStorage && typeof ctx.appStorage.get === 'function' ? ctx.appStorage : null
  }

  /** The always-show senders from ctx.appStorage (S.senders kept on a failed read). */
  async function loadSenders() {
    const store = appStore()
    if (!store) return S.senders
    try {
      S.senders = R.cleanSenders(await store.get(SENDERS_KEY))
    } catch (e) {
      ctx.log.warn(`reading the always-show senders failed: ${e.message}`)
    }
    return S.senders
  }

  /**
   * Adds or removes one sender: read, changed, written (another window can write between the two; the
   * list is a person's clicks, so a lost one is unlikely and harmless). Resolves the new list.
   */
  async function changeSenders(address, add) {
    const store = appStore()
    if (!store) throw new Error('this cc-cockpit has no app-wide storage')
    const list = R.cleanSenders(await store.get(SENDERS_KEY))
    const next = add ? (list.includes(address) ? list : [...list, address]) : list.filter((a) => a !== address)
    if (add && next.length > R.MAX_SENDERS) throw new Error(`the list holds at most ${R.MAX_SENDERS} senders`)
    if (next !== list) await store.set(SENDERS_KEY, next)
    S.senders = next
    return next
  }

  /** Keeps what a Show images press on the mail `key` needs; the oldest past VIEWS_KEPT go. */
  function rememberView(key, remote) {
    S.views.delete(key)
    if (!remote || !remote.rest.length) return
    S.views.set(key, { rest: remote.rest, room: remote.room, address: remote.address, loading: null })
    while (S.views.size > VIEWS_KEPT) S.views.delete(S.views.keys().next().value)
  }

  // ---- the Original | Reader view (0.6.0; lib/views.js) ----

  /** The address of the thread's newest message's sender (lower case), or ''. */
  function threadSender(t) {
    const msgs = Array.isArray(t.messages) ? [...t.messages].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0)) : []
    const last = msgs[msgs.length - 1]
    return last ? emailAddress(compactMessage(last).address || '') || '' : ''
  }

  function rememberSender(key, address) {
    S.viewSenders.delete(key)
    S.viewSenders.set(key, address)
    while (S.viewSenders.size > VIEWS_KEPT) S.viewSenders.delete(S.viewSenders.keys().next().value)
  }

  /** The per-sender choices from ctx.appStorage ([] when unreadable: the setting decides then). */
  async function loadViews() {
    const store = appStore()
    if (!store) return []
    try {
      return V.cleanViews(await store.get(V.VIEWS_KEY))
    } catch (e) {
      ctx.log.warn(`reading the view choices failed: ${e.message}`)
      return []
    }
  }

  /**
   * The reviewer's `view` event: the person switched a mail of ours between Original and Reader. Kept
   * for its sender (read, changed, written: another window may write between, and a lost click is
   * harmless). `caller` names whose document it was (set by the reviewer), as for actions.
   */
  async function onReviewerView(d) {
    if (!d || typeof d !== 'object' || d.caller !== ctx.pluginId || typeof d.key !== 'string' || !V.VIEWS.includes(d.view)) return
    const address = S.viewSenders.get(d.key)
    const store = appStore()
    if (!address || !store) return
    const before = V.cleanViews(await store.get(V.VIEWS_KEY))
    const next = V.chooseView(before, address, d.view)
    if (next !== before) await store.set(V.VIEWS_KEY, next)
  }

  /**
   * A click on a button of our document in the reviewer (its service event `action`, sent to every
   * user of the service: `caller` names whose document it was, set by the reviewer, so another
   * plugin's clicks and a forged key of ours both end here). Show images loads this mail's pictures;
   * Always show from <sender> puts the sender on the list first. The pictures go into the open
   * document with update() (no new annotate: that would only focus it); the bar goes once one is in,
   * and stays, with the reason as the status line, when none could be loaded.
   */
  async function onReviewerAction(d) {
    if (!d || typeof d !== 'object' || d.caller !== ctx.pluginId || typeof d.key !== 'string') return
    // Try again on the error page of a failed read (failView).
    if (d.id === 'retry') return retryOpen(d.key)
    if (d.id !== ACTION_SHOW && d.id !== ACTION_ALWAYS) return
    const v = S.views.get(d.key)
    if (!v) return reviewerUpdate({ key: d.key, status: 'Open this mail again to show its images.' })
    if (d.id === ACTION_ALWAYS && v.address) {
      try {
        await changeSenders(v.address, true)
      } catch (e) {
        ctx.log.warn(`adding ${v.address} to the always-show senders failed: ${e.message}`)
      }
    }
    S.shownKeys.add(d.key)
    // A second press while the first loads (the reviewer disables the button, but a second button can
    // be pressed) joins it rather than fetching the same pictures twice.
    if (!v.loading) v.loading = showPictures(d.key, v).finally(() => (v.loading = null))
    return v.loading
  }

  async function showPictures(key, v) {
    if (S.app.proxyBroken) return reviewerUpdate({ key, status: 'The image proxy setting is not valid (Settings › Plugins › Gmail): no images are loaded.' })
    const r = await loadPictures(v.rest, v.room)
    const got = new Set(r.assets.map((a) => a.id))
    v.rest = v.rest.filter((x) => !got.has(x.id))
    v.room = { count: Math.max(0, v.room.count - r.assets.length), chars: Math.max(0, v.room.chars - r.assets.reduce((n, a) => n + a.dataUrl.length, 0)) }
    const missed = v.rest.filter((x) => !x.minor).length
    const first = r.failed[0]
    let status = ''
    if (missed) status = `${missed} image${missed === 1 ? '' : 's'} could not be loaded${first ? ` (${cut(first.message, 120)})` : ' (too many or too big for one view)'}.`
    // Every picture failed: the bar stays (the person may try again, or see why).
    const keepBar = !r.assets.length && missed > 0
    await reviewerUpdate({ key, ...(r.assets.length ? { assets: r.assets } : {}), ...(keepBar ? {} : { hide: [REMOTE_BAR_PART] }), ...(status ? { status } : {}) })
    if (!v.rest.length) S.views.delete(key)
  }

  /** reviewer.update, logged on failure (the overlay may have closed while the pictures loaded). */
  async function reviewerUpdate(u) {
    try {
      await within(reviewer.update(u), FEATURES_WAIT_MS)
    } catch (e) {
      ctx.log.info(`reviewer.update ${u.key}: ${e && e.message ? e.message : e}`)
    }
  }

  function setNotice(text, kind = 'info') {
    S.notice = { text: cut(oneLine(text), 600), kind }
    postState()
  }

  /** Close an overlay handle that is not needed; a throw here must not mask the error of the `finally` it runs in. */
  function closeQuietly(handle) {
    try {
      handle.close()
    } catch {}
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
   * marked read in Gmail once it is on screen, as Gmail does; not when the sign-in cannot write (the
   * panel asks to sign in again instead).
   * The reviewer's overlay is up before the thread is read (its prepare, where it has one): reading a
   * thread with its pictures and its Jira issue takes seconds, with nothing on screen meanwhile
   * (real-work feedback 8). The annotate below fills that overlay; a failed read turns it into the
   * error page with Try again where the reviewer has `fail` (failView); whatever else happens (an
   * older reviewer's failed read, our own reader page) closes it in the finally.
   * `onStarted` (feed act) runs only once something is on screen: the prepared overlay, our reader
   * page, or (neither: a reviewer without prepare, a prepare that failed or ran past its wait) the
   * filled view at the end. Called earlier, a failed read reached only this panel's notice while
   * the person clicked in Inbox, and Inbox ended the item's "back" mark for an open never seen.
   */
  async function openThread(id, onStarted) {
    const shown = () => {
      if (onStarted) onStarted()
    }
    const pre = await prepareView(id)
    // Without the reviewer our own reader page is the overlay, so it is up before the thread is read
    // (`ready: 'manual'`: its loader stays until the page has drawn the mail).
    const early = pre || annotateOn() ? null : startReader(id, (viewKeyOf(id) || {}).title)
    // Our page counts once main did not refuse it (a refused one fails the open in plainReader).
    if (pre) shown()
    else if (early) void early.refusal.then((e) => e || shown())
    try {
      await showThread(id, pre, early, shown)
    } finally {
      // A loader turned into the read's error page (failView) stays: it is the person's to close.
      if (pre && !pre.failed) await cancelView(pre)
      if (early && !early.used) closeQuietly(early.handle)
    }
  }

  // Threads whose reviewer loader shows a failed read with Try again (failView): key -> row id.
  const failedViews = new Map()

  /**
   * A read that failed after the reviewer's loader was up: the loader shows the error with Try again
   * (the reviewer's `fail`, cc-cockpit 0.13.2) instead of closing. Cancelling it, as before, made a
   * network outage flash the overlay open and shut with no reason on screen: the error reached only
   * this panel's notice, which a click in Inbox never shows. The act contract stays: the loader was on
   * screen, so the feed's act answered ok at prepare; nothing is marked read (seen() never ran).
   * True when the reviewer took it; false (an older reviewer without 'fail', the person closed the
   * loader meanwhile) leaves the cancel to openThread's finally, as before.
   */
  async function failView(pre, id, e) {
    const msg = oneLine(e && e.message ? e.message : String(e))
    const head = (e && (e.kind === 'network' || e.kind === 'timeout')) || /^cannot reach /i.test(msg) ? "Can't reach Gmail" : 'Could not load this mail'
    try {
      if (!(await reviewerFeatures()).includes('fail')) return false
      // Try again only when its click can reach us (the event `action`).
      const retry = typeof reviewer.on === 'function'
      const r = await within(reviewer.fail({ key: pre.key, message: cut(`${head}: ${msg}`, 300), retry }), FEATURES_WAIT_MS)
      if (!(r && r.failed)) return false
      if (retry) failedViews.set(pre.key, id)
      return true
    } catch (err) {
      ctx.log.warn(`reviewer.fail: ${err && err.message ? err.message : err}`)
      return false
    }
  }

  /**
   * Try again on an error page of ours (the reviewer's event `action` { key, id: 'retry' }, our caller
   * checked by onReviewerAction): the normal open again, so the reviewer takes the page back to its
   * loader (prepare), and the mail or the error once more fills it.
   */
  async function retryOpen(key) {
    const id = failedViews.get(key)
    if (id === undefined) return
    failedViews.delete(key)
    try {
      await openThread(id)
    } catch (e) {
      // As a panel click's open: the log and the notice, beside the error page the retry put up again.
      ctx.log.warn(`retry open: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  }

  /**
   * The `inbox-item` type of a thread overlay (Inbox's and the buttons' key). An alert row's overlay
   * is one too while the feed sends alert groups (its id is the group's feed id); with that setting
   * off it is none: it shows several threads and is no feed item.
   */
  function overlayType(id) {
    const which = rowId(id)
    if (which && which.thread) return { name: 'inbox-item', data: { source: ctx.pluginId, id: which.thread } }
    if (which && which.alert && cfg().alertGroupsInInbox) return { name: 'inbox-item', data: { source: ctx.pluginId, id: F.groupItemId(which.alert) } }
    return null
  }

  /**
   * The feed item an `inbox-item` overlay of ours names, or null (the data came from the opener: check it).
   * Only a thread still in the feed counts: one that left it (out of every lane, e.g. read and older than readDays) is no
   * item Inbox shows, so its overlay gets no buttons, as `act` refuses it.
   */
  function ownItem(info) {
    if (!info || !trustedOpener(info.opener)) return null
    const d = info.type && info.type.data
    if (!d || typeof d !== 'object' || d.source !== ctx.pluginId || typeof d.id !== 'string') return null
    return feedItemOf(d.id)
  }

  /**
   * Whether an overlay's opener may get our item buttons: we (the reader page) or the reviewer we hand
   * the item to. `opener` is the app's record of who opened it (OverlayInfo), unlike `data`: another
   * plugin opening an overlay that names one of our threads gets none of our item buttons.
   */
  function trustedOpener(opener) {
    if (opener === ctx.pluginId) return true
    const reviewer = reviewerId()
    return typeof reviewer === 'string' && reviewer !== '' && opener === reviewer
  }

  /**
   * The plugin our `reviewer` calls reach right now, asked at button time (the project's pick can
   * change while we run), or null when none does. An older app without ctx.services.provider: the
   * bundled reviewer. A throw (not expected: `reviewer` is in our uses) trusts no reviewer.
   */
  function reviewerId() {
    if (typeof ctx.services.provider !== 'function') return FALLBACK_REVIEWER_ID
    try {
      return ctx.services.provider('reviewer')
    } catch {
      return null
    }
  }

  /**
   * The item's actions but open, with `run` = the same code as the feed's `act`; labels follow the item's state.
   * A refused act (a Gmail error) goes to the panel's notice and is thrown: the app only logs a run
   * that throws, and an answer it does not read would make a failed Mark read silent.
   */
  function overlayButtons(info) {
    const item = ownItem(info)
    if (!item) return []
    const run = async (action) => {
      const r = await feedAct(item.id, action)
      if (r && r.ok === false) {
        setNotice(r.message, 'error')
        throw new Error(r.message)
      }
    }
    return item.actions.filter((a) => a.id !== 'open').map((a) => ({ id: a.id, label: a.label, run: () => run(a.id) }))
  }

  /** What Discuss with Claude sends for a thread overlay: subject, sender and snippet, capped. */
  function overlayDiscuss(id) {
    const item = feedItemOf(id)
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
      // The type goes with prepare: the reviewer fixes an overlay's type when it starts, so the
      // annotate that fills a prepared overlay cannot add it later (an older reviewer ignores it).
      const type = overlayType(id)
      await within(reviewer.prepare({ key: v.key, title: cut(oneLine(v.title), 200) || '(no subject)', ...(type ? { type } : {}) }), FEATURES_WAIT_MS)
      return { key: v.key }
    } catch {
      return null
    }
  }

  /** Closes a prepared overlay no annotate filled; a no-op once one did. */
  async function cancelView(pre) {
    await within(reviewer.cancel({ key: pre.key }), FEATURES_WAIT_MS).catch((e) => ctx.log.warn(`reviewer.cancel: ${e && e.message ? e.message : e}`))
  }

  async function showThread(id, pre, early, shown = () => {}) {
    let t
    try {
      t = await loadThread(id)
    } catch (e) {
      // The loader shows the failure (and openThread leaves it); the error still goes on to the
      // panel's notice and the log, as before.
      if (pre) pre.failed = await failView(pre, id, e)
      throw e
    }
    // Marked read only once the mail is on screen (the same places shown() runs): marking it right
    // after the read left a mail read in Gmail whose open was then refused, or whose loader the person
    // closed (annotate's { opened: false }), so they never saw it (phase-1 review round 4).
    const seen = () => {
      shown()
      if (cfg().markReadOnOpen && canWrite() && t.unreadThreads.length) {
        void writeReadState(t.unreadThreads, false).then((r) => {
          if (r.failed && r.failed.length && !r.scope && !S.stopped) setNotice(`Opened, but it could not be marked read in Gmail: ${r.failed[0].message}`, 'error')
        })
      }
    }
    // A loader the person closed while the mail was read: the reviewer shows nothing, so nothing is marked.
    const opened = (r) => !(r && r.opened === false)
    // Asked only when it can matter: an html annotate this run.
    const features = annotateOn() && !S.htmlRejected ? await reviewerFeatures() : []
    const beside = jiraOn() && !t.alert && features.includes('companion')
    // The mail layout; its images bar gets buttons only when a click can come back and be answered.
    const mode = {
      mail: features.includes('mail'),
      actions: features.includes('mail') && features.includes('actions') && features.includes('update'),
      // The Original view: each message's own HTML and CSS beside the Reader rendering (0.6.0).
      original: features.includes('mail') && features.includes('original'),
    }
    await loadSenders()
    const jx = await jiraThread(t, { companion: beside }).catch((e) => {
      ctx.log.warn(`jira: ${e && e.message ? e.message : e}`)
      return null
    })
    let text = readableText({ subject: t.title, messages: t.messages, url: t.url, note: t.note, bodies: t.bodies })
    const docs = {}
    // A thread of several mails opens at its newest (last) one; a single mail at its top (reviewer
    // `start`, app 0.9.4; an older reviewer ignores the field).
    const startAt = Array.isArray(t.messages) && t.messages.length > 1 ? { start: 'end' } : {}
    const view = async (aside = false, withCompanion = false, m = mode) => {
      const k = `${aside}:${withCompanion}:${Boolean(m.mail)}:${Boolean(m.original)}`
      return (docs[k] = docs[k] || (await threadView(t, aside, jx, withCompanion, m)))
    }
    // The mail layout as annotate's `kind` (an older reviewer has no 'mail' and gets the cards).
    const kind = mode.mail ? { kind: 'mail' } : {}
    // The originals and the view they open in: the person's last choice for the sender, else the
    // setting. None (no HTML part, too large): no originals, and the reviewer shows Reader alone.
    const sender = threadSender(t)
    const originalsOf = async (v) => {
      if (!mode.original || !v.originals || !v.originals.length) return {}
      if (sender) rememberSender(t.key, sender)
      return { originals: v.originals, view: V.viewFor(await loadViews(), sender, S.app.defaultView) }
    }
    // Kept before the annotate, not after: a click on Show images can come before annotate answers.
    const remember = (v) => {
      if (mode.actions) rememberView(t.key, v.remote)
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
            remember(v)
            const r = await reviewer.annotate({ ...base, ...startAt, ...kind, label: 'Mail', urlLabel: 'Gmail', html: v.html, ...(await originalsOf(v)), ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}), companion: v.companion })
            if (opened(r)) seen()
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
          remember(v)
          const r = await reviewer.annotate({ ...base, ...startAt, ...kind, html: v.html, ...(await originalsOf(v)), ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}) })
          if (opened(r)) seen()
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
          const r = await reviewer.annotate({ ...base, text: cut(text, 400000) })
          if (htmlError) {
            S.htmlRejected = htmlError
            ctx.log.info('reviewer.annotate takes text only: using text for this run')
            postState()
          }
          if (opened(r)) seen()
          return
        } catch (e) {
          if (!isMissingAnnotate(e)) return setNotice(`The reviewer could not open the mail: ${e.message}${htmlError && htmlError !== e.message ? ` (html: ${htmlError})` : ''}`, 'error')
          noAnnotate()
        }
      }
    }
    // Our own page instead of the reviewer's: its loader goes first (it cannot show this page).
    if (pre) await cancelView(pre)
    // Our page has no mail layout: the cards, with the pictures that may load written as pictures.
    await plainReader(id, t, await view(false, false, {}), early, shown, seen)
  }

  function noAnnotate() {
    S.annotateMissing = true
    ctx.log.info("reviewer has no annotate (or none is enabled): using the plugin's reader page")
    postState()
  }

  /**
   * Starts the reader page's overlay (before the thread is read when it can); null when start throws.
   * `refusal` resolves null once the page is up (OVERLAY_SETTLE_MS without a rejection, or the person
   * closed it), else main's refusal; `ended` turns true once the overlay ended.
   */
  function startReader(id, title) {
    const type = overlayType(id)
    try {
      const handle = ctx.overlay.start({ kind: 'html', file: 'panels/thread.html', title: cut(oneLine(title || ''), 100) || 'Mail', size: 'large', ready: 'manual', ...(type ? { type } : {}) })
      if (type && typeof handle.onDiscuss === 'function') handle.onDiscuss(() => overlayDiscuss(type.data.id))
      const started = { handle, used: false, ended: false, refusal: overlayRefusal(handle) }
      const end = () => (started.ended = true)
      handle.result.then(end, end)
      return started
    } catch (e) {
      setNotice(`Cannot open the reader: ${e.message}`, 'error')
      return null
    }
  }

  /**
   * Without the reviewer's annotate: our own read-only page with Discuss, New session and ↗. It
   * gets the same HTML in parts, then one message per image, so no message passes the page limit.
   * A link click in the page comes back as `{ open }`.
   */
  async function plainReader(id, t, v, early, shown = () => {}, seen = shown) {
    const started = early || startReader(id, t.title)
    if (!started) return
    started.used = true
    // start() returns a handle even for an overlay main refuses; the refusal only rejects `result`.
    const refused = await started.refusal
    if (refused) return setNotice(`Cannot open the reader: ${refused.message}`, 'error')
    // On screen now; the wait below lasts until the person closes the page (feed act answers here).
    shown()
    const handle = started.handle
    const parts = []
    for (let i = 0; i < v.html.length; i += PAGE_HTML_PART) parts.push(v.html.slice(i, i + PAGE_HTML_PART))
    let posted = false
    try {
      handle.post({ type: 'doc', title: t.title, parts: parts.length, assets: v.assets.length })
      parts.forEach((part, i) => handle.post({ type: 'html', i, part }))
      for (const a of v.assets) handle.post({ type: 'asset', id: a.id, dataUrl: a.dataUrl })
      posted = true
    } catch (e) {
      ctx.log.warn(`posting to the reader: ${e.message}`)
    }
    // Read only when the mail reached a page still open: a post after the person closed the loader
    // is a silent no-op, so they never saw the mail.
    if (posted && !started.ended) seen()
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
        emitWithLabels()
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
          emitWithLabels() // the rolled-back rows are unread again
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
      problems: [...st.problems, ...S.app.problems],
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

  const told = { sent: new Map(), stateKey: '', started: false } // what Inbox was last told: id -> item, and the Sync state (kind + message)

  /** The rows, the threads of their alert groups and the context the feed answers from. */
  function feedRows() {
    // Signed in: the view as the panel shows it (marks included). Signed out with a cache left (an
    // expired grant keeps it): the same view built from that cache, so Inbox can say "signed out,
    // showing the last items" as the contract asks.
    if (signedIn()) return { rows: allRows(S.view), threads: S.cache ? overlayThreads() : {} }
    if (!S.cache || !S.cache.lists) return { rows: [], threads: {} }
    const cache = markedCache()
    return { rows: allRows(buildView({ cfg: cfg(), cache, verdicts: {} })), threads: cache.threads }
  }

  function overlayThreads() {
    return markedCache().threads
  }

  /** All items of the scope (`limit`: the contract's 1000 by default; `only`: just that id). */
  function feedList(limit, only) {
    const { rows, threads } = feedRows()
    return F.feedItems(rows, { me: (S.cache && S.cache.account) || '', jiraKeys: S.jiraKeys, labelNames: S.labels || {}, threads, limit, groups: cfg().alertGroupsInInbox, ...(only !== undefined ? { only } : {}) })
  }

  /**
   * The row id (what openThread and markRow take) of a feed item id: a group's feed id is its row id
   * `alert:<name>` unless the name was too long for the contract (F.groupItemId cut and hashed it),
   * so the alert rows are searched for it; any other id is a thread id, the same in both.
   */
  function rowIdOfItem(id) {
    if (!id.startsWith(ALERT)) return id
    const row = feedRows().rows.find((r) => r.kind === 'alert' && F.groupItemId(r.group.name) === id)
    return row ? row.id : id
  }

  /**
   * One feed item by id, or null: the same item feedList(Infinity) holds, without building and
   * sorting every other one (main asks the overlay buttons after every click and setButtons).
   */
  function feedItemOf(id) {
    return feedList(Infinity, id)[0] || null
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
    told.sent = new Map(items.map((i) => [i.id, i]))
    told.stateKey = `${st.state}|${st.message || ''}`
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
    if (S.stopped || !told.started || !ctx.services || typeof ctx.services.emit !== 'function') return
    try {
      const st = feedState()
      // The message counts too: error A -> error B or a new signed-out reason would otherwise stay stale in Inbox.
      if (`${st.state}|${st.message || ''}` !== told.stateKey) return feedEmit('sync', feedSync())
      const next = feedList()
      const d = F.diffFeed(told.sent, next)
      told.sent = new Map(next.map((i) => [i.id, i]))
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

  /** What a poll, a mark or a sign-in ends with: the label names, then the changes (emitFeed). */
  function emitWithLabels() {
    if (S.stopped) return
    void feedLabelNames().then(emitFeed, emitFeed)
  }

  void ready.then(() => {
    if (S.stopped || !ctx.services || typeof ctx.services.emit !== 'function') return
    told.started = true
    feedEmit('sync', feedSync())
  })

  /**
   * `act(id, 'open')` of the feed: resolves once the open has started (the reviewer's overlay
   * prepared, or our own reader page up), not when it is over; with neither (a reviewer without
   * prepare, or a prepare that failed) once the mail is shown, so a failed read is still the act's
   * refusal. The rest (reading the mail, the
   * annotate, and without the reviewer the wait for our reader page to close) runs on: Inbox gives
   * every act 10 s, and an open that waited for all that was reported as failed while it was on
   * screen (design-next §3.4: "a source answering act(id, 'open') by opening first"). A failure
   * after the start goes to this panel's notice; one before it is the act's refusal.
   * An open that ends without anything shown (the reviewer refused the mail, the app refused our
   * reader page: paths that set the panel's notice and return) is a refusal too, with that notice's
   * text: resolving there answered ok for nothing on screen, and Inbox ended the item's "back" mark
   * (phase-1 review round 3). One guard here, not one per early return.
   */
  function openStarted(open) {
    return new Promise((resolve, reject) => {
      let started = false
      const before = S.notice
      open(() => {
        started = true
        resolve()
      }).then(() => {
        if (started) return
        const n = S.notice !== before && S.notice && S.notice.kind === 'error' ? S.notice.text : ''
        reject(new Error(n || 'the mail could not be shown'))
      }, (e) => {
        if (!started) return reject(e)
        const msg = e && e.message ? e.message : String(e)
        ctx.log.warn(`open: ${msg}`)
        setNotice(`Could not open the mail: ${msg}`, 'error')
      })
    })
  }

  async function feedAct(id, action) {
    await ready
    const refuse = (message) => ({ ok: false, message: cut(oneLine(message), 300) })
    if (typeof id !== 'string' || typeof action !== 'string') return refuse('gmail: act takes an item id and an action id')
    const item = feedItemOf(id)
    if (!item) return refuse('gmail: that thread is not in the inbox (refresh?)')
    if (!item.actions.some((a) => a.id === action)) return refuse(`gmail: this thread has no action "${cut(action, 40)}"`)
    try {
      const rid = rowIdOfItem(id)
      if (action === 'open') await openStarted((started) => openThread(rid, started))
      else {
        const r = await markRow(rid, action === 'markUnread')
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
      problems: [...S.settings.problems, ...S.app.problems],
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
