'use strict'
// The manifest's settings rules (the app's validate.ts refuses the plugin otherwise) and source
// checks the design asks for: no npm dependency, no exec, one write (the UNREAD label), the token's hosts.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const sources = () => {
  const out = []
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (n.name.endsWith('.js')) out.push(p)
    }
  }
  walk(path.join(ROOT, 'dist'))
  walk(path.join(ROOT, 'panels'))
  return out
}

test('the manifest: id, api, entry points and files exist', () => {
  assert.equal(manifest.id, 'bronos.gmail')
  assert.equal(manifest.api, 1)
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)))
  for (const p of manifest.contributes.panels) {
    assert.ok(fs.existsSync(path.join(ROOT, p.entry)))
    assert.ok(fs.existsSync(path.join(ROOT, p.icon)))
  }
  assert.deepEqual(manifest.services.uses, { triage: 1, reviewer: 1, jira: 1 })
  assert.deepEqual(manifest.services.provides, { 'inbox-feed': 2 })
  assert.equal(manifest.version, '0.5.0')
  assert.equal(manifest.contributes.cli[0].name, 'gmail')
})

test('the settings schema: no regex anywhere; the secret field top-level, no default, only allowed keywords', () => {
  const schema = manifest.contributes.settings.project
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!['pattern', 'patternProperties', '$ref', '$anchor', '$id', '$dynamicRef'].includes(k), `${at}.${k}`)
      if (k === 'format') assert.equal(at, 'project.properties.clientSecret', `format only on the secret (${at})`)
      walk(v, `${at}.${k}`)
    }
  }
  walk(schema, 'project')
  const secret = schema.properties.clientSecret
  assert.equal(secret.type, 'string')
  assert.equal(secret.format, 'secret')
  assert.ok(!('default' in secret))
  assert.deepEqual(Object.keys(secret).filter((k) => !['type', 'format', 'title', 'description', '$comment'].includes(k)), [])
})

test('no npm dependency: every require is node: or relative', () => {
  for (const f of sources()) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [, mod] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.ok(mod.startsWith('node:') || mod.startsWith('./') || mod.startsWith('../'), `${path.relative(ROOT, f)} requires ${mod}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.scripts, { test: 'node --test test/' })
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})

test('one write and no exec: the only non-GET is http.setThreadUnread (threads.modify, UNREAD only); no other Gmail write endpoint, no ctx.exec, no child_process', () => {
  const writes = []
  for (const f of sources()) {
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const rel = path.relative(ROOT, f)
    assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(src), `${rel}: a write method`)
    for (const m of src.matchAll(/['"](POST|PUT|PATCH|DELETE)['"]/g)) writes.push(`${rel}:${m[1]}`)
    for (const m of src.matchAll(/\/(modify|batchModify|trash|untrash|send|drafts|import|insert)\b['"`]/g)) writes.push(`${rel}:/${m[1]}`)
    assert.ok(!/(add|remove)LabelIds\s*:\s*\[\s*(?!UNREAD\b)/.test(src), `${rel}: a label list other than [UNREAD]`)
    assert.ok(!/ctx\.exec\b|child_process/.test(src), `${rel}: exec`)
  }
  assert.deepEqual(writes.sort(), ['dist/lib/http.js:/modify', 'dist/lib/http.js:POST'])
  // The label lists are built in one place, from a boolean.
  const http = fs.readFileSync(path.join(ROOT, 'dist/lib/http.js'), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')
  assert.equal((http.match(/(add|remove)LabelIds/g) || []).length, 2)
  assert.match(http, /const UNREAD = 'UNREAD'/)
})

test('the only network hosts in the code are Google\'s', () => {
  const allowed = new Set(['gmail.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'mail.google.com', 'console.cloud.google.com', 'myaccount.google.com', 'github.com'])
  for (const f of sources()) {
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')
    for (const [, host] of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.ok(allowed.has(host.toLowerCase()), `${path.relative(ROOT, f)}: ${host}`)
  }
})
