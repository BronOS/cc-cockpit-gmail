'use strict'
// The Original | Reader view (0.6.0, the reviewer's feature 'original'): the original-mode sanitizer
// (sanitize.js sanitizeOriginal and css.js), the per-sender memory of the view (views.js), and the
// host: annotate's `originals` and `view`, the reviewer's `view` event remembered for the sender, the
// default view setting, and the fallbacks to Reader (no HTML part, CSS over the cap, an older reviewer).
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { sanitizeOriginal, sanitizeHtml, remoteAssetId } = require('../dist/lib/sanitize')
const { sanitizeStylesheet, sanitizeStyle, MAX_CSS } = require('../dist/lib/css')
const V = require('../dist/lib/views')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, fakeStorage, tokens, fixture, NOW } = require('./fakes')

// ---- the CSS ----

test('css: keeps what draws, drops what loads, runs or escapes', () => {
  const cases = [
    // [input, output]
    ['p{color:red}', 'p{color:red}'],
    ['.old{color:#bf2600;text-decoration:line-through}', '.old{color:#bf2600;text-decoration:line-through}'],
    ['@import url(https://evil.example/x.css); p{color:red}', 'p{color:red}'],
    ['@import "https://evil.example/x.css"; p{color:red}', 'p{color:red}'],
    ['.a{background:url(https://evil.example/bg.png);color:red}', '.a{color:red}'],
    ['.a{background-image:URL( "http://evil.example/bg.png" )}', ''],
    ['.a{background:url(data:image/png;base64,iVBORw0KGgo=)}', '.a{background:url(data:image/png;base64,iVBORw0KGgo=)}'],
    ['.a{background:url(data:image/svg+xml;base64,PHN2Zz4=)}', ''],
    ['.a{background:image-set("https://evil.example/a.png" 1x)}', ''],
    ['.a{background:src("https://evil.example/a.png")}', ''],
    ['.a{width:expression(alert(1))}', ''],
    ['.a{behavior:url(x.htc)}', ''],
    ['.a{-moz-binding:url(x.xml#b)}', ''],
    ['.a{scroll-behavior:smooth}', '.a{scroll-behavior:smooth}'],
    ['.a{position:fixed;top:0}', '.a{top:0}'],
    ['.a{position:sticky}', ''],
    ['.a{position:relative}', '.a{position:relative}'],
    ['.a{background:\\75 rl(https://evil.example/x)}', ''],
    ['.a\\{x{color:red}', ''],
    ['.a{color:red}</style><script>alert(1)</script>', '.a{color:red}'],
    ['.a{content:"<"}', ''],
    ['/* a comment */ p { color : red ; }', 'p{color:red}'],
    ['p{color:u/**/rl(x)}', 'p{color:u rl(x)}'],
    ['@font-face{font-family:x;src:url(https://evil.example/f.woff)} p{color:red}', 'p{color:red}'],
    ['@media (max-width:600px){.b{width:100%!important;position:fixed}}', '@media (max-width:600px){.b{width:100%!important}}'],
    ['@media screen{@import url(x);.c{color:red}}', '@media screen{.c{color:red}}'],
    ['@keyframes spin{from{opacity:0}}', ''],
    ['.a{color:red;background:url(http://x)', '.a{color:red}'], // unclosed at the end: a browser closes it too
  ]
  for (const [input, out] of cases) assert.equal(sanitizeStylesheet(input), out, input)
  assert.equal(sanitizeStyle('color:red; background-image:url(http://evil.example/t.png); text-decoration:line-through; position:fixed'), 'color:red;text-decoration:line-through')
  assert.equal(sanitizeStyle('background-color:#e3fcef;padding:12px'), 'background-color:#e3fcef;padding:12px')
  assert.equal(sanitizeStyle('x'.repeat(8001)), '')
})

// ---- the original mode ----

test('sanitizeOriginal: keeps the layout and styling, drops what runs, loads or navigates', () => {
  const r = sanitizeOriginal(
    `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/l.css">
<style>.card{border:1px solid #dfe1e6}.hero{background:url(https://evil.example/bg.png);color:#172b4d}</style><script>alert(1)</script></head>
<body bgcolor="#f4f5f7" style="margin:0" onload="alert(2)">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" align="center"><tr><td class="card" style="background-color:#e3fcef;background-image:url(https://evil.example/c.png)" onclick="alert(3)">
<b>Status</b>: <span style="text-decoration:line-through;color:#bf2600">To Do</span> <font color="#006644">In Progress</font>
<a href="javascript:alert(4)">js</a> <a href="https://jira.example.com/browse/PROJ-1" target="_top" ping="https://evil.example/p">View issue</a>
<img src="https://evil.example/t.gif" width="1" height="1"><img src="https://cdn.example.com/hero.png" alt="Hero" width="560" height="200" onerror="alert(5)" srcset="https://evil.example/2x.png 2x">
<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg"><img src="cid:logo@x" alt="Logo">
<svg onload="alert(6)"><a href="https://evil.example/">x</a></svg><iframe src="https://evil.example/"></iframe><object data="https://evil.example/o"></object><embed src="https://evil.example/e">
<form action="https://evil.example/f"><input name="q"><button>Go</button><textarea>t</textarea><select><option>o</option></select>Search</form>
<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video><td background="https://evil.example/td.png">cell</td>
</td></tr></table>
<div class="footer">Unsubscribe from these emails · Privacy policy</div>
</body></html>`,
    { cid: (k) => (k === 'logo@x' ? 'c1' : null) },
  )
  const html = r.html
  assert.match(html, /^<style>\.card\{border:1px solid #dfe1e6\}\.hero\{color:#172b4d\}<\/style>\s*<div bgcolor="#f4f5f7" style="margin:0">/)
  assert.match(html, /<table role="presentation" width="600" cellpadding="0" cellspacing="0" align="center"><tr><td class="card" style="background-color:#e3fcef">/)
  assert.match(html, /<b>Status<\/b>: <span style="text-decoration:line-through;color:#bf2600">To Do<\/span> <font color="#006644">In Progress<\/font>/)
  assert.match(html, /<a>js<\/a> <a href="https:\/\/jira\.example\.com\/browse\/PROJ-1">View issue<\/a>/)
  assert.match(html, new RegExp(`<img data-asset="${remoteAssetId('https://cdn.example.com/hero.png')}" alt="Hero" width="560" height="200">`))
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="inline">/)
  assert.match(html, /<img alt="svg">/)
  assert.match(html, /<img data-asset="c1" alt="Logo">/)
  assert.match(html, /Search/)
  // The footer is the sender's own layout: not folded in the Original view.
  assert.match(html, /<div class="footer">Unsubscribe from these emails · Privacy policy<\/div>/)
  assert.doesNotMatch(html, /mail-footer|<details/)
  for (const bad of [/<script/i, /<meta/i, /<base/i, /<link/i, /<svg/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /<input/i, /<button/i, /<textarea/i, /<select/i, /<video/i, /\son[a-z]+=/i, /javascript:/i, /ping=/, /srcset=/, /background=/, /poster=/, /target=/, /evil\.example/]) {
    assert.doesNotMatch(html, bad)
  }
  assert.deepEqual(r.remote.map((x) => x.url), ['https://cdn.example.com/hero.png'])
  assert.deepEqual([...r.usedCids], ['logo@x'])
  // The Reader view of the same mail has no style at all.
  assert.doesNotMatch(sanitizeHtml('<p style="color:red">x</p><style>p{}</style>').html, /style/)
})

test('sanitizeOriginal: a logo or avatar is marked minor; CSS over the cap means no original', () => {
  const r = sanitizeOriginal('<img src="https://cdn.example.com/avatar.png" alt="Ann" width="24" height="24">')
  assert.match(r.html, /<img data-asset="r[0-9a-f]+" data-minor alt="Ann" width="24" height="24">/)
  assert.equal(sanitizeOriginal(`<style>${'p{}'.repeat(MAX_CSS / 3 + 1)}</style><p>x</p>`), null)
})

// ---- the view memory ----

test('views: a choice per sender, newest last and bounded; the setting for the rest', () => {
  assert.deepEqual(V.cleanViews([['Ann@Example.com', 'reader'], ['bad', 'reader'], ['bob@example.com', 'raw'], ['ann@example.com', 'original'], 'x']), [['ann@example.com', 'original']])
  assert.deepEqual(V.cleanViews({ __proto__: 1 }), [])
  let list = V.chooseView([], 'Jira@Example.com', 'reader')
  assert.deepEqual(list, [['jira@example.com', 'reader']])
  assert.equal(V.viewFor(list, 'jira@example.com', 'original'), 'reader')
  assert.equal(V.viewFor(list, 'other@example.com', 'original'), 'original')
  assert.equal(V.viewFor(list, 'other@example.com', 'reader'), 'reader')
  assert.equal(V.viewFor(list, '', 'weird'), 'original')
  list = V.chooseView(list, 'ann@example.com', 'original')
  list = V.chooseView(list, 'jira@example.com', 'original')
  assert.deepEqual(list, [['ann@example.com', 'original'], ['jira@example.com', 'original']])
  assert.equal(V.chooseView(list, 'not an address', 'reader'), list)
  assert.equal(V.chooseView(list, 'ann@example.com', 'raw'), list)
  for (let i = 0; i < V.MAX_VIEW_SENDERS + 5; i++) list = V.chooseView(list, `s${i}@example.com`, 'reader')
  assert.equal(list.length, V.MAX_VIEW_SENDERS)
  assert.equal(list[list.length - 1][0], `s${V.MAX_VIEW_SENDERS + 4}@example.com`)
})

// ---- the host ----

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))
const ID = { jira: '18f0a1b2c3d4e7a1', plain: '18f0a1b2c3d4e7a2', heavy: '18f0a1b2c3d4e7a3' }
const JIRA_HTML = '<html><head><style>.old{text-decoration:line-through;color:#bf2600}</style></head><body><table role="presentation" width="600"><tr><td style="background-color:#e3fcef">Status: <span class="old">To Do</span> In Progress. <a href="https://jira.example.com/browse/PROJ-1">View issue</a></td></tr></table></body></html>'

function msg(threadId, n, o) {
  const body = o.html || o.plain
  return {
    id: `${threadId.slice(0, 14)}${String(n).padStart(2, '0')}`,
    threadId,
    labelIds: ['UNREAD', 'INBOX'],
    snippet: 'snippet',
    historyId: '900',
    internalDate: String(NOW - 3600000 + n),
    payload: {
      partId: '',
      mimeType: o.html ? 'text/html' : 'text/plain',
      filename: '',
      headers: [
        { name: 'From', value: o.from },
        { name: 'To', value: 'Me <me@example.com>' },
        { name: 'Subject', value: o.subject },
      ],
      body: { size: body.length, data: Buffer.from(body).toString('base64url') },
    },
  }
}

function threads() {
  return {
    [ID.jira]: { id: ID.jira, historyId: '1100', messages: [msg(ID.jira, 1, { from: 'Jira <jira@example.com>', subject: 'PROJ-1 moved', html: JIRA_HTML })] },
    [ID.plain]: { id: ID.plain, historyId: '1100', messages: [msg(ID.plain, 2, { from: 'Ann Example <ann@example.com>', subject: 'Lunch', plain: 'Lunch at noon?' })] },
    [ID.heavy]: { id: ID.heavy, historyId: '1100', messages: [msg(ID.heavy, 3, { from: 'News <news@example.com>', subject: 'Heavy', html: `<style>${'p{}'.repeat(MAX_CSS / 3 + 1)}</style><p>Too much style.</p>` })] },
  }
}

function reviewerWith(features) {
  const r = { calls: [], updates: [], features: async () => features }
  r.annotate = async (spec) => (r.calls.push(spec), { opened: true })
  r.update = async (u) => (r.updates.push(u), { updated: true })
  return r
}
const ALL = ['companion', 'prepare', 'type', 'mail', 'actions', 'update', 'original']

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function signedIn({ reviewer, app = {}, appStorage = fakeStorage() }) {
  const reg = tokens()
  const gmail = fakeGmail({ tokens: reg, threads: threads(), lists: { unread: [ID.jira, ID.plain, ID.heavy], alerts: [], read: [] } })
  const ctx = fakeCtx({ project: {}, app, oauth: fakeOAuth(reg), triage: fakeTriage(), reviewer, appStorage })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, imageWaitMs: 50, remoteWaitMs: 2000, resolve: async () => [], send: async () => ({ status: 404 }) })
  await h.ready
  await ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await ctx.sendPanel({ type: 'signIn' })
  await until(() => h.S.cache && h.S.cache.lastPoll)
  await h.S.polling
  await h.S.classifying
  return { ctx, h, appStorage }
}

test('host: a mail with HTML opens with its original and the Original view; the switch is remembered for the sender', async () => {
  const reviewer = reviewerWith(ALL)
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.jira })
  const c = reviewer.calls[0]
  assert.equal(c.view, 'original')
  assert.equal(c.originals.length, 1)
  assert.equal(c.originals[0].id, 'm1')
  assert.match(c.originals[0].html, /^<style>\.old\{text-decoration:line-through;color:#bf2600\}<\/style><div><table role="presentation" width="600"><tr><td style="background-color:#e3fcef">/)
  // The markers: the Reader body of the message and the place of its frame.
  assert.match(c.html, /<div class="mail-body" data-reader="m1">.*View issue.*<\/div><div data-original="m1"><\/div>/s)
  // Reader chosen on the page: kept for jira@example.com, and the next open of their mail is in Reader.
  await b.ctx.serviceEvent('reviewer', 'view', { key: `gmail:${ID.jira}`, view: 'reader', caller: 'bronos.gmail' })
  assert.deepEqual(await b.appStorage.get(V.VIEWS_KEY), [['jira@example.com', 'reader']])
  // Not ours, or a view that is not one: nothing changes.
  await b.ctx.serviceEvent('reviewer', 'view', { key: `gmail:${ID.jira}`, view: 'original', caller: 'bronos.jira' })
  await b.ctx.serviceEvent('reviewer', 'view', { key: `gmail:${ID.jira}`, view: 'raw', caller: 'bronos.gmail' })
  await b.ctx.serviceEvent('reviewer', 'view', { key: 'gmail:unknown', view: 'original', caller: 'bronos.gmail' })
  assert.deepEqual(await b.appStorage.get(V.VIEWS_KEY), [['jira@example.com', 'reader']])
  await b.ctx.sendPanel({ type: 'open', id: ID.jira })
  assert.equal(reviewer.calls[1].view, 'reader')
  assert.equal(reviewer.calls[1].originals.length, 1, 'the original still goes: the switch is on the page')
  await b.h.stop()
})

test('host: the default view setting; Reader alone for a mail with no HTML, CSS over the cap, or an older reviewer', async () => {
  const reviewer = reviewerWith(ALL)
  const b = await signedIn({ reviewer, app: { defaultView: 'reader' } })
  await b.ctx.sendPanel({ type: 'open', id: ID.jira })
  assert.equal(reviewer.calls[0].view, 'reader')
  await b.ctx.sendPanel({ type: 'open', id: ID.plain })
  assert.equal(reviewer.calls[1].originals, undefined)
  assert.equal(reviewer.calls[1].view, undefined)
  assert.doesNotMatch(reviewer.calls[1].html, /data-original|data-reader/)
  await b.ctx.sendPanel({ type: 'open', id: ID.heavy })
  assert.equal(reviewer.calls[2].originals, undefined)
  assert.doesNotMatch(reviewer.calls[2].html, /data-original|data-reader|<!--original-->/)
  await b.h.stop()

  const older = reviewerWith(['companion', 'prepare', 'type', 'mail', 'actions', 'update'])
  const o = await signedIn({ reviewer: older })
  await o.ctx.sendPanel({ type: 'open', id: ID.jira })
  assert.equal(older.calls[0].originals, undefined)
  assert.doesNotMatch(older.calls[0].html, /data-original|data-reader/)
  await o.h.stop()
})
