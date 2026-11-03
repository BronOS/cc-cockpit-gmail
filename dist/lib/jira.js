'use strict'
// Mail from Jira (design "Jira mail", 0.2.0): with the bronos.jira plugin enabled in the project,
// its `jira` service (v1) says which addresses Jira's notification mails come from, what an issue's
// status is now, and gives the issue as a reviewer document. Without it nothing here runs and the
// plugin works as 0.1.0 did. The pure parts: which mail is Jira's and about which issue, the triage
// hints, the lookup cache, and the "Jira issue" section of the thread view.
//
// - From Jira: a message whose sender is one of the service's senders (`jira@<site host>` unless
//   the Jira plugin's setting says otherwise). Its issue: the first issue key in the subject, else
//   the first `<site>/browse/KEY` link in the text (the snippet while polling, the bodies in the
//   thread view).
// - Hints (the old cockpit's mail rules; decisions ported, text not), only for an unread thread and
//   judged on its new messages (the unread ones of others):
//   1. every new message is Jira's and only moves the issue -> hint noise (the issue's own lane in
//      the Jira plugin ranks it by its real status);
//   2. a new Jira message about an issue that is Done now -> hint fyi (even a mention there is
//      something to read, not to do);
//   3. every new message is Jira's and only mentions the person on, or creates, an open issue
//      assigned to them -> floor action (always theirs; Jev may still say urgent). A mention on
//      someone else's issue stays with Jev.
//   The mail never carries the status, so 2 and 3 need a lookup: cached with a TTL, asked again
//   when a newer mail about the key arrived, and bounded in time (a poll never waits long for Jira;
//   a lookup that lands late re-judges the row).

const { cut, oneLine } = require('./util')

// Jira's notification texts (English; Jira Cloud's current wording and the older "issue" one).
const MOVED = /\bmoved (?:a|an|this|the) (?:work item|issue)\b/i
const MENTIONED = /\bmentioned you (?:on|in)\b/i
const CREATED = /\bcreated (?:a|an|this|the) (?:work item|issue)\b/i
const KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9})(?![A-Za-z0-9_-])/

const TTL_MS = 10 * 60000 // a lookup answer is used this long (unless a newer mail came)
const ERROR_MS = 60000 // a failed lookup (Jira down, busy) is tried again after a minute
const MAX_CACHED = 300
const MAX_STARTED = 10 // lookups started per triage round (bronos.jira allows 30 a minute)
const SITE_TTL_MS = 5 * 60000
const ASIDE_MAX = 90000 // below the reviewer's 100,000 characters of aside (and of a companion's facts)

/** The first issue key in a subject (`[JIRA] (ABC-12) Fix login`, `ABC-12 Fix login`), or null. */
function keyFromSubject(subject) {
  const m = KEY.exec(String(subject || ''))
  return m ? m[1] : null
}

/** The first issue a text links to on the site (`<site>/browse/ABC-12`), or null. */
function keyFromLinks(text, site) {
  if (!site || !text) return null
  const s = String(text)
  const base = `${site}/browse/`
  let at = s.indexOf(base)
  while (at >= 0) {
    const m = /^([A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9})(?![A-Za-z0-9_])/.exec(s.slice(at + base.length, at + base.length + 64))
    if (m) return m[1]
    at = s.indexOf(base, at + base.length)
  }
  return null
}

/** Whether a (compact) message is from one of Jira's senders. */
function isFromJira(m, senders) {
  return Boolean(m && m.address) && senders.includes(String(m.address).toLowerCase())
}

/** The service's site() answer as this plugin uses it: `{ site, senders }`, or null (no Jira). */
function jiraContext(s) {
  if (!s || typeof s !== 'object' || !s.ready || typeof s.site !== 'string' || !/^https:\/\/[^/\s]+$/.test(s.site)) return null
  const senders = (Array.isArray(s.senders) ? s.senders : []).filter((x) => typeof x === 'string' && x.length <= 254 && x.includes('@')).map((x) => x.toLowerCase()).slice(0, 10)
  if (!senders.length) return null
  return { site: s.site, senders }
}

/**
 * What a thread row says about Jira: `{ key, newestAt, jiraNew, news }` for an unread thread whose
 * new messages include one of Jira's, else null.
 * @param {object} row poll.buildView's thread row
 * @param {{ site: string, senders: string[] }} j jiraContext
 * @param {string} me the person's address
 */
function jiraFacts(row, j, me) {
  if (!j || !row || row.kind !== 'thread' || !row.unread) return null
  const msgs = row.thread.messages || []
  const unread = msgs.filter((m) => m.unread && (!me || m.address !== me))
  const news = unread.length ? unread : [row.facts.lead]
  const jiraNew = news.filter((m) => isFromJira(m, j.senders))
  if (!jiraNew.length) return null
  let key = keyFromSubject(row.facts.subject)
  if (!key) for (const m of jiraNew) if ((key = keyFromSubject(m.subject) || keyFromLinks(m.snippet, j.site))) break
  const newestAt = Math.max(...jiraNew.map((m) => m.at || 0))
  return { key, newestAt, jiraNew, news }
}

/**
 * The hint or floor for a Jira mail row (rules 1-3 above), or null.
 * @param {ReturnType<typeof jiraFacts>} f
 * @param {object|null|undefined} issue the lookup's answer (jira.issue), null when it failed, undefined when not known yet
 */
function jiraHint(f, issue) {
  if (!f) return null
  const all = f.jiraNew.length === f.news.length
  if (all && f.news.every((m) => MOVED.test(m.snippet || ''))) return { hint: { priority: 'noise' }, why: 'moved' }
  if (!f.key || !issue) return null
  if (issue.done === true) return { hint: { priority: 'fyi' }, why: 'done' }
  if (all && issue.mine === true && f.news.every((m) => MENTIONED.test(m.snippet || '') || CREATED.test(m.snippet || ''))) return { floor: 'action', why: 'mine' }
  return null
}

/**
 * The lookups of issue status for the hints: per key `{ at, value }` (the answer and when it came)
 * and `failedAt` after a failure. Asked again past the TTL, after a newer mail about the key, or a
 * minute after a failure; started at most MAX_STARTED a round and waited for at most `budgetMs`. A
 * lookup that finishes after the wait calls `onLate` (once a batch). An answer past its TTL is still
 * used while the new one is on its way (a slow Jira must not make a row lose its hint and cost a
 * Jev call back and forth), but never one older than the newest mail about the key.
 *
 * @param {object} o
 * @param {(key: string, opts: object) => Promise<object>} o.issue the service's issue()
 * @param {() => number} [o.now]
 * @param {() => void} [o.onLate]
 */
function createLookups(o) {
  const now = o.now || Date.now
  const m = new Map()
  const pending = new Map()
  let lateQueued = false

  /** Whether a key needs no new lookup now. */
  function fresh(e, newestAt) {
    if (!e) return false
    if (e.failedAt && now() - e.failedAt < ERROR_MS) return true
    return Boolean(e.value) && now() - e.at < TTL_MS && e.at >= (newestAt || 0)
  }

  /** The answer for a key: the value, null (the lookup failed), undefined (none yet). */
  function peek(key, newestAt) {
    const e = m.get(key)
    if (!e) return undefined
    if (e.value && e.at >= (newestAt || 0)) return e.value
    return e.failedAt ? null : undefined
  }

  // A failure keeps an earlier answer only while it is still the newest news (peek's rule).
  function failed(key) {
    const e = m.get(key)
    m.delete(key)
    m.set(key, { ...(e && e.value ? { at: e.at, value: e.value } : { at: 0 }), failedAt: now() })
  }

  function start(key, newestAt) {
    if (pending.has(key)) return pending.get(key)
    // As fresh as the mail: Jira's own poll answers when it is newer than the mail, else it reads.
    const maxAgeMs = Math.max(15000, Math.min(TTL_MS, now() - (newestAt || 0)))
    const p = Promise.resolve()
      .then(() => o.issue(key, { maxAgeMs }))
      .then(
        (v) => {
          if (v && typeof v === 'object' && typeof v.key === 'string') m.set(key, { at: now(), value: { key: v.key, done: v.done === true, mine: v.mine === true, status: cut(oneLine(v.status), 100) } })
          else failed(key)
        },
        () => failed(key),
      )
      .finally(() => {
        pending.delete(key)
        while (m.size > MAX_CACHED) m.delete(m.keys().next().value)
      })
    pending.set(key, p)
    return p
  }

  /**
   * Start the lookups `wants` needs ([{ key, newestAt }]) and wait for them at most `budgetMs`.
   * Resolves `{ started, late }` (how many were still running after the wait).
   */
  async function ensure(wants, budgetMs) {
    const todo = []
    const seen = new Set()
    for (const w of wants) {
      if (!w.key || seen.has(w.key)) continue
      seen.add(w.key)
      if (!fresh(m.get(w.key), w.newestAt)) todo.push(w)
    }
    const run = todo.slice(0, MAX_STARTED).map((w) => start(w.key, w.newestAt))
    if (!run.length) return { started: 0, late: 0 }
    let timer
    const all = Promise.all(run)
    const done = await Promise.race([all.then(() => true), new Promise((r) => (timer = setTimeout(() => r(false), budgetMs)))])
    clearTimeout(timer)
    if (done) return { started: run.length, late: 0 }
    const late = pending.size
    if (!lateQueued && o.onLate) {
      lateQueued = true
      all.then(() => {
        lateQueued = false
        o.onLate()
      })
    }
    return { started: run.length, late }
  }

  return { peek, ensure, clear: () => m.clear(), get size() {
    return m.size
  } }
}

/** The service's site(), asked at most every 5 minutes (and at once again after a failure). */
function createSiteCache(o) {
  const now = o.now || Date.now
  let got = null
  return {
    async get(timeoutMs) {
      if (got && now() - got.at < SITE_TTL_MS) return got.value
      let timer
      try {
        const s = await Promise.race([o.site(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('the Jira plugin did not answer in time')), timeoutMs)))])
        got = { at: now(), value: jiraContext(s) }
        return got.value
      } catch {
        got = null
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    clear() {
      got = null
    },
  }
}

// ---- the thread view ----

const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const ASSET_ID = /^[A-Za-z0-9]{1,64}$/

/**
 * The issue of a thread opened in full: `{ key }` when a message is from Jira, else null. Subject
 * first, then the site links in the Jira messages' bodies.
 * @param {{ title: string, facts: object[], texts: string[] }} t compact messages and the body texts of Jira's messages
 */
function threadIssue(t, j) {
  if (!j) return null
  const jiraMsgs = t.facts.filter((m) => isFromJira(m, j.senders))
  if (!jiraMsgs.length) return null
  let key = keyFromSubject(t.title)
  if (!key) for (const m of jiraMsgs) if ((key = keyFromSubject(m.subject))) break
  if (!key) for (const text of t.texts) if ((key = keyFromLinks(text, j.site))) break
  return key ? { key } : null
}

/** Headings two levels down (h1 -> h3, at most h6): the issue sits under the mail's h1 and the section's h2. */
function shiftHeadings(html) {
  return html.replace(/<(\/?)h([1-6])(?=[\s>])/g, (_, slash, n) => `<${slash}h${Math.min(6, Number(n) + 2)}`)
}

/**
 * The service's document() answer, checked (it comes from another plugin): html a string within
 * `maxHtmlBytes`, assets pictures as data: URLs with plain ids not used by the mail's own, the title
 * one line of at most 200 chars (else `Jira issue KEY`), the details column (`aside`) only when it is
 * a string within ASIDE_MAX (else null). Returns `{ html, assets, title, aside }` or `{ error }`.
 */
function checkDocument(d, maxHtmlBytes, takenIds) {
  if (!d || typeof d !== 'object' || typeof d.html !== 'string') return { error: 'the Jira plugin sent no document' }
  if (Buffer.byteLength(d.html, 'utf8') > maxHtmlBytes) return { error: 'the issue is too long to show with the mail' }
  if (d.html.includes('\0')) return { error: 'the Jira plugin sent a document with a NUL byte' }
  const assets = []
  for (const a of Array.isArray(d.assets) ? d.assets : []) {
    if (!a || typeof a.id !== 'string' || !ASSET_ID.test(a.id) || takenIds.has(a.id)) continue
    if (typeof a.dataUrl !== 'string' || a.dataUrl.length > 1000000 || !IMAGE_URL.test(a.dataUrl)) continue
    const mime = a.dataUrl.slice(5, a.dataUrl.indexOf(';'))
    assets.push({ id: a.id, name: typeof a.name === 'string' ? cut(a.name, 200) : a.id, mime, dataUrl: a.dataUrl })
  }
  const title = typeof d.title === 'string' ? cut(oneLine(d.title), 200) : ''
  const key = typeof d.key === 'string' && /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/.test(d.key) ? d.key : null
  const aside = typeof d.aside === 'string' && d.aside && d.aside.length <= ASIDE_MAX && !d.aside.includes('\0') ? d.aside : null
  return { html: d.html, assets, title: title || (key ? `Jira issue ${key}` : 'Jira issue'), aside }
}

/**
 * The issue as the reviewer's `companion` (cc-cockpit 0.9.3+): beside the mail instead of below it.
 * `checked` is checkDocument's answer, `assets` the pictures that still fit beside the mail's (the
 * reviewer's budget is one for both), `url` the issue's browse URL; its facts are the document's own
 * details column, else the ones jiraSection makes from issue() (`fallbackFacts`), else none. Its
 * header bar reads `Jira · KEY` with an "Open in Jira ↗" button.
 */
function jiraCompanion({ key, checked, assets, url, fallbackFacts }) {
  // The column's header bar: "Jira · KEY" and an "Open in Jira ↗" button.
  const c = { title: checked.title, html: checked.html, label: `Jira · ${key}`, urlLabel: 'Jira' }
  const facts = checked.aside || fallbackFacts || ''
  if (facts) c.facts = facts
  if (typeof url === 'string' && /^https:\/\//.test(url)) c.url = url
  if (assets.length) c.assets = assets
  return c
}

/**
 * The "Jira issue KEY" section below the mail and its rows for the details column.
 * @param {object} o
 * @param {string} o.key
 * @param {string|null} o.url the issue's browse URL (the service's), http(s)
 * @param {object|null} o.issue the service's issue() answer, or null
 * @param {{ html: string }|null} o.doc checkDocument's answer, or null
 * @param {string} [o.note] why the issue is not shown (a failure), short
 * @param {(s: string) => string} o.esc
 */
function jiraSection(o) {
  const { esc } = o
  const url = typeof o.url === 'string' && /^https:\/\//.test(o.url) ? o.url : null
  const link = url ? `<a href="${esc(url)}">${esc(o.key)}</a>` : esc(o.key)
  const parts = [`<h2>Jira issue ${link}</h2>`]
  if (o.doc) parts.push(shiftHeadings(o.doc.html))
  else parts.push(`<p class="muted"><em>The issue is not shown here${o.note ? `: ${esc(cut(oneLine(o.note), 300))}` : ''}.</em></p>`)
  const i = o.issue
  const row = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '')
  const aside = i
    ? [
        '<dl class="facts">',
        row('Jira issue', link),
        row('Status', i.status ? `<span class="lozenge lozenge-${i.done ? 'success' : i.category === 'indeterminate' ? 'info' : 'neutral'}">${esc(cut(i.status, 100))}</span>` : ''),
        row('Priority', i.priority ? esc(cut(i.priority, 100)) : ''),
        row('Assignee', i.assignee ? `<span class="person">${esc(cut(i.assignee, 200))}</span>${i.mine ? ' <span class="muted">(you)</span>' : ''}` : '<em>Unassigned</em>'),
        '</dl>',
      ].join('')
    : ''
  return { html: parts.join('\n'), aside }
}

/** One line for the text views (`ccc gmail show` keeps the mail alone; the reviewer's text mode gets this). */
function jiraLine(key, issue, url) {
  if (!issue) return `Jira issue ${key}${url ? `: ${url}` : ''}`
  return `Jira issue ${key}: ${oneLine(issue.summary || '')} (${[issue.status, issue.priority, issue.assignee ? `assigned to ${issue.assignee}${issue.mine ? ' (you)' : ''}` : 'unassigned'].filter(Boolean).join(', ')})${url ? ` ${url}` : ''}`
}

module.exports = {
  keyFromSubject,
  keyFromLinks,
  isFromJira,
  jiraContext,
  jiraFacts,
  jiraHint,
  createLookups,
  createSiteCache,
  threadIssue,
  shiftHeadings,
  checkDocument,
  jiraCompanion,
  jiraSection,
  jiraLine,
  MOVED,
  MENTIONED,
  CREATED,
  TTL_MS,
  ERROR_MS,
  MAX_STARTED,
}
