'use strict'
// The mail HTML sanitizer: whatever a sender writes, the output holds only the tags the reviewer
// keeps, with only href / title / alt / data-asset / colspan / rowspan, and links only to http(s)
// and mailto. `assertClean` checks that with its own regexes (not the sanitizer's tokenizer, which
// would check itself), and a seeded fuzz throws tag soup at it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitizeHtml, htmlToText, textToHtml, linkify, safeHref, cidKey, tokenize, parse, isLayoutTable, ALLOWED, MAX_INPUT } = require('../dist/lib/sanitize')

const ATTRS = {
  a: new Set(['href', 'title']),
  img: new Set(['data-asset', 'alt', 'title']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  div: new Set(['title']),
  span: new Set(['title']),
  p: new Set(['title']),
}
const VOIDS = new Set(['br', 'hr', 'img'])
const TAG = /<(\/?)([a-z][a-z0-9]*)((?: [a-z-]+="[^"<>]*")*)>/g

/** The output is only allowed tags with allowed attributes, balanced, and no other `<` or `>`. */
function assertClean(html, label = '') {
  const stack = []
  const rest = html.replace(TAG, (m, close, name, attrs) => {
    assert.ok(ALLOWED.has(name), `${label}: tag <${name}> in ${html.slice(0, 300)}`)
    if (close) {
      assert.equal(stack.pop(), name, `${label}: unbalanced </${name}> in ${html.slice(0, 300)}`)
      return ''
    }
    for (const [, k, v] of attrs.matchAll(/ ([a-z-]+)="([^"]*)"/g)) {
      assert.ok(ATTRS[name] && ATTRS[name].has(k), `${label}: attribute ${k} on <${name}>`)
      if (k === 'href') assert.match(v, /^(https?:\/\/|mailto:)/, `${label}: href ${v}`)
      if (k === 'href') assert.ok(!/[\x00-\x20]/.test(v), `${label}: control or space in href`)
      if (k === 'colspan' || k === 'rowspan') assert.match(v, /^\d+$/)
      if (k === 'data-asset') assert.match(v, /^[A-Za-z0-9._-]{1,100}$/)
    }
    if (!VOIDS.has(name)) stack.push(name)
    return ''
  })
  assert.ok(!/[<>]/.test(rest), `${label}: a raw < or > outside a tag: ${JSON.stringify(rest.slice(0, 200))}`)
  assert.deepEqual(stack, [], `${label}: unclosed ${stack}`)
}

const clean = (html, o) => {
  const r = sanitizeHtml(html, o)
  assertClean(r.html, html.slice(0, 60))
  return r.html
}

test('scripts, styles and active containers go with their content', () => {
  assert.equal(clean('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>')
  assert.equal(clean('<style>p{color:red}</style><p>x</p>'), '<p>x</p>')
  assert.equal(clean('<style><p>not a paragraph</p></style>ok'), 'ok')
  assert.equal(clean('<svg><script>alert(1)</script><text>t</text></svg>after'), 'after')
  assert.equal(clean('<math><mi>x</mi></math>after'), 'after')
  assert.equal(clean('<iframe srcdoc="<script>alert(1)</script>"></iframe>ok'), 'ok')
  assert.equal(clean('<object data="x.swf"><embed src="x.swf"></object>ok'), 'ok')
  assert.equal(clean('<form action="https://evil"><input name="pw"><button>Go</button></form>ok'), 'ok')
  assert.equal(clean('<template><p>t</p></template>ok'), 'ok')
  assert.equal(clean('<select><option>one<option>two</select>ok'), 'ok')
  assert.equal(clean('<video src="v.mp4"><track src="t.vtt"></video>ok'), 'ok')
})

test('event handlers, styles, classes, ids and unknown attributes are dropped', () => {
  assert.equal(clean('<p onclick="alert(1)" style="color:red" class="x" id="y" data-x="1">t</p>'), '<p>t</p>')
  assert.equal(clean('<div onmouseover=alert(1)>t</div>'), '<div>t</div>')
  assert.equal(clean('<a href="https://x.org" onclick="steal()" target="_blank" rel="opener">x</a>'), '<a href="https://x.org/">x</a>')
  assert.equal(clean('<span title="a &quot;b&quot; <c>">t</span>'), '<span title="a &quot;b&quot; &lt;c&gt;">t</span>')
})

test('links keep only absolute http(s) and mailto addresses', () => {
  for (const href of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java&#x09;script:alert(1)', 'jav&#97;script:alert(1)', '&#106;avascript:alert(1)', 'vbscript:x', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', '/relative', '#top', '//evil.example/x', 'https://user:pass@x.org/', 'cid:abc']) {
    assert.equal(clean(`<a href="${href.replace(/"/g, '&quot;')}">t</a>`), 't', href)
  }
  assert.equal(clean('<a href="mailto:ann@acme.com">mail</a>'), '<a href="mailto:ann@acme.com">mail</a>')
  assert.equal(clean('<a href="HTTPS://Acme.com/a b">x</a>'), '<a href="https://acme.com/a%20b">x</a>')
  assert.equal(clean(`<a href="https://x.org/${'a'.repeat(3000)}">t</a>`), 't', 'an over-long href')
  assert.equal(clean('<a href="https://x.org/\u0000y">t</a>'), '<a href="https://x.org/%EF%BF%BDy">t</a>', 'NUL is U+FFFD before the href is read')
  assert.equal(clean('<a href="https://x.org"></a>'), '', 'an empty link is nothing')
  assert.equal(clean('<a href="https://a.org">a <a href="https://b.org">b</a></a>'), '<a href="https://a.org/">a </a><a href="https://b.org/">b</a>')
})

test('safeHref and cidKey', () => {
  assert.equal(safeHref('https://x.org'), 'https://x.org/')
  assert.equal(safeHref('http://x.org/a?b=1#c'), 'http://x.org/a?b=1#c')
  assert.equal(safeHref('mailto:a@b.c?subject=hi'), 'mailto:a@b.c?subject=hi')
  for (const v of [null, undefined, 1, '', ' ', 'javascript:x', 'ftp://x.org', 'https://a\nb.org', 'https://u@x.org', 'not a url']) assert.equal(safeHref(v), null, String(v))
  assert.equal(cidKey('<Logo@Acme>'), 'logo@acme')
  assert.equal(cidKey('logo%40acme'), 'logo@acme')
  assert.equal(cidKey('bad%zz'), 'bad%zz')
  assert.equal(cidKey(''), null)
  assert.equal(cidKey('x'.repeat(501)), null)
})

test('comments, doctype, CDATA and conditional comments produce nothing', () => {
  assert.equal(clean('<!DOCTYPE html><!-- c --><p>a</p>'), '<p>a</p>')
  assert.equal(clean('<!--[if mso]><table><tr><td>mso</td></tr></table><![endif]--><p>a</p>'), '<p>a</p>')
  assert.equal(clean('<!-->ok'), 'ok')
  assert.equal(clean('<!--->ok'), 'ok')
  assert.equal(clean('<!-- a --!><p>b</p>'), '<p>b</p>')
  // Outside SVG, CDATA is a bogus comment up to the first `>`: the rest is text, as in a browser.
  assert.equal(clean('<![CDATA[<script>alert(1)</script>]]>ok'), 'alert(1)]]&gt;ok')
  assert.equal(clean('<?xml version="1.0"?>ok'), 'ok')
  assert.equal(clean('<!-- never closed <p>x</p>'), '')
})

test('mutation-XSS shapes come out inert', () => {
  const cases = [
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<style><img src=x onerror=alert(1)></style>',
    '<title><img src=x onerror=alert(1)></title>',
    '<textarea><img src=x onerror=alert(1)></textarea>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<svg><p><style><img src=x onerror=alert(1)></style></p></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<a href="javas\x00cript:alert(1)">x</a>',
    '<img src="x" alt="&quot;><script>alert(1)</script>">',
    '<img """><script>alert(1)</script>">',
    '<p <img src=x onerror=alert(1)>>t</p>',
    '<</p>script>alert(1)<//script>',
    '<a href=https://x.org/"onmouseover="alert(1)">x</a>',
    '<div title=`x`onclick=alert(1)>t</div>',
    '<img/src="x"/onerror="alert(1)">',
    '<plaintext><script>alert(1)</script>',
    '<iframe><p>x</iframe>',
    '<base href="javascript:/"><a href="/x">x</a>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">ok',
    '<link rel="stylesheet" href="https://evil/x.css">ok',
    '<details open ontoggle=alert(1)><summary>s</summary>d</details>',
    '<table background="javascript:alert(1)"><tr><td background="x">c</td><td>d</td></tr></table>',
  ]
  for (const c of cases) {
    const out = clean(c)
    assert.ok(!/<img(?! data-asset)/.test(out), c)
    // assertClean has checked every attribute; text may say "onerror" (escaped), a tag may not hold a script.
    assert.ok(!/<(script|style|iframe|svg|math|meta|base|link|noscript|xmp|textarea|title)\b/i.test(out), `${c} -> ${out}`)
    assert.ok(!/<[^>]*javascript:/i.test(out), `${c} -> ${out}`)
  }
})

test('text is escaped once: references decoded on the way in, escaped on the way out', () => {
  assert.equal(clean('&lt;script&gt;alert(1)&lt;/script&gt;'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(clean('<p>Tom &amp; Jerry &copy; &#8364; &#x1F600; &bogus;</p>'), '<p>Tom &amp; Jerry © € 😀 &amp;bogus;</p>')
  assert.equal(clean('a\u0000b'), 'a�b')
  assert.equal(clean('<p>&#0;&#xD800;&#x110000;</p>'), '<p>���</p>')
  assert.equal(clean('<p>&#150;</p>'), '<p>–</p>', 'C1 references are windows-1252, as browsers do')
})

test('renamed and unwrapped tags keep their meaning or just their text', () => {
  assert.equal(clean('<b>b</b><i>i</i><strike>s</strike><tt>c</tt><center>c</center>'), '<strong>b</strong><em>i</em><s>s</s><code>c</code><div>c</div>')
  assert.equal(clean('<html><body><font face="x" color="red">t</font><o:p>u</o:p><blink>v</blink></body></html>'), 'tuv')
  assert.equal(clean('<h1>Big</h1><h3>Small</h3><h6>Tiny</h6>'), '<h3>Big</h3><h5>Small</h5><h6>Tiny</h6>', 'headings sit under the message card')
  assert.equal(clean('<h1>Big</h1>', { headingShift: 0 }), '<h1>Big</h1>')
  assert.equal(clean('<pre>  a\n  b</pre>'), '<pre>  a\n  b</pre>')
})

test('hidden content and spacers are left out', () => {
  assert.equal(clean('<div style="display:none">preheader</div><p>body</p>'), '<p>body</p>')
  assert.equal(clean('<span style="DISPLAY: NONE !important">x</span>y'), 'y')
  assert.equal(clean('<div style="visibility:hidden">x</div>y'), 'y')
  assert.equal(clean('<div style="max-height:0;overflow:hidden">x</div>y'), 'y')
  assert.equal(clean('<p hidden>x</p>y'), 'y')
  assert.equal(clean('<div style="display:&#110;one">x</div>y'), 'y', 'a reference in the style is decoded first')
  assert.equal(clean('<div><span></span><p> </p></div><p>x</p>'), '<p>x</p>')
})

test('images: an inline part is an asset, a remote picture a link, a tracking pixel nothing', () => {
  const cid = (k) => (k === 'logo@acme' ? 'img0123456789abcdef' : null)
  const r = sanitizeHtml('<img src="cid:Logo@Acme" alt="Acme"><img src="cid:other"> <img src="https://cdn.x.org/a.png" alt="Banner"><img src="https://t.x.org/o.gif" width="1" height="1"><img src="https://t.x.org/p.gif" style="width:1px;height:1px">', { cid })
  assertClean(r.html)
  assert.equal(r.html, '<img data-asset="img0123456789abcdef" alt="Acme" title="Acme">[image] <a href="https://cdn.x.org/a.png">[image: Banner]</a>')
  assert.deepEqual([...r.usedCids], ['logo@acme'])
  assert.equal(r.remoteImages, 1)
  assert.equal(clean('<a href="https://x.org"><img src="https://x.org/i.png" alt="Shop"></a>'), '<a href="https://x.org/">[image: Shop]</a>', 'no link in a link')
  assert.equal(clean('<img src="data:image/png;base64,AAAA" alt="d">'), '[image: d]')
  assert.equal(clean('<img src="javascript:alert(1)">'), '')
  // A caller handing back a strange asset id does not get it into an attribute.
  assert.equal(clean('<img src="cid:x" alt="a">', { cid: () => '" onerror="x' }), '[image: a]')
})

test('quoted history folds into details: Gmail, Yahoo, Proton, Apple, Outlook', () => {
  assert.equal(clean('<div>New</div><div class="gmail_quote"><div>On Mon, Ann wrote:</div><blockquote class="gmail_quote">old</blockquote></div>'), '<div>New</div><details><summary>Quoted text</summary><div>On Mon, Ann wrote:</div><blockquote>old</blockquote></details>')
  assert.match(clean('<p>n</p><div class="yahoo_quoted">old</div>'), /<details><summary>Quoted text<\/summary>old<\/details>$/)
  assert.match(clean('<p>n</p><div class="protonmail_quote">old</div>'), /<details>/)
  assert.match(clean('<p>n</p><blockquote type="cite">old</blockquote>'), /<details><summary>Quoted text<\/summary><blockquote>old<\/blockquote><\/details>/)
  const outlook = clean('<div><p>Reply</p><hr><div id="divRplyFwdMsg"><b>From:</b> Ann</div><div>old body</div></div>')
  assert.equal(outlook, '<div><p>Reply</p><details><summary>Quoted text</summary><hr><div><strong>From:</strong> Ann</div><div>old body</div></details></div>')
  assert.equal(clean('<p>n</p><div class="gmail_quote"> </div>'), '<p>n</p>', 'an empty quote is nothing')
  assert.equal((clean('<div class="gmail_quote"><div class="gmail_quote">x</div></div>').match(/<details>/g) || []).length, 1, 'never folded twice')
})

test('layout tables unwrap into blocks, data tables stay tables', () => {
  assert.equal(clean('<table role="presentation"><tr><td>a</td><td>b</td></tr></table>'), '<div>a</div><div>b</div>')
  assert.equal(clean('<table><tr><td>only one column</td></tr><tr><td>x</td></tr></table>'), '<div>only one column</div><div>x</div>')
  assert.equal(clean('<table><tr><td><table><tr><td>a</td><td>b</td></tr></table></td><td>c</td></tr></table>'), '<div><table><tr><td>a</td><td>b</td></tr></table></div><div>c</div>', 'the outer table (it nests one) is layout, the inner one data')
  assert.equal(clean('<table><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody><tr><td colspan="2" rowspan="x">Total</td></tr></tbody><tfoot><tr><td>a</td><td>b</td></tr></tfoot></table>'), '<table><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody><tr><td colspan="2">Total</td></tr></tbody><tbody><tr><td>a</td><td>b</td></tr></tbody></table>')
  assert.equal(clean('<table><tr><td colspan="99999">a</td><td>b</td></tr></table>'), '<table><tr><td>a</td><td>b</td></tr></table>')
  assert.equal(isLayoutTable(parse('<table role="none"><tr><td>a</td><td>b</td></tr></table>').root.children[0]), true)
})

test('broken markup still comes out balanced', () => {
  assert.equal(clean('<div><p>a<p>b</div>c'), '<div><p>a</p><p>b</p></div>c')
  assert.equal(clean('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(clean('<dl><dt>a<dd>b<dt>c</dl>'), '<dl><dt>a</dt><dd>b</dd><dt>c</dt></dl>')
  assert.equal(clean('<b><i>x</b>y</i>'), '<strong><em>x</em></strong>y')
  assert.equal(clean('</div></p></table>text'), 'text')
  assert.equal(clean('<table><tr><td>a</div></td><td>b</td></tr></table>'), '<table><tr><td>a</td><td>b</td></tr></table>', 'a stray end tag does not leave the cell')
  assert.equal(clean('<head><title>T</title><p>body after an unclosed head'), '<p>body after an unclosed head</p>')
  assert.equal(clean('<p>unclosed <a href="https://x.org">link'), '<p>unclosed <a href="https://x.org/">link</a></p>')
  assert.equal(clean('<p>tag cut <a href="https://x'), '<p>tag cut </p>')
  assert.equal(clean('a < b and c > d'), 'a &lt; b and c &gt; d')
  assert.equal(clean('<option>kept text</option> after'), 'kept text after')
})

test('deep nesting and huge input are cut, not crashed on', () => {
  const deep = '<div>'.repeat(5000) + 'core' + '</div>'.repeat(5000)
  const out = clean(deep)
  assert.ok(out.length < deep.length)
  const big = '<p>' + 'x'.repeat(MAX_INPUT + 10) + '</p>'
  const r = sanitizeHtml(big)
  assert.equal(r.truncated, true)
  assertClean(r.html)
  assert.match(r.html, /too long to show in full/)
  const many = '<span>a</span>'.repeat(120000)
  const m = sanitizeHtml(many)
  assertClean(m.html)
  assert.equal(m.truncated, true)
})

test('a title attribute is kept, decoded, cut to 300', () => {
  const out = clean(`<span title="${'t'.repeat(500)}">x</span>`)
  assert.equal(out, `<span title="${'t'.repeat(300)}">x</span>`)
})

test('the tokenizer is linear and drops a tag cut by the end of the input', () => {
  assert.deepEqual(tokenize('<p a="1" b=2 c>t</p>').map((t) => t.type), ['start', 'text', 'end'])
  assert.deepEqual([...tokenize('<p a="1" b=2 c>')[0].attrs.entries()], [['a', '1'], ['b', '2'], ['c', '']])
  assert.deepEqual(tokenize('text <p class="x'), [{ type: 'text', text: 'text ' }])
  const t0 = Date.now()
  tokenize('<a '.repeat(200000))
  tokenize('<!--'.repeat(200000))
  tokenize('<p x="'.repeat(100000))
  assert.ok(Date.now() - t0 < 3000, 'no quadratic blow-up')
})

// A deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

test('fuzz: tag soup from hostile fragments always comes out clean', () => {
  const frags = [
    '<', '>', '</', '/>', '"', "'", '=', ' ', '\n', '\u0000', '&', '&#', '&#x', ';', '&lt;', '&quot;', '<!--', '-->', '--!>', '<!', '<?', ']]>',
    '<script>', '</script>', '<style>', '</style>', '<svg>', '<math>', '<iframe>', '<noscript>', '</noscript>', '<title>', '<textarea>', '<plaintext>',
    '<img src=x onerror=alert(1)>', '<img src="cid:a">', '<img src="https://x.org/a.png" width=1>', '<a href="javascript:alert(1)">', '<a href="https://x.org">', '</a>',
    '<a href=" java\tscript:x">', '<a href="&#106;avascript:x">', '<div style="display:none">', '<div class="gmail_quote">', '<blockquote type=cite>', '<div id="divRplyFwdMsg">',
    '<table>', '</table>', '<tr>', '<td colspan=3>', '</td>', '<th>', '<p>', '</p>', '<ul>', '<li>', '<dl>', '<dt>', '<dd>', '<b>', '</i>', '<h1>', '</h2>',
    '<pre>', '<head>', '<body>', '<option>', '<select>', '<form>', '<input>', '<details>', '<summary>', '<span title="', 'onclick=', 'style=', 'text', 'é', '😀',
  ]
  const rand = rng(20261103)
  const cid = (k) => (k === 'a' ? 'img00aa' : null)
  for (let n = 0; n < 3000; n++) {
    let s = ''
    const len = 1 + Math.floor(rand() * 40)
    for (let k = 0; k < len; k++) s += frags[Math.floor(rand() * frags.length)]
    const r = sanitizeHtml(s, { cid })
    assertClean(r.html, `fuzz #${n} ${JSON.stringify(s)}`)
    assert.ok(!/<img(?! data-asset="img00aa")/.test(r.html), `fuzz #${n}: an img that is not the asset`)
  }
})

test('htmlToText: blocks on lines, list items with "- ", links as text <url>, quotes marked', () => {
  const html = '<div>Hi <b>Ann</b>,</div><ul><li>one</li><li>two</li></ul><p>See <a href="https://x.org/deck">the deck</a> or <a href="https://y.org">https://y.org</a>.</p><img src="x" alt="pic"><div style="display:none">hidden</div><div class="gmail_quote">old</div><script>alert(1)</script>'
  assert.equal(htmlToText(html), 'Hi Ann,\n\n- one\n- two\n\nSee the deck <https://x.org/deck> or https://y.org.\n\n[quoted]\nold')
  assert.equal(htmlToText('<table><tr><td>a</td><td>b</td></tr></table>'), 'a b')
  assert.equal(htmlToText('a&nbsp;&amp;&nbsp;b<br>c'), 'a & b\nc')
  assert.equal(htmlToText('<a href="javascript:x">click</a>'), 'click')
})

test('textToHtml: escaped paragraphs, links, the trailing quote folded under its attribution', () => {
  assert.equal(textToHtml('Hi <Ann> & co\nline two\n\nSee https://x.org/a, ok'), '<p>Hi &lt;Ann&gt; &amp; co<br>line two</p>\n<p>See <a href="https://x.org/a">https://x.org/a</a>, ok</p>')
  const quoted = textToHtml('Sure.\n\nOn Mon, 2 Nov 2026, Ann <ann@acme.com>\nwrote:\n> old line\n> more\n')
  assert.equal(quoted, '<p>Sure.</p>\n<details><summary>Quoted text</summary><p>On Mon, 2 Nov 2026, Ann &lt;ann@acme.com&gt;<br>wrote:</p><blockquote><p>old line<br>more</p></blockquote></details>')
  assert.match(textToHtml('New\n-----Original Message-----\nFrom: Ann\nold'), /^<p>New<\/p>\n<details><summary>Quoted text<\/summary><p>-----Original Message-----<\/p><blockquote><p>From: Ann<br>old<\/p><\/blockquote><\/details>$/)
  assert.equal(textToHtml('> only a quote'), '<p>&gt; only a quote</p>', 'nothing above it: not folded')
  assert.equal(textToHtml(''), '')
  assert.equal(textToHtml(null), '')
  assertClean(textToHtml('<script>x</script> javascript:alert(1) https://a.org/"onmouseover="x'))
})

test('linkify makes only http(s) links and stops at trailing punctuation', () => {
  assert.equal(linkify('go to https://x.org/a.'), 'go to <a href="https://x.org/a">https://x.org/a</a>.')
  assert.equal(linkify('(https://x.org/a) and javascript:alert(1)'), '(<a href="https://x.org/a">https://x.org/a</a>) and javascript:alert(1)')
  assert.equal(linkify('https://u:p@x.org/a'), 'https://u:p@x.org/a')
})
