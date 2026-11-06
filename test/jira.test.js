'use strict'
// Mail from Jira (0.2.0): which mail is Jira's and about which issue, the triage hints (moved =
// noise, Done = fyi, a mention on my open issue = floor action), the lookup cache, and the issue
// below the mail in the thread view, all through a fake bronos.jira `jira` service. Without the
// service the plugin behaves as 0.1.0.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const J = require('../dist/lib/jira')
const { esc } = require('../dist/lib/entities')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, fakeJiraService, tokens, fixture, picture, NOW, T, JIRA_SITE } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))
const JIRA = 'Acme Jira <jira@acme.atlassian.net>'
const ID = { moved: '18f0a1b2c3d4e5b1', mention: '18f0a1b2c3d4e5b2', done: '18f0a1b2c3d4e5b3', other: '18f0a1b2c3d4e5b4', link: '18f0a1b2c3d4e5b5', mixed: '18f0a1b2c3d4e5b6' }

let n = 0
/** A format=full message (html body), unread unless said otherwise. */
function msg(threadId, o) {
  const html = o.html || `<p>${esc(o.snippet)}</p>`
  return {
    id: `${threadId.slice(0, 14)}${String(++n).padStart(2, '0')}`,
    threadId,
    labelIds: o.read ? ['INBOX'] : ['UNREAD', 'INBOX'],
    snippet: o.snippet,
    historyId: '900',
    internalDate: String(o.at || NOW - 3600000),
    payload: {
      partId: '',
      mimeType: 'text/html',
      filename: '',
      headers: [
        { name: 'From', value: o.from || JIRA },
        { name: 'To', value: 'Me <me@example.com>' },
        { name: 'Subject', value: o.subject },
      ],
      body: { size: html.length, data: Buffer.from(html).toString('base64url') },
    },
  }
}
const thread = (id, ...msgs) => ({ id, historyId: '1100', messages: msgs })

function jiraThreads() {
  return {
    [ID.moved]: thread(ID.moved, msg(ID.moved, { subject: '[Acme] (ABC-1) Checkout fails', snippet: 'Oleg Example moved a work item from To Do to In Progress' })),
    [ID.mention]: thread(ID.mention, msg(ID.mention, { subject: '[Acme] (ABC-2) Rotate keys', snippet: 'Ann Smith mentioned you on a work item ABC-2 Rotate keys: please check' })),
    [ID.done]: thread(ID.done, msg(ID.done, { subject: '[Acme] (ABC-3) Old bug', snippet: 'Ann Smith mentioned you on a work item ABC-3: looks good now' })),
    [ID.other]: thread(ID.other, msg(ID.other, { subject: '[Acme] (XYZ-9) Not mine', snippet: 'Bob Jones mentioned you on a work item XYZ-9' })),
    [ID.link]: thread(ID.link, msg(ID.link, { subject: 'A comment for you', snippet: 'Ann Smith commented', html: `<p>Ann Smith commented on <a href="${JIRA_SITE}/browse/OPS-7">the issue</a></p>` })),
    [ID.mixed]: thread(
      ID.mixed,
      msg(ID.mixed, { subject: '[Acme] (ABC-1) Checkout fails', snippet: 'Oleg Example moved a work item from To Do to In Progress', at: NOW - 7200000 }),
      msg(ID.mixed, { subject: 'Re: [Acme] (ABC-1) Checkout fails', snippet: 'Can you look at this today?', from: 'Ann Smith <ann@example.com>' }),
    ),
  }
}

const ISSUES = {
  'ABC-1': {},
  'ABC-2': { mine: true, done: false },
  'ABC-3': { status: 'Done', category: 'done', done: true },
  'XYZ-9': { mine: false, assignee: 'Bob Jones' },
  'OPS-7': {},
}

function boot(opts = {}) {
  const reg = tokens()
  const base = Object.fromEntries(Object.entries({ t1: T.t1, t2: T.t2, t3: T.t3, a1: T.a1, a2: T.a2, a3: T.a3, c1: T.c1 }).map(([k, id]) => [id, fixture(`thread-${k}.json`)]))
  const threads = { ...base, ...jiraThreads(), ...(opts.extraThreads || {}) }
  const unread = [T.t1, T.t2, ID.moved, ID.mention, ID.done, ID.other, ID.link, ID.mixed, ...Object.keys(opts.extraThreads || {})]
  const gmail = fakeGmail({ tokens: reg, threads, lists: { unread, alerts: [], read: [T.t3] } })
  const oauth = fakeOAuth(reg)
  const jira = opts.jira === null ? null : opts.jira || fakeJiraService({ issues: ISSUES })
  const triage = fakeTriage()
  const ctx = fakeCtx({ project: {}, oauth, triage, reviewer: opts.reviewer, jira })
  let clock = NOW
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => clock, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000, imageWaitMs: 50, jiraLookupWaitMs: opts.lookupWaitMs, jiraViewWaitMs: opts.viewWaitMs })
  return { gmail, ctx, h, jira, triage, tick: (ms) => (clock += ms) }
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function signedIn(opts) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.cache && b.h.S.cache.lastPoll)
  await b.h.S.polling
  await b.h.S.classifying
  return b
}

/** The newest triage item the host sent for each id. */
function lastItems(triage) {
  const out = {}
  for (const c of triage.calls) for (const it of c.items) out[it.id] = it
  return out
}

// ---- lib/jira.js ----

test('keys: the first issue key of the subject, else a link to <site>/browse/KEY', () => {
  assert.equal(J.keyFromSubject('[Acme] (ABC-12) Fix login'), 'ABC-12')
  assert.equal(J.keyFromSubject('Re: OPS_2-7 and ABC-1'), 'OPS_2-7')
  for (const s of ['Re: lunch', 'xABC-1 y', 'ABC-0', 'abc-12', '']) assert.equal(J.keyFromSubject(s), null, s)
  assert.equal(J.keyFromLinks(`see ${JIRA_SITE}/browse/OPS-7?focusedCommentId=1`, JIRA_SITE), 'OPS-7')
  assert.equal(J.keyFromLinks('see https://other.atlassian.net/browse/OPS-7', JIRA_SITE), null)
  assert.equal(J.keyFromLinks(`${JIRA_SITE}/browse/nope ${JIRA_SITE}/browse/ABC-9`, JIRA_SITE), 'ABC-9')
})

test('jiraContext: the service\'s site() only when ready, https and with senders', () => {
  assert.deepEqual(J.jiraContext({ ready: true, site: JIRA_SITE, senders: ['Jira@Acme.atlassian.net'] }), { site: JIRA_SITE, senders: ['jira@acme.atlassian.net'] })
  for (const bad of [null, { ready: false, site: JIRA_SITE, senders: ['a@b.c'] }, { ready: true, site: 'http://x', senders: ['a@b.c'] }, { ready: true, site: JIRA_SITE, senders: [] }, { ready: true, site: `${JIRA_SITE}/path`, senders: ['a@b.c'] }]) assert.equal(J.jiraContext(bad), null)
})

const j = { site: JIRA_SITE, senders: ['jira@acme.atlassian.net'] }
const cm = (o) => ({ address: 'jira@acme.atlassian.net', from: 'Acme Jira', subject: '[Acme] (ABC-2) Rotate keys', snippet: '', unread: true, at: NOW - 1000, ...o })
const rowOf = (...messages) => ({ kind: 'thread', unread: messages.some((m) => m.unread), thread: { messages }, facts: { subject: messages[0].subject, lead: messages[messages.length - 1] } })

test('the hints, rule by rule (the old connector\'s decisions)', () => {
  const open = { done: false, mine: true }
  // 1. only moves: noise, no lookup needed.
  const moved = J.jiraFacts(rowOf(cm({ snippet: 'Ann moved a work item from To Do to Done' })), j, 'me@example.com')
  assert.deepEqual(J.jiraHint(moved, undefined), { hint: { priority: 'noise' }, why: 'moved' })
  // 2. about a Done issue: fyi, even a mention.
  const mention = J.jiraFacts(rowOf(cm({ snippet: 'Ann mentioned you on a work item' })), j, 'me@example.com')
  assert.equal(mention.key, 'ABC-2')
  assert.deepEqual(J.jiraHint(mention, { done: true, mine: true }), { hint: { priority: 'fyi' }, why: 'done' })
  // 3. a mention on, or the creation of, my open issue: floor action.
  assert.deepEqual(J.jiraHint(mention, open), { floor: 'action', why: 'mine' })
  const created = J.jiraFacts(rowOf(cm({ snippet: 'Ann created a work item ABC-2' })), j, 'me@example.com')
  assert.deepEqual(J.jiraHint(created, open), { floor: 'action', why: 'mine' })
  // Someone else's issue, a plain comment, or a lookup not there (yet): Jev decides.
  assert.equal(J.jiraHint(mention, { done: false, mine: false }), null)
  assert.equal(J.jiraHint(J.jiraFacts(rowOf(cm({ snippet: 'Ann commented on a work item' })), j, ''), open), null)
  assert.equal(J.jiraHint(mention, undefined), null)
  assert.equal(J.jiraHint(mention, null), null)
  // A human reply among the new messages: no "only moves"/"only mentions" rule; Done still counts.
  const mixed = J.jiraFacts(rowOf(cm({ snippet: 'Ann moved a work item' }), cm({ address: 'ann@example.com', snippet: 'please look' })), j, '')
  assert.equal(J.jiraHint(mixed, undefined), null)
  assert.equal(J.jiraHint(mixed, open), null)
  assert.deepEqual(J.jiraHint(mixed, { done: true }), { hint: { priority: 'fyi' }, why: 'done' })
  // A read thread, or no Jira message among the new ones: nothing.
  assert.equal(J.jiraFacts(rowOf(cm({ unread: false, snippet: 'Ann moved a work item' })), j, ''), null)
  assert.equal(J.jiraFacts(rowOf(cm({ unread: false, snippet: 'x' }), cm({ address: 'ann@example.com' })), j, ''), null)
  assert.equal(J.jiraFacts(rowOf(cm({})), null, ''), null)
})

test('lookups: cached with a TTL, asked again for a newer mail, bounded in time, late ones re-judge', async () => {
  let t = NOW
  const calls = []
  let late = 0
  let delay = 0
  const L = J.createLookups({
    now: () => t,
    onLate: () => late++,
    issue: async (key, o) => {
      calls.push([key, o.maxAgeMs])
      if (delay) await new Promise((r) => setTimeout(r, delay))
      if (key === 'BAD-1') throw new Error('jira: busy')
      return { key, done: key === 'ABC-3', mine: true, status: 'x' }
    },
  })
  await L.ensure([{ key: 'ABC-1', newestAt: NOW - 1000 }, { key: 'ABC-1', newestAt: NOW - 1000 }, { key: 'ABC-3', newestAt: NOW - 600000 }], 1000)
  assert.deepEqual(calls, [['ABC-1', 15000], ['ABC-3', 600000]], 'one call per key; as fresh as the mail')
  assert.deepEqual(L.peek('ABC-3', 0), { key: 'ABC-3', done: true, mine: true, status: 'x' })
  await L.ensure([{ key: 'ABC-1', newestAt: NOW - 1000 }], 1000)
  assert.equal(calls.length, 2, 'cached')
  // A newer mail about ABC-1: asked again.
  t += 5000
  assert.equal(L.peek('ABC-1', NOW + 4000), undefined)
  await L.ensure([{ key: 'ABC-1', newestAt: NOW + 4000 }], 1000)
  assert.equal(calls.length, 3)
  // Past the TTL: still used until the new answer is there, and asked again.
  t += J.TTL_MS
  assert.equal(L.peek('ABC-3', 0).done, true)
  await L.ensure([{ key: 'ABC-3', newestAt: 0 }], 1000)
  assert.equal(calls.length, 4)
  // A failure is null for a minute, then tried again.
  await L.ensure([{ key: 'BAD-1', newestAt: 0 }], 1000)
  assert.equal(L.peek('BAD-1', 0), null)
  await L.ensure([{ key: 'BAD-1', newestAt: 0 }], 1000)
  assert.equal(calls.filter((c) => c[0] === 'BAD-1').length, 1)
  t += J.ERROR_MS
  await L.ensure([{ key: 'BAD-1', newestAt: 0 }], 1000)
  assert.equal(calls.filter((c) => c[0] === 'BAD-1').length, 2)
  // Slow: the wait ends at the budget; onLate once when they land.
  delay = 60
  const r = await L.ensure([{ key: 'SLOW-1', newestAt: 0 }, { key: 'SLOW-2', newestAt: 0 }], 10)
  assert.deepEqual(r, { started: 2, late: 2 })
  assert.equal(L.peek('SLOW-1', 0), undefined)
  await until(() => late === 1)
  assert.equal(L.peek('SLOW-1', 0).key, 'SLOW-1')
  // At most MAX_STARTED a round.
  delay = 0
  const before = calls.length
  await L.ensure(Array.from({ length: 25 }, (_, i) => ({ key: `MANY-${i + 1}`, newestAt: 0 })), 1000)
  assert.equal(calls.length - before, J.MAX_STARTED)
})

test('the section below the mail: headings two levels down, a link to the issue, the facts for the aside', () => {
  assert.equal(J.shiftHeadings('<h1>a</h1><h2 class="x">b</h2><h5>c</h5><h6>d</h6><hr>'), '<h3>a</h3><h4 class="x">b</h4><h6>c</h6><h6>d</h6><hr>')
  const doc = J.checkDocument({ html: '<div class="card"><h1>ABC-1: x</h1></div>', assets: [] }, 1000, new Set())
  const s = J.jiraSection({ key: 'ABC-1', url: `${JIRA_SITE}/browse/ABC-1`, issue: { status: 'Done', done: true, priority: 'High', assignee: 'Oleg <Example>', mine: true }, doc, esc })
  assert.equal(s.html, `<h2>Jira issue <a href="${JIRA_SITE}/browse/ABC-1">ABC-1</a></h2>\n<div class="card"><h3>ABC-1: x</h3></div>`)
  assert.match(s.aside, /<dt>Status<\/dt><dd><span class="lozenge lozenge-success">Done<\/span><\/dd>/)
  assert.match(s.aside, /<span class="person">Oleg &lt;Example&gt;<\/span> <span class="muted">\(you\)<\/span>/)
  const failed = J.jiraSection({ key: 'ABC-1', url: 'javascript:alert(1)', issue: null, doc: null, note: 'jira: busy <now>', esc })
  assert.equal(failed.html, '<h2>Jira issue ABC-1</h2>\n<p class="muted"><em>The issue is not shown here: jira: busy &lt;now&gt;.</em></p>')
  assert.equal(failed.aside, '')
})

test('checkDocument: what another plugin sent is checked (html budget, picture data URLs, asset ids)', () => {
  assert.match(J.checkDocument(null, 10, new Set()).error, /no document/)
  assert.match(J.checkDocument({ html: 'x'.repeat(11) }, 10, new Set()).error, /too long/)
  const png = `data:image/png;base64,${picture('png', 30).toString('base64')}`
  const r = J.checkDocument(
    {
      html: '<p>x</p>',
      assets: [
        { id: 'att1', name: 'a.png', mime: 'image/png', dataUrl: png },
        { id: 'img00', dataUrl: png },
        { id: 'att2', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
        { id: '../x', dataUrl: png },
        { id: 'att3', dataUrl: 'https://example.com/x.png' },
        { id: 'att4', dataUrl: png, name: 7 },
      ],
    },
    1000,
    new Set(['img00']),
  )
  assert.deepEqual(r.assets.map((a) => [a.id, a.mime, a.name]), [['att1', 'image/png', 'a.png'], ['att4', 'image/png', 'att4']])
})

// ---- the host ----

test('without the jira service: no hint, no jira field, no call (as 0.1.0)', async () => {
  const b = await signedIn({ jira: null })
  const items = lastItems(b.triage)
  for (const id of Object.values(ID)) {
    assert.ok(items[id], id)
    assert.equal(items[id].hint, undefined)
    assert.equal(items[id].floor, undefined)
    assert.equal(items[id].fields.jira, undefined)
  }
  assert.match((await b.ctx.runCli(['status'])).stdout, /jira +off: enable the Jira plugin/)
  await b.h.stop()
})

test('with the jira service: moved = noise, Done = fyi, mention on my open issue = floor action; others to Jev', async () => {
  const b = await signedIn()
  const items = lastItems(b.triage)
  assert.deepEqual(items[ID.moved].hint, { priority: 'noise' })
  assert.deepEqual(items[ID.done].hint, { priority: 'fyi' })
  assert.equal(items[ID.mention].floor, 'action')
  assert.equal(items[ID.mention].hint, undefined)
  for (const id of [ID.other, ID.link, ID.mixed]) assert.equal(items[id].hint || items[id].floor, undefined, id)
  assert.deepEqual(Object.fromEntries(Object.entries(ID).map(([k, id]) => [k, items[id].fields.jira])), { moved: 'ABC-1', mention: 'ABC-2', done: 'ABC-3', other: 'XYZ-9', link: undefined, mixed: 'ABC-1' })
  // Mail that is not Jira's is as before.
  assert.equal(items[T.t1].fields.jira, undefined)
  // A move needs no lookup; every other key once, as fresh as its mail.
  const asked = b.jira.calls.filter((c) => c[0] === 'issue').map((c) => c[1]).sort()
  assert.deepEqual(asked, ['ABC-1', 'ABC-2', 'ABC-3', 'XYZ-9'])
  assert.ok(b.jira.calls.filter((c) => c[0] === 'issue').every((c) => c[2].maxAgeMs >= 15000 && c[2].maxAgeMs <= J.TTL_MS))
  assert.match((await b.ctx.runCli(['status'])).stdout, /jira +on \(bronos\.jira\)/)
  // The next round asks nothing again (cached).
  const lookups = () => b.jira.calls.filter((c) => c[0] === 'issue').length
  const n = lookups()
  await b.h.classifyChanged(new Set([ID.mention]))
  assert.equal(lookups(), n)
  await b.h.stop()
})

test('a slow Jira does not hold the poll: no hint first, the row is judged again when the lookup lands', async () => {
  const b = await signedIn({ jira: fakeJiraService({ issues: ISSUES, issueDelay: 80 }), lookupWaitMs: 10 })
  assert.equal(lastItems(b.triage)[ID.done].hint, undefined, 'not known yet')
  await until(() => (lastItems(b.triage)[ID.done].hint || {}).priority === 'fyi')
  assert.equal(lastItems(b.triage)[ID.mention].floor, 'action')
  await b.h.stop()
})

test('a Jira that is not configured: site() not ready, so no hint and no lookup', async () => {
  const b = await signedIn({ jira: fakeJiraService({ issues: ISSUES, site: { ready: false, site: '', senders: [], account: null, error: 'jira: not configured' } }) })
  const items = lastItems(b.triage)
  assert.equal(items[ID.moved].hint, undefined)
  assert.equal(b.jira.calls.filter((c) => c[0] === 'issue').length, 0)
  await b.h.stop()
})

test('the thread view of a Jira mail: the issue below the mail, its facts in the aside, its picture as an asset', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), { opened: true }) }
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.equal(calls.length, 1)
  const c = calls[0]
  const at = c.html.indexOf(`<h2>Jira issue <a href="${JIRA_SITE}/browse/ABC-2">ABC-2</a></h2>`)
  assert.ok(at > c.html.indexOf('mentioned you on a work item'), 'below the mail')
  assert.match(c.html.slice(at), /<div class="card"><h3>ABC-2: Summary of ABC-2<\/h3><\/div>\n<h4>Description<\/h4>/)
  assert.match(c.aside, /<dt>Jira issue<\/dt><dd><a href="https:\/\/acme\.atlassian\.net\/browse\/ABC-2">ABC-2<\/a><\/dd><dt>Status<\/dt><dd><span class="lozenge lozenge-info">In Progress<\/span><\/dd><dt>Priority<\/dt><dd>High<\/dd><dt>Assignee<\/dt><dd><span class="person">Oleg Example<\/span> <span class="muted">\(you\)<\/span>/)
  assert.deepEqual(c.assets.map((a) => a.id), ['att501'])
  const doc = b.jira.calls.find((x) => x[0] === 'document')
  assert.deepEqual(doc, ['document', 'ABC-2', { maxHtmlBytes: 800000, maxImages: 7, maxImageChars: 3.5 * 1024 * 1024, waitMs: 8000 }])
  await b.h.stop()
})

test('the thread view finds the issue from a body link when the subject has no key', async () => {
  const calls = []
  const b = await signedIn({ reviewer: { annotate: async (spec) => (calls.push(spec), {}) } })
  await b.ctx.sendPanel({ type: 'open', id: ID.link })
  assert.match(calls[0].html, /<h2>Jira issue <a href="https:\/\/acme\.atlassian\.net\/browse\/OPS-7">OPS-7<\/a><\/h2>/)
  await b.h.stop()
})

test('the thread view degrades: a failing document leaves the mail with a short note (the facts stay)', async () => {
  const calls = []
  const b = await signedIn({ reviewer: { annotate: async (spec) => (calls.push(spec), {}) }, jira: fakeJiraService({ issues: ISSUES, docError: 'jira: busy (issue documents: 1 at a time, 3 waiting); try again shortly' }) })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.match(calls[0].html, /<p class="muted"><em>The issue is not shown here: jira: busy \(issue documents: 1 at a time, 3 waiting\); try again shortly\.<\/em><\/p>/)
  assert.match(calls[0].aside, /<dt>Status<\/dt>/)
  assert.equal(calls[0].assets, undefined)
  assert.ok(b.ctx.logs.some(([lvl, t]) => lvl === 'warn' && /the issue ABC-2 with the mail: jira: busy/.test(t)))
  await b.h.stop()
})

test('the thread view does not wait forever for Jira', async () => {
  const calls = []
  const b = await signedIn({ reviewer: { annotate: async (spec) => (calls.push(spec), {}) }, jira: fakeJiraService({ issues: ISSUES, docDelay: 500 }), viewWaitMs: 20 })
  const t0 = Date.now()
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.ok(Date.now() - t0 < 400)
  assert.match(calls[0].html, /The issue is not shown here: the Jira plugin did not answer in time\./)
  await b.h.stop()
})

test('the thread view of other mail, or without the service, has no Jira section', async () => {
  const calls = []
  const b = await signedIn({ reviewer: { annotate: async (spec) => (calls.push(spec), {}) } })
  await b.ctx.sendPanel({ type: 'open', id: T.t1 })
  assert.doesNotMatch(calls[0].html, /Jira issue/)
  const n = b.jira.calls.filter((c) => c[0] === 'document').length
  assert.equal(n, 0)
  await b.h.stop()
  const calls2 = []
  const c = await signedIn({ jira: null, reviewer: { annotate: async (spec) => (calls2.push(spec), {}) } })
  await c.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.doesNotMatch(calls2[0].html, /Jira issue/)
  await c.h.stop()
})

test('the text fallback of the reviewer gets one line about the issue', async () => {
  const calls = []
  const reviewer = {
    annotate: async (spec) => {
      calls.push(spec)
      if (spec.html) throw new Error('reviewer: html is not supported')
      return {}
    },
  }
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.done })
  assert.equal(calls.length, 2)
  assert.match(calls[1].text, /^Jira issue ABC-3: Summary of ABC-3 \(Done, High, assigned to Oleg Example \(you\)\) https:\/\/acme\.atlassian\.net\/browse\/ABC-3\n\n/)
  await b.h.stop()
})

// ---- beside the mail (cc-cockpit 0.9.3: the reviewer's companion) ----

/** A reviewer with features(): `companion` says whether it lists the companion; `refuse` rejects a call with one. */
function companionReviewer({ companion = true, refuse = null } = {}) {
  const calls = []
  return {
    calls,
    features: async () => (companion ? ['companion'] : []),
    annotate: async (spec) => {
      calls.push(spec)
      if (refuse && spec.companion) throw new Error(refuse)
      return { opened: true }
    },
  }
}

test('a reviewer with companion: the issue beside the mail, its own facts, the mail alone in html and aside', async () => {
  const reviewer = companionReviewer()
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.equal(reviewer.calls.length, 1)
  const c = reviewer.calls[0]
  assert.doesNotMatch(c.html, /Jira issue/) // nothing below the mail
  assert.doesNotMatch(c.aside, /<dt>Jira issue<\/dt>/) // the mail's details only
  assert.equal(c.assets, undefined) // the mail has no pictures; the issue's go with the companion
  assert.deepEqual(Object.keys(c.companion).sort(), ['assets', 'facts', 'html', 'label', 'title', 'url', 'urlLabel'])
  assert.equal(c.companion.title, 'ABC-2: Summary of ABC-2')
  // The column header bars: "Mail" / "Open in Gmail ↗" and "Jira · ABC-2" / "Open in Jira ↗".
  assert.deepEqual([c.label, c.urlLabel, c.companion.label, c.companion.urlLabel], ['Mail', 'Gmail', 'Jira · ABC-2', 'Jira'])
  assert.equal(c.companion.url, `${JIRA_SITE}/browse/ABC-2`)
  assert.match(c.companion.html, /^<div class="card"><h1>ABC-2: Summary of ABC-2<\/h1><\/div>/) // as Jira sent it, h1 kept
  assert.equal(c.companion.facts, '<dl class="facts"><dt>Status</dt><dd>In Progress</dd></dl>') // the document's own
  assert.deepEqual(c.companion.assets.map((a) => a.id), ['att501'])
  // Asked with the larger html budget: beside the mail it does not share the mail's 2 MiB.
  const doc = b.jira.calls.find((x) => x[0] === 'document')
  assert.deepEqual(doc, ['document', 'ABC-2', { maxHtmlBytes: 2000000, maxImages: 7, maxImageChars: 3.5 * 1024 * 1024, waitMs: 8000 }])
  await b.h.stop()
})

test('a companion without the document\'s own facts gets the ones made from issue()', async () => {
  const reviewer = companionReviewer()
  const b = await signedIn({ reviewer, jira: fakeJiraService({ issues: ISSUES, docs: { 'ABC-2': { aside: undefined, title: '  ' } } }) })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  const c = reviewer.calls[0].companion
  assert.equal(c.title, 'Jira issue ABC-2')
  assert.match(c.facts, /<dt>Status<\/dt><dd><span class="lozenge lozenge-info">In Progress<\/span><\/dd>/)
  await b.h.stop()
})

test('the picture budget is shared: the issue\'s pictures beside the mail fit with the mail\'s', async () => {
  const pic = (id) => ({ id, name: `${id}.png`, mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(900000)}` })
  const many = Array.from({ length: 12 }, (_, i) => pic(`att${i}`))
  const reviewer = companionReviewer()
  const b = await signedIn({ reviewer, jira: fakeJiraService({ issues: ISSUES, docs: { 'ABC-2': { assets: many } } }) })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  const c = reviewer.calls[0]
  const total = [...(c.assets || []), ...c.companion.assets].reduce((n, a) => n + a.dataUrl.length, 0)
  assert.ok(total <= 7.5 * 1024 * 1024, String(total))
  assert.ok(c.companion.assets.length >= 1 && c.companion.assets.length < many.length)
  await b.h.stop()
})

test('an older reviewer (no features) or one without companion: the issue below the mail, as before', async () => {
  for (const reviewer of [{ calls: [], annotate: async function (spec) { this.calls.push(spec); return {} } }, companionReviewer({ companion: false })]) {
    const b = await signedIn({ reviewer })
    await b.ctx.sendPanel({ type: 'open', id: ID.mention })
    const c = reviewer.calls[0]
    assert.equal(c.companion, undefined)
    assert.equal(c.label, undefined) // no header bars without a companion
    assert.match(c.html, /<h2>Jira issue <a href="https:\/\/acme\.atlassian\.net\/browse\/ABC-2">ABC-2<\/a><\/h2>/)
    assert.deepEqual(b.jira.calls.find((x) => x[0] === 'document')[2].maxHtmlBytes, 800000)
    await b.h.stop()
  }
})

test('a refused companion call is tried once more with the issue below the mail; a failed document goes below with its note', async () => {
  const reviewer = companionReviewer({ refuse: 'reviewer: companion.html is larger than 2 MiB' })
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.equal(reviewer.calls.length, 2)
  assert.ok(reviewer.calls[0].companion)
  assert.equal(reviewer.calls[1].companion, undefined)
  assert.equal(reviewer.calls[1].label, undefined)
  assert.match(reviewer.calls[1].html, /<h2>Jira issue /)
  assert.ok(b.ctx.logs.some(([, t]) => /reviewer refused the issue beside/.test(t)))
  await b.h.stop()
  // A document asked for beside the mail that is too long for below it: the note says so.
  const big = companionReviewer({ refuse: 'reviewer: no' })
  const c = await signedIn({ reviewer: big, jira: fakeJiraService({ issues: ISSUES, docs: { 'ABC-2': { html: `<p>${'x'.repeat(900000)}</p>` } } }) })
  await c.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.equal(big.calls[0].companion.html.length, 900007)
  assert.match(big.calls[1].html, /The issue is not shown here: the issue is too long to show below the mail\./)
  await c.h.stop()
  // No document at all: no companion call, the issue's section below with its note.
  const failing = companionReviewer()
  const d = await signedIn({ reviewer: failing, jira: fakeJiraService({ issues: ISSUES, docError: 'jira: busy' }) })
  await d.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.equal(failing.calls.length, 1)
  assert.equal(failing.calls[0].companion, undefined)
  assert.match(failing.calls[0].html, /The issue is not shown here: jira: busy\./)
  await d.h.stop()
})

test('Jira off: no companion even from a reviewer that has one (features are asked for the mail layout)', async () => {
  let asked = 0
  const calls = []
  const reviewer = { features: async () => (asked++, ['companion']), annotate: async (spec) => (calls.push(spec), {}) }
  const b = await signedIn({ reviewer, jira: null })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.equal(asked, 1)
  assert.equal(calls[0].companion, undefined)
  assert.equal(calls[0].kind, undefined, 'no mail layout without the feature')
  await b.h.stop()
})

/** A cc-cockpit 0.13.0 reviewer: the mail layout, document buttons and update. */
function mailReviewer(features = ['companion', 'prepare', 'type', 'mail', 'actions', 'update']) {
  const r = { calls: [], updates: [], features: async () => features }
  r.annotate = async (spec) => (r.calls.push(spec), { opened: true })
  r.update = async (u) => (r.updates.push(u), { updated: true })
  return r
}

test('mail layout: the related card from the Jira service, under the subject; the issue still below the mail', async () => {
  const reviewer = mailReviewer(['mail', 'actions', 'update'])
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.mention })
  const c = reviewer.calls[0]
  assert.equal(c.kind, 'mail')
  assert.equal(c.aside, undefined, 'the mail layout has no details column')
  assert.match(c.html, /^<h1>\[Acme\] \(ABC-2\) Rotate keys<\/h1>\n<div class="mail-related"><span class="mail-badge">JIRA<\/span><div class="mail-related-main"><div class="mail-related-title" title="ABC-2 Summary of ABC-2">ABC-2 · Summary of ABC-2<\/div><div class="mail-related-meta">In Progress · Bug · Oleg Example \(you\)<\/div><\/div><a class="mail-related-open" href="https:\/\/acme\.atlassian\.net\/browse\/ABC-2">Open in Jira<\/a><\/div>/)
  assert.match(c.html, /<h2>Jira issue <a href="https:\/\/acme\.atlassian\.net\/browse\/ABC-2">ABC-2<\/a><\/h2>/)
  await b.h.stop()
})

test('mail layout: without an issue lookup the card comes from the mail (its subject, its status move); beside a companion the aside stays', async () => {
  const reviewer = mailReviewer()
  // Jira knows no ABC-1 here: the lookup fails, the mail's own words remain.
  const moved = '<p>Oleg Example changed the status</p><p>Status: To Do <img src="https://acme.atlassian.net/images/arrow.png" alt="&amp;#x2192;" width="16" height="16"> In Progress</p>'
  const id = '18f0a1b2c3d4e5c1'
  const extraThreads = { [id]: thread(id, msg(id, { subject: '[Acme] (ABC-1) Checkout fails', snippet: 'moved', html: moved })) }
  const b = await signedIn({ reviewer, extraThreads, jira: fakeJiraService({ issues: {}, docError: 'jira: busy' }) })
  await b.ctx.sendPanel({ type: 'open', id })
  const c = reviewer.calls[reviewer.calls.length - 1]
  assert.equal(c.kind, 'mail')
  assert.match(c.html, /<div class="mail-related-title" title="ABC-1 Checkout fails">ABC-1 · Checkout fails<\/div><div class="mail-related-meta">To Do <span class="mail-arrow">→<\/span> <span class="mail-status-to">In Progress<\/span><\/div>/)
  assert.match(c.html, /Status: To Do {1,2}→ {1,2}In Progress/, 'the arrow picture reads as its (twice escaped) alt')
  await b.h.stop()
  // Beside the issue (a companion), the mail keeps its details column.
  const r2 = mailReviewer()
  const d = await signedIn({ reviewer: r2 })
  await d.ctx.sendPanel({ type: 'open', id: ID.mention })
  assert.ok(r2.calls[0].companion)
  assert.equal(r2.calls[0].kind, 'mail')
  assert.match(r2.calls[0].aside, /<dl class="facts">/)
  await d.h.stop()
})

test('checkDocument: the title made one line (else Jira issue KEY), the aside only as a string within budget', () => {
  const ok = J.checkDocument({ key: 'ABC-1', title: ' ABC-1:\n Fix ', html: '<p>x</p>', aside: '<dl></dl>' }, 1000, new Set())
  assert.equal(ok.title, 'ABC-1: Fix')
  assert.equal(ok.aside, '<dl></dl>')
  assert.equal(J.checkDocument({ key: 'ABC-1', html: '' }, 1000, new Set()).title, 'Jira issue ABC-1')
  assert.equal(J.checkDocument({ key: 'not a key ABC-1', html: '' }, 1000, new Set()).title, 'Jira issue')
  assert.equal(J.checkDocument({ html: '', aside: 'a'.repeat(90001) }, 1000, new Set()).aside, null)
  assert.equal(J.checkDocument({ html: '', aside: 5 }, 1000, new Set()).aside, null)
  assert.match(J.checkDocument({ html: 'a\0' }, 1000, new Set()).error, /NUL/)
  const c = J.jiraCompanion({ key: 'ABC-1', checked: ok, assets: [], url: 'javascript:x', fallbackFacts: '<p>f</p>' })
  assert.deepEqual(c, { title: 'ABC-1: Fix', html: '<p>x</p>', label: 'Jira · ABC-1', urlLabel: 'Jira', facts: '<dl></dl>' })
})
