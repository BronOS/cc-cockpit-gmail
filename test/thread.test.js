'use strict'
// The thread view: MIME walking and charsets, the picture budget and cache, the reviewer document
// (only the tags and classes the reviewer keeps), the details aside, the text form and the prompt.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { walkMessage, charsetOf, decodeText, imageMime, MAX_PARTS } = require('../dist/lib/mime')
const img = require('../dist/lib/images')
const { threadDocument, threadDetails, labelNames, fmtSize, imagesBar, initials, when, HTML_MAX_BYTES } = require('../dist/lib/document')
const { remoteAssetId } = require('../dist/lib/sanitize')
const J = require('../dist/lib/jira')
const { esc } = require('../dist/lib/entities')
const { compactMessage } = require('../dist/lib/model')
const { gmailUrl, alertUrl, readableText, discussPrompt, PROMPT_MAX } = require('../dist/lib/readable')
const { ALLOWED } = require('../dist/lib/sanitize')
const { fixture, picture, tmpDir, ME, T } = require('./fakes')

const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64url')

// What the reviewer keeps (plugins/reviewer/src/page/sanitize.mjs in cc-cockpit, 0.9.1).
const CLASSES = new Set(['jira-panel', 'jira-panel-info', 'jira-panel-note', 'jira-panel-warning', 'jira-panel-error', 'jira-panel-success', 'mention', 'card', 'card-header', 'meta', 'new', 'old', 'status', 'lozenge', 'lozenge-info', 'lozenge-success', 'lozenge-warning', 'lozenge-error', 'attachment-list', 'fields', 'muted'])
const TAG_CLASSES = { dl: new Set(['facts']), span: new Set(['person', 'lozenge-neutral', 'lozenge-danger']) }
// The mail layout's classes (MAIL_CLASSES in the reviewer's sanitize.mjs, cc-cockpit 0.13.0), on any element.
for (const c of ['mail-msg', 'mail-head', 'mail-avatar', 'mail-who', 'mail-from', 'mail-name', 'mail-addr', 'mail-to', 'mail-when', 'mail-chip', 'mail-body', 'mail-related', 'mail-badge', 'mail-related-main', 'mail-related-title', 'mail-related-meta', 'mail-status-to', 'mail-arrow', 'mail-related-open', 'mail-images-bar', 'mail-images-text', 'mail-cta', 'mail-footer', 'mail-remote', 'mail-minor', 'mail-note']) CLASSES.add(c)

/** Only allowed tags; a class only from the reviewer's lists; no style, no handler, no src. */
function assertReviewerSafe(html) {
  for (const [, name, attrs] of html.matchAll(/<([a-z][a-z0-9]*)((?: [a-z-]+="[^"]*")*)>/g)) {
    assert.ok(ALLOWED.has(name), `<${name}>`)
    for (const [, k, v] of attrs.matchAll(/ ([a-z-]+)="([^"]*)"/g)) {
      assert.ok(['href', 'title', 'alt', 'data-asset', 'colspan', 'rowspan', 'class', 'data-action', 'data-part'].includes(k), `${k} on <${name}>`)
      if (k === 'data-action') assert.ok(name === 'span' && /^[a-z][a-z0-9-]{0,39}$/.test(v), `data-action ${v} on <${name}>`)
      if (k === 'data-part') assert.ok(['div', 'p', 'span'].includes(name), `data-part on <${name}>`)
      if (k === 'class') for (const c of v.split(' ')) assert.ok(CLASSES.has(c) || (TAG_CLASSES[name] && TAG_CLASSES[name].has(c)), `class ${c} on <${name}>`)
      if (k === 'href') assert.match(v, /^(https:\/\/|http:\/\/|mailto:)/)
    }
  }
  assert.ok(!/<[^>]*\s(on[a-z]+|style|src)=/i.test(html))
}

test('walkMessage: the html and plain parts, inline pictures by Content-ID, files', () => {
  const m = fixture('thread-t1.json').messages[2]
  const w = walkMessage(m)
  assert.match(w.html, /^<html><head><style>/)
  assert.match(w.plain, /^Thanks! Also "the logo"/)
  assert.deepEqual(w.images.map((i) => [i.partId, i.name, i.mime, i.cid, i.attachmentId, i.inline]), [['1', 'logo.png', 'image/png', 'logo@acme', 'ANGjdJ_logo_att_id_1', true]])
  assert.deepEqual(w.files, [{ partId: '2', name: 'Q4.pdf', mime: 'application/pdf', size: 182000 }])
})

test('walkMessage: a charset from Content-Type; an unknown one falls back to utf-8', () => {
  assert.equal(walkMessage(fixture('thread-t3.json').messages[0]).plain, 'Café at noon? See https://example.org/menu.')
  assert.equal(charsetOf('text/html; charset="ISO-8859-1"'), 'iso-8859-1')
  assert.equal(charsetOf('text/plain'), 'utf-8')
  assert.equal(decodeText(b64('caf\xe9', 'latin1'), 'windows-1252'), 'café')
  assert.equal(decodeText(b64('héllo'), 'x-no-such-charset'), 'héllo')
  assert.equal(imageMime('image/JPG'), 'image/jpeg')
})

test('walkMessage: attachments are not bodies; a big body not sent inline is named; nesting is bounded', () => {
  const part = (mimeType, extra = {}) => ({ partId: extra.partId || '0', mimeType, filename: extra.filename || '', headers: extra.headers || [], body: extra.body || { size: 1, data: b64('x') } })
  const m = { payload: { mimeType: 'multipart/mixed', parts: [part('text/html', { filename: 'page.html' }), part('text/html', { body: { size: 3000000, attachmentId: 'big' } }), part('text/plain'), part('image/gif', { filename: 'a.gif', headers: [{ name: 'Content-Disposition', value: 'attachment' }, { name: 'Content-ID', value: '<x@y>' }] })] } }
  const w = walkMessage(m)
  assert.equal(w.html, null)
  assert.deepEqual(w.htmlPart, { attachmentId: 'big', charset: 'utf-8', size: 3000000 })
  assert.equal(w.plain, 'x')
  assert.deepEqual(w.files.map((f) => f.name), ['page.html'])
  assert.equal(w.images[0].inline, false, 'a picture sent as an attachment is not inline even with a Content-ID')
  let deep = part('text/plain')
  for (let k = 0; k < 100; k++) deep = { mimeType: 'multipart/mixed', parts: [deep] }
  assert.equal(walkMessage({ payload: deep }).plain, null, 'too deep: not reached')
  const wide = { payload: { mimeType: 'multipart/mixed', parts: Array.from({ length: MAX_PARTS + 50 }, (_, k) => part('application/pdf', { filename: `f${k}.pdf` })) } }
  assert.ok(walkMessage(wide).files.length < MAX_PARTS)
  assert.deepEqual(walkMessage({}), { html: null, plain: null, htmlPart: null, plainPart: null, images: [], files: [] })
})

const pic = (id, o = {}) => ({ messageId: 'm1', partId: String(id), name: `${id}.png`, mime: 'image/png', size: 1000, at: Number(id), inline: false, attachmentId: `att${id}`, data: null, ...o })

test('the budget numbers: 700 KiB raw under the 1,000,000-char dataUrl cap; 7.5 MiB in all under 8 MiB; 15 at most', () => {
  assert.equal(img.MAX_IMAGE_BYTES, 716800)
  assert.equal(img.dataUrlLength(img.MAX_IMAGE_BYTES, 'image/jpeg'), 955759)
  assert.ok(img.dataUrlLength(img.MAX_IMAGE_BYTES, 'image/webp') < img.MAX_DATAURL_CHARS)
  assert.equal(img.MAX_TOTAL_CHARS, 7864320)
  assert.equal(img.MAX_IMAGES, 15)
})

test('selectImages: inline pictures first, then the newest; raster only; the size, count and total budgets', () => {
  const list = [...Array.from({ length: 18 }, (_, i) => pic(100 + i)), pic(50, { mime: 'image/svg+xml' }), pic(51, { inline: true, at: 1 }), pic(200, { size: img.MAX_IMAGE_BYTES + 1 })]
  const { wanted, skipped } = img.selectImages(list)
  assert.equal(wanted.length, 15)
  assert.equal(wanted[0].partId, '51')
  assert.equal(wanted[1].partId, '117')
  assert.ok(!wanted.some((a) => a.partId === '50' || a.partId === '200'))
  assert.ok(skipped.some((a) => a.partId === '200'))
  const near = img.selectImages(Array.from({ length: 10 }, (_, i) => pic(300 + i, { size: 700 * 1024 })))
  assert.equal(near.wanted.length, 8)
  assert.equal(img.selectImages(Array.from({ length: 10 }, (_, i) => pic(400 + i, { size: null }))).wanted.length, 8, 'an unknown size counts as the maximum')
})

test('sniff reads the bytes, not the claimed type; keys are stable and safe', () => {
  for (const t of ['png', 'jpeg', 'gif', 'webp']) assert.equal(img.sniff(picture(t)), `image/${t}`)
  assert.equal(img.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null)
  assert.equal(img.toDataUrl(Buffer.from('<html>login</html>')), null)
  assert.match(img.partKey({ messageId: 'm', partId: '1' }), /^[a-f0-9]{24}$/)
  assert.equal(img.partKey({ messageId: 'm', partId: '1' }), img.partKey({ messageId: 'm', partId: '1' }))
  assert.match(img.assetId({ messageId: 'm', partId: '1' }), /^img[a-f0-9]{16}$/)
})

test('the image cache: per account, bounded by count and bytes, private files', async () => {
  const dir = path.join(tmpDir(), 'images')
  const c = img.imageCache(dir, ME, { maxFiles: 3, maxBytes: 10000 })
  const other = img.imageCache(dir, 'other@example.com')
  const k = (n) => img.partKey({ messageId: 'm', partId: String(n) })
  await c.put(k(1), picture('png', 100))
  assert.deepEqual(await c.get(k(1)), picture('png', 100))
  assert.equal(await other.get(k(1)), null, 'another account has its own files')
  await assert.rejects(c.get('../x'))
  for (const n of [2, 3, 4]) {
    await new Promise((r) => setTimeout(r, 15))
    await c.put(k(n), picture('png', 100))
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.img')).length, 3)
  assert.equal(await c.get(k(1)), null, 'the oldest went')
  await c.put(k(5), picture('png', 9950))
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.img')).length, 1)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777, 0o600)
})

test('gatherImages: inline data at once, the cache, downloads; a non-picture fails; the wait is bounded', async () => {
  const cache = img.imageCache(path.join(tmpDir(), 'images'), ME)
  await cache.put(img.partKey(pic(3)), picture('gif', 50))
  const started = []
  const r = await img.gatherImages({
    wanted: [pic(1, { data: picture('png', 40).toString('base64url') }), pic(2, { data: b64('<svg/>') }), pic(3), pic(4), pic(5)],
    cache,
    waitMs: 1000,
    download: async (a) => (started.push(a.partId), a.partId === '5' ? Buffer.from('<html>') : picture('jpeg', 60)),
  })
  assert.deepEqual(started, ['4', '5'])
  assert.deepEqual(r.assets.map((a) => [a.name, a.mime]), [['1.png', 'image/png'], ['3.png', 'image/gif'], ['4.png', 'image/jpeg']])
  assert.deepEqual(r.failed.map((f) => f.name).sort(), ['2.png', '5.png'])
  assert.equal(r.byKey.get(img.partKey(pic(4))), img.assetId(pic(4)))
  assert.equal(r.late, 0)
  // A download that does not finish in time: listed as late, and nothing starts after the wait.
  const slow = []
  const t0 = Date.now()
  const late = await img.gatherImages({ wanted: [pic(6), pic(7), pic(8), pic(9)], cache, waitMs: 40, download: (a) => (slow.push(a.partId), new Promise(() => {})) })
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(late.late, 4)
  assert.deepEqual(slow, ['6', '7', '8'])
  const none = await img.gatherImages({ wanted: [pic(3), pic(10)], cache, download: null })
  assert.deepEqual([none.assets.length, none.late], [1, 0])
})

const rawThread = (k) => fixture(`thread-${k}.json`)

test('threadDocument: one card per message, oldest first; the unread one marked; clean HTML with the inline logo', () => {
  const t = rawThread('t1')
  const logo = img.partKey({ messageId: '18f0a1b2c3d4e503', partId: '1' })
  const d = threadDocument({ title: 'Q4 budget', messages: [...t.messages].reverse(), assets: new Map([[logo, 'imgabc']]), aside: true, url: gmailUrl(ME, T.t1), labels: { Label_7: 'Finance' } })
  assertReviewerSafe(d.html)
  assertReviewerSafe(d.aside)
  assert.equal(d.omitted, 0)
  assert.equal(d.remoteImages, 0, 'the 1x1 tracker is dropped, not counted')
  const cards = d.html.split(/(?=<div class="card(?: new)?"><div class="card-header">)/).slice(1)
  assert.equal(cards.length, 3)
  assert.match(cards[0], /Can you send the Q4 numbers by <strong>Friday<\/strong>/)
  assert.match(cards[1], /<details><summary>Quoted text<\/summary><p>On Mon, Ann Smith &lt;ann@acme\.com&gt; wrote:<\/p>/, 'a plain-text body with its quote folded')
  assert.match(cards[2], /^<div class="card new">/)
  assert.match(cards[2], /<span class="lozenge lozenge-info">unread<\/span>/)
  assert.match(cards[2], /<img data-asset="imgabc" alt="Acme logo" title="Acme logo">/)
  assert.match(cards[2], /<ul class="attachment-list"><li>Q4\.pdf · 178 KB<\/li><\/ul>/, 'the inline logo is not listed again')
  assert.ok(!/alert\(1\)|steal|color:red|track\.example/.test(d.html))
})

test('threadDocument: a remote picture is its label with a note; a downloaded attachment is a figure', () => {
  const html = '<p>Hi</p><img src="https://cdn.example.org/banner.png" alt="Banner">'
  const msg = { id: 'm9', internalDate: '1', labelIds: [], payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'A <a@x.org>' }], parts: [{ partId: '0', mimeType: 'text/html', body: { size: html.length, data: b64(html) } }, { partId: '1', mimeType: 'image/png', filename: 'photo.png', body: { size: 2048, attachmentId: 'p' } }, { partId: '2', mimeType: 'image/png', filename: 'huge.png', body: { size: 5e6, attachmentId: 'h' } }] } }
  const d = threadDocument({ title: 'x', messages: [msg], assets: new Map([[img.partKey({ messageId: 'm9', partId: '1' }), 'imgp']]) })
  assertReviewerSafe(d.html)
  assert.equal(d.remoteImages, 1)
  assert.match(d.html, /1 remote picture is not shown: senders can tell when you open a mail by them\. Settings › Plugins › Gmail can show them\./)
  assert.match(d.html, /<span class="muted">\[image: Banner\]<\/span>/)
  assert.doesNotMatch(d.html, /cdn\.example\.org/, 'no link to the picture: a click would load it outside the rules')
  assert.match(d.html, /<li><figure><img data-asset="imgp" alt="photo\.png" title="photo\.png"><figcaption>photo\.png · 2 KB<\/figcaption><\/figure><\/li><li>huge\.png · 4\.8 MB<\/li>/)
  assert.match(d.html, /<div class="card"><h1>x<\/h1>\n<div class="meta">1 message · latest/, 'without the aside the header card carries the facts')
})

test('threadDocument: stays under the reviewer\'s 2 MiB, leaving out the oldest messages; a huge body becomes text', () => {
  const big = (id, at, size) => ({ id, internalDate: String(at), labelIds: [], payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'a@x.org' }], body: { size, data: b64(`<p>${'word '.repeat(size / 5)}</p>`) } } })
  const d = threadDocument({ title: 't', messages: [big('a', 1, 900000), big('b', 2, 900000), big('c', 3, 900000)] })
  assert.ok(Buffer.byteLength(d.html) <= HTML_MAX_BYTES)
  assert.equal(d.omitted, 1)
  assert.match(d.html, /1 earlier message is not shown here/)
  const huge = threadDocument({ title: 't', messages: [big('h', 1, 1500000)] })
  assert.match(huge.html, /too big to show formatted; its text follows/)
  assert.ok(Buffer.byteLength(huge.html) <= HTML_MAX_BYTES)
})

test('threadDetails: the facts list, labels as lozenges, the Gmail link; capped', () => {
  const facts = rawThread('t1').messages.map(compactMessage)
  const a = threadDetails(facts, gmailUrl(ME, T.t1), { Label_7: 'Finance' })
  assertReviewerSafe(a)
  assert.match(a, /^<dl class="facts"><dt>From<\/dt><dd><span class="person">Ann Smith<\/span> <span class="person">Me<\/span><\/dd>/)
  assert.match(a, /<dt>Cc<\/dt><dd><span class="person" title="bob@acme\.com">Bob<\/span><\/dd>/)
  assert.match(a, /<span class="lozenge lozenge-info">Unread<\/span>/)
  assert.match(a, /<span class="lozenge lozenge-neutral">Finance<\/span>/)
  assert.match(a, /<dt>Messages<\/dt><dd>3 \(1 unread\)<\/dd>/)
  assert.match(a, /<a href="https:\/\/mail\.google\.com\/mail\/\?authuser=me%40example\.com#all\/18f0a1b2c3d4e5f1">Open in Gmail<\/a>/)
  const many = Array.from({ length: 3000 }, (_, k) => ({ ...facts[0], to: Array.from({ length: 30 }, (_, j) => `p${k}x${j}@x.org`).join(', '), from: `Person ${k}` }))
  assert.ok(threadDetails(many, null, {}).length < 100000)
  assert.deepEqual(labelNames(['INBOX', 'Label_7', 'Label_9', 'CATEGORY_UPDATES'], { Label_7: 'Finance' }).map((l) => l.name), ['Inbox', 'Finance', 'Updates'])
  assert.deepEqual([fmtSize(10), fmtSize(2048), fmtSize(3 * 1024 * 1024), fmtSize(undefined)], ['10 B', '2 KB', '3.0 MB', ''])
})

test('gmailUrl and alertUrl: the account as authuser, ids and addresses checked', () => {
  assert.equal(gmailUrl(ME, T.t1), `https://mail.google.com/mail/?authuser=me%40example.com#all/${T.t1}`)
  assert.equal(gmailUrl('x y', T.t1), null)
  assert.equal(gmailUrl(ME, '../x'), null)
  assert.equal(alertUrl(ME, ['alerts@example.com'], 'HighCPU'), 'https://mail.google.com/mail/?authuser=me%40example.com#search/from%3Aalerts%40example.com%20subject%3A%22HighCPU%22')
  assert.equal(alertUrl('bad', [], 'x'), null)
})

test('readableText: the thread as text, oldest first, with who, to whom, attachments', () => {
  const t = rawThread('t1')
  const text = readableText({ subject: 'Q4 budget', messages: t.messages, url: gmailUrl(ME, T.t1) })
  const lines = text.split('\n')
  assert.equal(lines[0], 'Q4 budget')
  assert.equal(lines[1], `Gmail: https://mail.google.com/mail/?authuser=me%40example.com#all/${T.t1}`)
  assert.equal(lines[2], '3 messages, oldest first.')
  assert.ok(lines.includes('From: Ann Smith <ann@acme.com>'))
  assert.ok(lines.includes('[unread] From: Ann Smith <ann@acme.com>'))
  assert.ok(lines.includes('Subject: Re: Q4 budget'))
  assert.ok(lines.includes('Attachments: Q4.pdf'))
  assert.ok(!/alert\(1\)|<p|onclick/.test(text))
  // An HTML-only message reads as text.
  const html = '<p>Hello <b>there</b></p><ul><li>a</li></ul><script>x()</script>'
  const only = readableText({ subject: 's', messages: [{ id: 'h', internalDate: '1', payload: { mimeType: 'text/html', headers: [], body: { data: b64(html) } } }] })
  assert.match(only, /Hello there\n\n- a$/)
})

test('discussPrompt: starts with "About the mail", never with a character the send gate refuses, capped', () => {
  const p = discussPrompt('/clear everything', '!rm', 'body')
  assert.match(p, /^About the mail "\/clear everything" from !rm\n\nThe thread as it is now \(a read-only copy/)
  assert.ok(discussPrompt('s', 'a', 'x'.repeat(50000)).length <= PROMPT_MAX)
  assert.match(discussPrompt('', '', ''), /^About the mail "\(no subject\)" from unknown/)
})

// ---- the mail layout (0.6.0, a reviewer with the 'mail' feature) ----

function mailMsg(id, o) {
  const html = o.html || '<p>Hi</p>'
  const headers = [{ name: 'From', value: o.from || 'Ann Example <ann@example.com>' }, { name: 'To', value: o.to || 'Me <me@example.com>, Bob Example <bob@example.com>' }, { name: 'Subject', value: o.subject || 'Hello' }]
  if (o.cc) headers.push({ name: 'Cc', value: o.cc })
  return { id, internalDate: String(o.at || 0), labelIds: o.unread ? ['UNREAD', 'INBOX'] : ['INBOX'], payload: { mimeType: 'text/html', headers, body: { size: html.length, data: b64(html) } } }
}

test('mail layout: the subject first, then each message with avatar, sender line, "to …", time and Unread chip; no aside', () => {
  const at = Date.UTC(2026, 10, 6, 14, 9)
  const d = threadDocument({ title: 'Your order', mail: true, now: at + 60000, aside: false, messages: [mailMsg('m1', { at, unread: true, cc: 'Carol Example <carol@example.com>' })] })
  assertReviewerSafe(d.html)
  assert.match(d.html, /^<h1>Your order<\/h1>\n<div class="mail-msg"><div class="mail-head"><div class="mail-avatar">AE<\/div><div class="mail-who"><div class="mail-from"><span class="mail-name">Ann Example<\/span><span class="mail-addr">ann@example\.com<\/span><\/div><div class="mail-to">to Me, Bob Example · cc Carol Example<\/div><\/div><div class="mail-when">Today \d\d:\d\d<br><span class="mail-chip">Unread<\/span><\/div><\/div>/)
  assert.match(d.html, /<div class="mail-body"><p>Hi<\/p><\/div><\/div>$/)
  assert.doesNotMatch(d.html, /class="card/, 'no cards, no tint')
  assert.equal(d.aside, undefined)
  assert.deepEqual([initials('Ann Example', 'ann@example.com'), initials('Example (Jira)', 'x@example.com'), initials('', 'zed@example.com')], ['AE', 'E', 'Z'])
  assert.match(when(at, at + 1000), /^Today /)
  assert.doesNotMatch(when(at, at + 3 * 86400000), /^Today/)
})

test('mail layout: remote pictures are placeholders; the bar counts the ones not shown and offers the buttons when asked', () => {
  const html = '<p>Sale</p><img src="https://cdn.example.com/hero.png" alt="Hero" width="600"><img src="https://cdn.example.com/two.png" alt="Two" width="600"><img src="https://cdn.example.com/logo.png" alt="Example Co">'
  const msgs = [mailMsg('m1', { html })]
  const plain = threadDocument({ title: 's', mail: true, messages: msgs })
  assertReviewerSafe(plain.html)
  assert.equal(plain.remoteImages, 2, 'the logo is not counted: it is hidden either way')
  assert.equal(plain.remote.length, 3)
  assert.deepEqual(plain.remote.map((r) => [r.messageId, r.address]), [['m1', 'ann@example.com'], ['m1', 'ann@example.com'], ['m1', 'ann@example.com']])
  assert.match(plain.html, /<div class="mail-images-bar" data-part="images-bar"><span class="mail-images-text">2 remote images are not shown \(senders can track when you open mail\)\.<\/span><\/div>/)
  const asked = threadDocument({ title: 's', mail: true, messages: msgs, images: { actions: true, address: 'ann@example.com' } })
  assertReviewerSafe(asked.html)
  assert.match(asked.html, /<span data-action="show-images">Show images<\/span> <span data-action="always-sender" title="Always show the pictures of mail from ann@example\.com">Always show from ann@example\.com<\/span><\/div>/)
  // The ones the host loaded are not counted; none left, no bar.
  const hero = remoteAssetId('https://cdn.example.com/hero.png')
  const two = remoteAssetId('https://cdn.example.com/two.png')
  assert.equal(threadDocument({ title: 's', mail: true, messages: msgs, remote: { loaded: (id) => id === hero } }).remoteImages, 1)
  assert.doesNotMatch(threadDocument({ title: 's', mail: true, messages: msgs, remote: { loaded: (id) => id === hero || id === two } }).html, /mail-images-bar/)
  assert.equal(imagesBar(1, {}).includes('1 remote image is not shown'), true)
})

test('mail layout: the related Jira card under the subject, from the mail\'s words or from the Jira service', () => {
  // From the mail alone (no lookup answered): the subject's summary and the status move.
  const change = J.statusChange('Ann Example changed the status\nStatus: Backlog → Ready to Test\n')
  assert.deepEqual(change, { from: 'Backlog', to: 'Ready to Test' })
  const fromMail = J.relatedCard({ key: 'ABC-1', url: 'https://jira.example.com/browse/ABC-1', issue: null, change, subject: '[JIRA] (ABC-1) Checkout fails', esc })
  assert.equal(fromMail, '<div class="mail-related"><span class="mail-badge">JIRA</span><div class="mail-related-main"><div class="mail-related-title" title="ABC-1 Checkout fails">ABC-1 · Checkout fails</div><div class="mail-related-meta">Backlog <span class="mail-arrow">→</span> <span class="mail-status-to">Ready to Test</span></div></div><a class="mail-related-open" href="https://jira.example.com/browse/ABC-1">Open in Jira</a></div>')
  // From the service: its summary, status, type and assignee; a later move shows as "now …".
  const issue = { summary: 'Checkout fails on Safari', status: 'In Progress', type: 'Bug', assignee: 'Ann Example', mine: true }
  const fromJira = J.relatedCard({ key: 'ABC-1', url: 'https://jira.example.com/browse/ABC-1', issue, change: null, subject: 'x', esc })
  assert.match(fromJira, /ABC-1 · Checkout fails on Safari<\/div><div class="mail-related-meta">In Progress · Bug · Ann Example \(you\)<\/div>/)
  assert.match(J.relatedCard({ key: 'ABC-1', issue, change, esc }), /Ready to Test<\/span> · now In Progress · Bug/)
  assert.doesNotMatch(J.relatedCard({ key: 'ABC-1', url: 'javascript:alert(1)', esc }), /href/, 'https links only')
  assert.equal(J.statusChange('no move here'), null)
  assert.equal(J.statusChange('Status: Done → Done'), null)
  assert.equal(J.summaryFromSubject('Re: [JIRA] (ABC-1) Checkout fails', 'ABC-1'), 'Checkout fails')
  const d = threadDocument({ title: 'ABC-1', mail: true, related: fromMail, note: 'a note', messages: [mailMsg('m1', {})] })
  assertReviewerSafe(d.html)
  assert.match(d.html, /^<h1>ABC-1<\/h1>\n<div class="mail-related">.*<\/div>\n<p class="mail-note"><em>a note<\/em><\/p>\n<div class="mail-msg">/)
})
