'use strict'
// The mail layout in the host (0.6.0): annotate's `kind: 'mail'` for a reviewer that has it, remote
// pictures loaded only as the settings allow, Show images and Always show from <sender> through the
// reviewer's `action` event and update(), the always-show senders' settings page, and an older
// reviewer getting the cards as before. DNS and the picture requests are faked (io.resolve / send).
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { remoteAssetId } = require('../dist/lib/sanitize')
const { fakeGmail, fakeOAuth, fakeCtx, fakeTriage, fakeStorage, tokens, fixture, picture, NOW } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))
const ID = { promo: '18f0a1b2c3d4e6a1', other: '18f0a1b2c3d4e6a2' }
const HERO = 'https://cdn.example.com/hero.png'
const SIDE = 'https://cdn.example.com/side.png'
const LAN = 'https://lan.example.com/x.png'

function msg(threadId, n, o) {
  const html = o.html
  return {
    id: `${threadId.slice(0, 14)}${String(n).padStart(2, '0')}`,
    threadId,
    labelIds: ['UNREAD', 'INBOX'],
    snippet: o.snippet || 'snippet',
    historyId: '900',
    internalDate: String(o.at || NOW - 3600000),
    payload: {
      partId: '',
      mimeType: 'text/html',
      filename: '',
      headers: [
        { name: 'From', value: o.from },
        { name: 'To', value: 'Me <me@example.com>' },
        { name: 'Subject', value: o.subject },
      ],
      body: { size: html.length, data: Buffer.from(html).toString('base64url') },
    },
  }
}

function threads(extra = '') {
  const promo = `<p>Hello Ann, our spring sale starts today with new things for you.</p><img src="${HERO}" alt="Spring sale" width="600"><img src="${SIDE}" alt="Side" width="300"><img src="https://cdn.example.com/logo.png" alt="Shop logo">${extra}`
  return {
    [ID.promo]: { id: ID.promo, historyId: '1100', messages: [msg(ID.promo, 1, { from: 'Example Shop <news@shop.example.com>', subject: 'Spring sale', html: promo })] },
    [ID.other]: { id: ID.other, historyId: '1100', messages: [msg(ID.other, 2, { from: 'Ann Example <ann@example.com>', subject: 'Lunch', html: `<p>Lunch?</p><img src="${LAN}" alt="Map" width="400">` })] },
  }
}

/** The fake picture servers: cdn.example.com is public, lan.example.com private (refused). */
function net() {
  const n = { resolved: [], sent: [] }
  n.resolve = async (h) => {
    n.resolved.push(h)
    if (h === 'cdn.example.com') return [{ address: '93.184.216.34', family: 4 }]
    if (h === 'lan.example.com') return [{ address: '192.168.1.5', family: 4 }]
    throw new Error('ENOTFOUND')
  }
  n.send = async (req) => {
    n.sent.push(req.url)
    return { status: 200, type: 'image/png', body: picture('png', 3000) }
  }
  return n
}

function mailReviewer(features = ['companion', 'prepare', 'type', 'mail', 'actions', 'update']) {
  const r = { calls: [], updates: [], features: async () => features }
  r.annotate = async (spec) => (r.calls.push(spec), { opened: true })
  r.update = async (u) => (r.updates.push(u), { updated: true })
  return r
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function signedIn(opts = {}) {
  const reg = tokens()
  const gmail = fakeGmail({ tokens: reg, threads: threads(opts.extraHtml), lists: { unread: [ID.promo, ID.other], alerts: [], read: [] } })
  const n = net()
  const ctx = fakeCtx({ project: {}, app: opts.app || {}, oauth: fakeOAuth(reg), triage: fakeTriage(), reviewer: opts.reviewer, appStorage: opts.appStorage, old: opts.old })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: gmail.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, imageWaitMs: 50, remoteWaitMs: 2000, resolve: n.resolve, send: n.send })
  await h.ready
  await ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await ctx.sendPanel({ type: 'signIn' })
  await until(() => h.S.cache && h.S.cache.lastPoll)
  await h.S.polling
  await h.S.classifying
  return { gmail, ctx, h, n }
}

const key = (id) => `gmail:${id}`

test('Ask (the default): placeholders and the bar with both buttons; nothing is fetched until a click', async () => {
  const reviewer = mailReviewer()
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  const c = reviewer.calls[0]
  assert.equal(c.kind, 'mail')
  assert.match(c.html, /^<h1>Spring sale<\/h1>\n<div class="mail-images-bar" data-part="images-bar"><span class="mail-images-text">2 remote images are not shown \(senders can track when you open mail\)\.<\/span> <span data-action="show-images">Show images<\/span> <span data-action="always-sender" [^>]*>Always show from news@shop\.example\.com<\/span><\/div>/)
  assert.match(c.html, new RegExp(`<img data-asset="${remoteAssetId(HERO)}" alt="Spring sale" title="Spring sale" class="mail-remote">`))
  assert.match(c.html, /class="mail-remote mail-minor"/, 'the logo is a minor placeholder')
  assert.doesNotMatch(c.html, /cdn\.example\.com/)
  assert.equal(c.assets, undefined)
  assert.deepEqual(b.n.resolved, [], 'not even a DNS lookup')
  await b.h.stop()
})

test('Show images: the pictures go into the open document with update(), the bar is hidden; a second open loads them at once', async () => {
  const reviewer = mailReviewer()
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  await b.ctx.serviceEvent('reviewer', 'action', { key: key(ID.promo), id: 'show-images', caller: 'bronos.gmail' })
  await until(() => reviewer.updates.length)
  const u = reviewer.updates[0]
  assert.equal(u.key, key(ID.promo))
  assert.deepEqual(u.assets.map((a) => a.id), [remoteAssetId(HERO), remoteAssetId(SIDE), remoteAssetId('https://cdn.example.com/logo.png')], 'the content first, the logo last')
  assert.match(u.assets[0].dataUrl, /^data:image\/png;base64,/)
  assert.deepEqual(u.hide, ['images-bar'])
  assert.equal(u.status, undefined)
  assert.deepEqual(b.n.sent, [HERO, SIDE, 'https://cdn.example.com/logo.png'])
  // Shown for this mail for the rest of the run: opened again, the pictures come with the annotate.
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  const again = reviewer.calls[1]
  assert.equal(again.assets.length, 3)
  assert.doesNotMatch(again.html, /mail-images-bar/)
  await b.h.stop()
})

test('a click for another plugin, an unknown button or a key never opened is not acted on', async () => {
  const reviewer = mailReviewer()
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  await b.ctx.serviceEvent('reviewer', 'action', { key: key(ID.promo), id: 'show-images', caller: 'bronos.jira' })
  await b.ctx.serviceEvent('reviewer', 'action', { key: key(ID.promo), id: 'delete-all', caller: 'bronos.gmail' })
  await b.ctx.serviceEvent('reviewer', 'action', null)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(reviewer.updates.length, 0)
  assert.equal(b.n.sent.length, 0)
  // Ours but not remembered (opened before a restart): the button comes back with a line saying so.
  await b.ctx.serviceEvent('reviewer', 'action', { key: 'gmail:18f0a1b2c3d4e6ff', id: 'show-images', caller: 'bronos.gmail' })
  await until(() => reviewer.updates.length)
  assert.deepEqual(reviewer.updates[0], { key: 'gmail:18f0a1b2c3d4e6ff', status: 'Open this mail again to show its images.' })
  await b.h.stop()
})

test('a private address is refused: the bar stays and the status line says why', async () => {
  const reviewer = mailReviewer()
  const b = await signedIn({ reviewer })
  await b.ctx.sendPanel({ type: 'open', id: ID.other })
  await b.ctx.serviceEvent('reviewer', 'action', { key: key(ID.other), id: 'show-images', caller: 'bronos.gmail' })
  await until(() => reviewer.updates.length)
  const u = reviewer.updates[0]
  assert.equal(u.assets, undefined)
  assert.equal(u.hide, undefined, 'the bar stays when no picture came')
  assert.equal(u.status, '1 image could not be loaded (refused: lan.example.com is a private address).')
  assert.equal(b.n.sent.length, 0)
  assert.ok(b.ctx.logs.some(([, t]) => /remote image from lan\.example\.com: refused/.test(t)))
  assert.ok(!b.ctx.logs.some(([, t]) => /lan\.example\.com\/x\.png/.test(t)), 'the log has the host, not the URL')
  await b.h.stop()
})

test('Always show from <sender>: the sender goes on the app-wide list, this mail loads, the next mail of theirs loads at open', async () => {
  const reviewer = mailReviewer()
  const appStorage = fakeStorage()
  const b = await signedIn({ reviewer, appStorage })
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  await b.ctx.serviceEvent('reviewer', 'action', { key: key(ID.promo), id: 'always-sender', caller: 'bronos.gmail' })
  await until(() => reviewer.updates.length)
  assert.deepEqual(await appStorage.get('imageSenders'), ['news@shop.example.com'])
  assert.equal(reviewer.updates[0].assets.length, 3)
  // Another window's host reads the list on its next open: here, a fresh run with the same store.
  await b.h.stop()
  const r2 = mailReviewer()
  const c = await signedIn({ reviewer: r2, appStorage })
  await c.ctx.sendPanel({ type: 'open', id: ID.promo })
  assert.equal(r2.calls[0].assets.length, 3)
  assert.doesNotMatch(r2.calls[0].html, /mail-images-bar/)
  // Ann is not on the list: her mail still asks.
  await c.ctx.sendPanel({ type: 'open', id: ID.other })
  assert.match(r2.calls[1].html, /Always show from ann@example\.com/)
  await c.h.stop()
})

test('Remote images "Always": every mail loads at open within the budget; a broken proxy loads none and says so', async () => {
  const reviewer = mailReviewer()
  const b = await signedIn({ reviewer, app: { remoteImages: 'always' } })
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  assert.equal(reviewer.calls[0].assets.length, 3)
  await b.h.stop()
  const r2 = mailReviewer()
  const c = await signedIn({ reviewer: r2, app: { remoteImages: 'always', imageProxy: 'https://img.example.com/' } })
  await c.ctx.sendPanel({ type: 'open', id: ID.promo })
  assert.equal(r2.calls[0].assets, undefined)
  assert.equal(c.n.resolved.length, 0)
  assert.ok(c.ctx.lastState().problems.some((p) => /^imageProxy: /.test(p)))
  await c.h.stop()
})

test('the proxy: pictures are requested through it, the picture host is never resolved', async () => {
  const reviewer = mailReviewer()
  const b = await signedIn({ reviewer, app: { remoteImages: 'always', imageProxy: 'https://cdn.example.com/proxy?u={url}' } })
  await b.ctx.sendPanel({ type: 'open', id: ID.other })
  // lan.example.com is not resolved (its DNS would learn of the open); the proxy fetches it.
  assert.deepEqual(b.n.sent, [`https://cdn.example.com/proxy?u=${encodeURIComponent(LAN)}`])
  assert.ok(!b.n.resolved.includes('lan.example.com'))
  assert.equal(reviewer.calls[0].assets.length, 1)
  await b.h.stop()
})

test('an older reviewer (no mail feature): the cards, a label for each picture, no buttons; a listed sender still loads', async () => {
  const reviewer = mailReviewer(['companion', 'prepare', 'type'])
  const appStorage = fakeStorage()
  await appStorage.set('imageSenders', ['news@shop.example.com'])
  const b = await signedIn({ reviewer, appStorage })
  await b.ctx.sendPanel({ type: 'open', id: ID.other })
  const c = reviewer.calls[0]
  assert.equal(c.kind, undefined)
  assert.match(c.html, /<div class="card new">/)
  assert.match(c.html, /<span class="muted">\[image: Map\]<\/span>/)
  assert.doesNotMatch(c.html, /data-action/)
  assert.match(c.aside, /<dl class="facts">/)
  await b.ctx.sendPanel({ type: 'open', id: ID.promo })
  assert.equal(reviewer.calls[1].assets.length, 3, 'the listed sender\'s pictures, as pictures (the logo too, once pictures are allowed)')
  assert.match(reviewer.calls[1].html, new RegExp(`<img data-asset="${remoteAssetId(HERO)}" alt="Spring sale" title="Spring sale">`))
  await b.h.stop()
  // The mail layout without actions/update (a partial reviewer): the bar has no buttons.
  const r2 = mailReviewer(['mail'])
  const d = await signedIn({ reviewer: r2 })
  await d.ctx.sendPanel({ type: 'open', id: ID.promo })
  assert.equal(r2.calls[0].kind, 'mail')
  assert.match(r2.calls[0].html, /mail-images-bar/)
  assert.doesNotMatch(r2.calls[0].html, /data-action/)
  await d.h.stop()
})

test('the settings page: lists, adds and removes senders; refuses what is not an address', async () => {
  const appStorage = fakeStorage()
  await appStorage.set('imageSenders', ['ann@example.com'])
  const b = await signedIn({ reviewer: mailReviewer(), appStorage })
  const page = b.ctx.openSettingsPage()
  await page.send({ type: 'ready' })
  assert.deepEqual(page.posts.pop(), { type: 'senders', list: ['ann@example.com'] })
  await page.send({ type: 'add', address: ' Bob@Example.com ' })
  assert.deepEqual(page.posts.pop(), { type: 'senders', list: ['ann@example.com', 'bob@example.com'], added: true })
  await page.send({ type: 'add', address: 'bob@example.com' })
  assert.deepEqual(page.posts.pop().list, ['ann@example.com', 'bob@example.com'], 'once')
  await page.send({ type: 'remove', address: 'ann@example.com' })
  assert.deepEqual(page.posts.pop(), { type: 'senders', list: ['bob@example.com'], added: false })
  for (const bad of ['not an address', '<x@example.com>', 42, '']) {
    await page.send({ type: 'add', address: bad })
    assert.equal(page.posts.pop().type, 'refused', String(bad))
  }
  await page.send({ type: 'frobnicate' })
  await page.send('nope')
  assert.equal(page.posts.length, 0)
  assert.deepEqual(await appStorage.get('imageSenders'), ['bob@example.com'])
  await b.h.stop()
})

test('an app without ctx.settingsPage starts all the same', async () => {
  const ctx = fakeCtx({ project: {} })
  delete ctx.settingsPage
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, now: () => NOW })
  await h.ready
  await h.stop()
})

test('an app settings change (Remote images) is read again and starts no poll', async () => {
  const b = await signedIn({ reviewer: mailReviewer() })
  const before = b.gmail.calls.length
  await b.ctx.changeSettings(b.ctx.settings.project, { remoteImages: 'always' })
  assert.equal(b.h.S.app.remoteImages, 'always')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(b.gmail.calls.length, before)
  await b.h.stop()
})
