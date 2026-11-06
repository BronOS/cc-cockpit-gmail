'use strict'
// Which view a mail opens in, in the reviewer (0.6.0, its feature 'original'): Original (the mail as
// its sender made it, in a sandboxed frame) or Reader (the clean reading layout). The person's last
// choice per sender address is kept app-wide (ctx.appStorage, VIEWS_KEY: every window and project
// sees it, as with the always-show senders), and the app setting `defaultView` covers a sender with
// no choice yet. The reviewer tells a switch as its service event `view` { key, view, caller }.
// Pure, so node:test checks it; the host reads and writes the store.

const VIEWS = ['original', 'reader']
const VIEWS_KEY = 'viewBySender'
const MAX_VIEW_SENDERS = 500 // the oldest choice goes first past it
const ADDRESS = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,253}$/

/** The stored choices as `[[address, view]]`, oldest first: lower-case addresses, each once, known views only. */
function cleanViews(raw) {
  const out = new Map()
  for (const pair of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const a = typeof pair[0] === 'string' ? pair[0].trim().toLowerCase() : ''
    if (!ADDRESS.test(a) || !VIEWS.includes(pair[1])) continue
    out.delete(a)
    out.set(a, pair[1])
  }
  return [...out].slice(-MAX_VIEW_SENDERS)
}

/** The view a mail from `address` opens in: the person's choice for it, else the setting's default. */
function viewFor(stored, address, dflt = 'original') {
  const a = String(address || '').toLowerCase()
  const hit = a ? stored.find(([x]) => x === a) : null
  if (hit) return hit[1]
  return dflt === 'reader' ? 'reader' : 'original'
}

/** The list with `address`'s choice set (moved to the newest end), bounded; the same list for a bad input. */
function chooseView(stored, address, view) {
  const a = String(address || '').trim().toLowerCase()
  if (!ADDRESS.test(a) || !VIEWS.includes(view)) return stored
  return cleanViews([...stored.filter(([x]) => x !== a), [a, view]])
}

module.exports = { cleanViews, viewFor, chooseView, VIEWS, VIEWS_KEY, MAX_VIEW_SENDERS }
