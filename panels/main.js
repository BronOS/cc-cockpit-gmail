'use strict'
// The Gmail panel: the setup guide while not signed in, else the lanes of threads as the host sends
// them (`{ type: 'state', ... }`); actions are posted back as `{ type, id }`. The page keeps no data
// of its own (an opaque origin has no storage) except which row's triage chooser is open and the
// text in the paste box. Every text from a mail goes in through textContent, never as markup: a
// subject or a sender name is untrusted.
//
// A click on a row (or Enter on a focused row) opens the thread; the other actions are small
// buttons shown on hover or focus (rowlogic.js, loaded before this file, decides which).

let state = null
let wrongOpen = null // the id whose triage chooser is shown
let savePending = false // the paste box is cleared once the host took the client

const $ = (id) => document.getElementById(id)

function el(tag, props, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'onclick') n.addEventListener('click', v)
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c) n.append(c)
  return n
}

function button(label, onclick, title, cls) {
  return el('button', { type: 'button', title, class: cls, onclick: (ev) => { ev.stopPropagation(); onclick() } }, label)
}

const post = (type, extra) => ccPanel.post({ type, ...extra })

function notice(text, kind, extra) {
  const box = el('div', { class: `notice ${kind || ''}` })
  const body = el('div', { class: 'text' })
  body.textContent = text
  if (extra) body.append(extra)
  box.append(body)
  return box
}

// The paste box lives across redraws (every state message rebuilds the page): a redraw must not
// throw away what the person pasted, nor the focus.
const pasteBox = el('textarea', { id: 'paste', spellcheck: 'false', 'aria-label': 'Paste the client file', placeholder: '{"installed":{"client_id":"…apps.googleusercontent.com","client_secret":"…", …}}' })

function renderNotices() {
  const box = $('notices')
  box.replaceChildren()
  if (state.tooOld) {
    box.append(notice(state.tooOld))
    return
  }
  if (state.choose) {
    const tabs = el('div', { class: 'tabs' })
    for (const t of state.choose.tabs) tabs.append(button(t.label, () => post('discuss', { id: state.choose.id, tabId: t.tabId }), `status: ${t.status}`))
    tabs.append(button('Cancel', () => post('dismiss')))
    box.append(notice(`Discuss ${state.choose.label} in which Claude tab?`, 'info', tabs))
  }
  if (state.notice) {
    const n = notice(state.notice.text, state.notice.kind === 'error' ? '' : 'info')
    n.append(button('✕', () => post('dismiss'), 'Dismiss'))
    box.append(n)
  }
  if (!state.auth || !state.auth.signedIn) return
  if (state.write && state.write.prompt) box.append(scopePrompt())
  if (state.error) box.append(notice(state.error))
  for (const [lane, msg] of Object.entries(state.laneErrors || {})) box.append(notice(`${lane}: ${msg}`))
  for (const p of state.problems || []) box.append(notice(p, 'info'))
  if (!state.triage.on) box.append(notice('Triage is off: the lanes are not sorted. Install and enable Jev triage (bronos.jev-triage) in this project.', 'info'))
  else if (state.triage.error) box.append(notice(`Triage: ${state.triage.error}`))
}

/**
 * A sign-in that only reads (from before 0.3.0, or the Gmail box unticked at Google): reading goes on;
 * this asks to sign in again so Mark read works. "Not now" hides it for this run (a Mark read press
 * shows it again).
 */
function scopePrompt() {
  const row = el('div', { class: 'tabs' })
  if (state.auth.signingIn) {
    row.append(el('span', { class: 'muted', text: 'Waiting for the browser…' }))
    row.append(button('Start over', () => post('signIn'), 'Cancels the open sign-in and opens a new one in your browser', 'link'))
  } else {
    row.append(button('Sign in again', () => post('signIn'), 'Opens the Google sign-in in your browser; leave the Gmail box ticked', 'primary'))
    row.append(button('Not now', () => post('hideScopePrompt'), 'Hide this until a Mark read press'))
  }
  return notice('Sign in again to allow marking mail read. This sign-in only lets the plugin read your mail (it is from before version 0.3.0, or the Gmail box was unticked on Google\'s consent page); reading goes on as before. Your Google Cloud client needs the scope .../auth/gmail.modify on its Data access page (README, "Set up Google Cloud", step 4).', 'info', row)
}

/** The setup guide: what is missing, the steps with their console links, the paste box, Sign in. */
function renderSetup() {
  const box = $('setup')
  const hadFocus = document.activeElement === pasteBox
  box.replaceChildren()
  if (state.tooOld || !state.auth || state.auth.signedIn) return
  const a = state.auth
  const s = el('div', { class: 'setup' })
  if (a.signedOutReason) s.append(notice(a.signedOutReason))
  if (a.client) {
    const c = el('div', { class: 'client' })
    c.append(el('div', { text: `OAuth client: ${a.client.id} (${a.client.source === 'pasted' ? 'pasted client file' : 'from the settings'})` }))
    const row = el('div', { class: 'row' })
    if (a.signingIn) {
      row.append(el('span', { class: 'waiting', text: 'Waiting for the browser…' }))
      row.append(button('Start over', () => post('signIn'), 'Cancels the open sign-in and opens a new one in your browser', 'link'))
    } else {
      row.append(button(a.signedOutReason ? 'Sign in again' : 'Sign in with Google', () => post('signIn'), 'Opens the Google sign-in in your browser', 'primary'))
    }
    if (a.pasted) row.append(button('Remove pasted client', () => post('removeClient'), 'Forget the pasted client file (the settings fields are used again)', 'link'))
    c.append(row)
    if (a.signingIn) {
      c.append(el('div', { class: 'muted', text: 'Finish the sign-in in your browser. Google asks to let the app "read, compose and send" your mail (its words for the gmail.modify scope); the plugin only marks mail read or unread, and never archives, labels, trashes or sends.' }))
      // The usual dead end: the project is External and in Testing, and this account is not a test user.
      const hint = el('div', { class: 'muted hint', text: 'Google says "Access blocked" or "has not completed the Google verification process"? Add this Google account as a test user on the Audience page (or, for a Workspace account, set the user type to Internal), then Start over. ' })
      hint.append(button('Audience ↗', () => post('link', { id: 'audience' }), 'Opens the Google Cloud console in your browser', 'link'))
      c.append(hint)
    }
    s.append(c)
  }
  for (const m of a.settingsMissing || []) s.append(el('p', { class: 'error', text: `${m} is not set: Settings > This project > Gmail (or paste the client file below).` }))
  if (a.pastedBroken) s.append(el('p', { class: 'error', text: a.pastedBroken }))
  for (const p of state.problems || []) s.append(el('p', { class: 'error', text: p }))
  s.append(el('h2', { text: a.client ? 'Set up (done once)' : 'Set up Gmail: your own Google OAuth client' }))
  const ol = el('ol')
  for (const step of state.steps || []) {
    const li = el('li', { text: step.text })
    if (step.links && step.links.length) {
      const links = el('span', { class: 'links' })
      for (const l of step.links) links.append(button(`${l.label} ↗`, () => post('link', { id: l.id }), 'Opens the Google Cloud console in your browser', 'link'))
      li.append(links)
    }
    ol.append(li)
  }
  s.append(ol)
  s.append(el('div', { class: 'muted', text: 'Paste the client file (the JSON Google downloads for a Desktop app client):' }))
  s.append(pasteBox)
  const row = el('div', { class: 'row' })
  row.append(button('Save client', () => {
    savePending = true
    post('client', { text: pasteBox.value.slice(0, 65536) })
  }, 'The secret is stored in the OS keychain, never in a plain setting', a.client ? '' : 'primary'))
  row.append(button('More help (README)', () => post('link', { id: 'readme' }), 'The README: the same steps in more words, privacy notes', 'link'))
  s.append(row)
  if (state.clientError) s.append(el('p', { class: 'error', text: state.clientError }))
  box.append(s)
  if (hadFocus) pasteBox.focus({ preventScroll: true })
}

function dot(verdict) {
  if (!verdict) return el('span', { class: 'dot none' })
  const low = typeof verdict.confidence === 'number' && verdict.confidence < 0.5
  const title = `${verdict.priority}${verdict.kind ? ` / ${verdict.kind}` : ''} (${verdict.by || '?'}${typeof verdict.confidence === 'number' ? `, ${verdict.confidence.toFixed(2)}` : ''})`
  return el('span', { class: `dot p-${verdict.priority}${low ? ' low' : ''}`, title })
}

function rowActions(r) {
  const a = el('div', { class: 'actions' })
  for (const b of rowButtons(r, { triageOn: state.triage.on, write: Boolean(state.write) })) {
    const onclick = b.action === 'wrong' ? () => { wrongOpen = wrongOpen === r.id ? null : r.id; render() } : () => post(b.action, { id: r.id })
    const n = button(b.label, onclick, b.title)
    n.dataset.action = b.action
    n.setAttribute('aria-label', `${b.title}: ${r.subject}`)
    a.append(n)
  }
  return a
}

function rowEls() {
  return [...document.querySelectorAll('li.row')]
}

function onRowKey(ev, r, li) {
  const act = rowKeyAction(ev.key, ev.target === li, { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey })
  if (!act) return
  ev.preventDefault()
  if (act === 'open') return post('open', { id: r.id })
  const rows = rowEls()
  const to = moveIndex(act, rows.indexOf(li), rows.length)
  if (to !== null) rows[to].focus()
}

// The four triage levels in words, for the chooser.
const LEVELS = [
  ['urgent', 'needs you now'],
  ['action', 'you have something to do'],
  ['fyi', 'worth reading, nothing to do'],
  ['noise', 'not for you'],
]

function wrongBox(r) {
  const w = el('div', { class: 'wrong' })
  const now = r.verdict && r.verdict.priority
  w.append(el('span', { class: 'muted', text: 'How much does this need you?' }))
  for (const [p, words] of LEVELS) {
    const b = button(p, () => { wrongOpen = null; post('wrong', { id: r.id, priority: p }) }, `${p}: ${words}`)
    if (p === now) b.classList.add('current')
    w.append(b)
  }
  if (r.verdict && r.verdict.by === 'override') w.append(button('Undo', () => { wrongOpen = null; post('undoWrong', { id: r.id }) }, 'Forget your choice and let triage decide again'))
  w.append(el('span', { class: 'muted', text: 'Your choice is kept, and Jev triage learns from it (say why in its panel).' }))
  return w
}

function renderRow(r) {
  const li = el('li', {
    class: `row${r.unread ? ' unread' : ''}`,
    tabindex: '0',
    'aria-label': `${r.from}: ${r.subject}${r.unread ? ' (unread)' : ''}. Enter opens it.`,
    title: `${r.subject}\n${r.address || r.from}\nClick to open${state.annotate ? ' (notes, Discuss, New session)' : ''}`,
  })
  li.dataset.id = r.id
  li.addEventListener('click', (ev) => {
    const inControl = Boolean(ev.target.closest && ev.target.closest('button, .wrong'))
    const sel = window.getSelection && window.getSelection()
    if (rowClickOpens(inControl, Boolean(sel && !sel.isCollapsed && li.contains(sel.anchorNode)))) post('open', { id: r.id })
  })
  li.addEventListener('keydown', (ev) => onRowKey(ev, r, li))
  const line = el('div', { class: 'line' })
  line.append(dot(r.verdict), el('span', { class: 'from', text: r.from }), el('span', { class: 'subject', text: r.subject }))
  if (r.kind === 'alert') line.append(el('span', { class: `pill${r.resolved ? '' : ' firing'}`, text: alertBadge(r), title: `${r.count} unread alert mail${r.count === 1 ? '' : 's'}` }))
  else if (r.count > 1) line.append(el('span', { class: 'n', text: String(r.count), title: `${r.count} messages` }))
  line.append(el('span', { class: 'age', text: ageText(r.at, Date.now()), title: new Date(r.at).toLocaleString() }))
  li.append(line)
  if (r.snippet) li.append(el('div', { class: 'sub', text: r.snippet }))
  else li.append(el('div', { class: 'sub', text: ' ' }))
  li.append(rowActions(r))
  if (wrongOpen === r.id) li.append(wrongBox(r))
  return li
}

function renderLanes() {
  const box = $('lanes')
  box.replaceChildren()
  if (state.tooOld || !state.auth || !state.auth.signedIn) return
  if (!state.lastPoll) {
    box.append(el('p', { class: 'empty', text: state.polling ? 'Reading your mail…' : 'No poll yet.' }))
    return
  }
  for (const lane of state.lanes) {
    const s = el('section')
    const unread = lane.id === 'read' ? 0 : lane.rows.filter((r) => r.unread).length
    const head = el('button', { type: 'button', class: 'lane-head', 'aria-expanded': String(!lane.collapsed), onclick: () => post('toggle', { lane: lane.id }) })
    head.append(el('span', { class: 'chev', text: lane.collapsed ? '▸' : '▾' }), el('span', { text: lane.title }), el('span', { class: 'count', text: `${lane.total}${unread && lane.id !== 'unread' ? ` · ${unread} unread` : ''}` }))
    s.append(head)
    if (!lane.collapsed) {
      if (!lane.rows.length) s.append(el('p', { class: 'empty', text: lane.id === 'unread' ? 'No unread mail.' : 'Nothing here.' }))
      const ul = el('ul', { class: 'rows' })
      for (const r of lane.rows) ul.append(renderRow(r))
      s.append(ul)
      // Show all / Hide below a lane longer than the "Threads per lane" setting; the host keeps which
      // lanes are open, so a poll or reopening the panel does not fold them again.
      const extra = lane.total - lane.limit
      if (extra > 0) s.append(el('button', { type: 'button', class: 'lane-more', 'aria-expanded': String(lane.expanded), onclick: () => post('expand', { lane: lane.id }), text: lane.expanded ? `Hide (${extra})` : `Show all (${extra} more)` }))
      if (lane.expanded && lane.total > lane.rows.length) s.append(el('p', { class: 'empty', text: `${lane.total - lane.rows.length} more not shown.` }))
    }
    box.append(s)
  }
  if (!state.lanes.length) box.append(el('p', { class: 'empty', text: 'Every lane is off (the lanes setting).' }))
}

function renderFooter() {
  const f = $('footer')
  f.replaceChildren()
  if (state.tooOld || !state.auth || !state.auth.signedIn) return
  const w = state.write
  const writes = !w || !w.allowed ? 'Read-only for now (sign in again to mark mail read).' : w.markReadOnOpen ? 'Opening a thread marks it read in Gmail.' : 'Opening a thread leaves it unread (markReadOnOpen is off).'
  f.append(el('span', { text: `${writes} The plugin changes only the read state: it never archives, labels, trashes or sends. ${state.account ? `Signed in as ${state.account}` : 'Signed in'}${state.auth.sessionOnly ? ' (until the app closes)' : ''}. ` }))
  f.append(button('Sign out', () => post('signOut'), 'Deletes the stored Google sign-in of this project', 'link'))
}

/**
 * Where the keyboard focus is, as `{ id, action }`, so a redraw (every state message replaces the
 * rows) can put it back: without this every poll would throw a keyboard user out of the list.
 */
function focusSpot() {
  const a = document.activeElement
  if (!a || a === document.body) return null
  const row = a.closest && a.closest('li.row')
  if (!row) return null
  return { id: row.dataset.id, action: a === row ? null : a.dataset.action || null }
}

function restoreFocus(spot) {
  if (!spot) return
  const row = rowEls().find((x) => x.dataset.id === spot.id)
  if (!row) return
  const target = spot.action ? row.querySelector(`button[data-action="${spot.action}"]`) : null
  ;(target || row).focus({ preventScroll: true })
}

function render() {
  if (!state) return
  const spot = focusSpot()
  renderNotices()
  renderSetup()
  renderLanes()
  renderFooter()
  restoreFocus(spot)
}

ccPanel.onMessage((m) => {
  if (!m || m.type !== 'state') return
  state = m
  if (savePending && !state.clientError) {
    savePending = false
    pasteBox.value = ''
  } else if (state.clientError) savePending = false
  render()
})
// The rows' ages go stale while nothing arrives: redraw once a minute.
setInterval(() => state && state.auth && state.auth.signedIn && renderLanes(), 60000)
post('hello')
