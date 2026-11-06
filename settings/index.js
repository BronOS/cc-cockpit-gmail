'use strict'
// The always-show senders (settings/index.html). Host messages: `senders { list }` (the stored list,
// after every change), `refused { reason }`. Page messages: `ready`, `add { address }`,
// `remove { address }`. Every address goes in through textContent or a value, never as markup.

const $ = (id) => document.getElementById(id)

function showError(text) {
  $('error').textContent = text || ''
  $('error').hidden = !text
}

function render(list) {
  const ul = $('list')
  ul.replaceChildren()
  for (const address of list) {
    const li = document.createElement('li')
    li.className = 'cc-settings-row'
    const name = document.createElement('span')
    name.className = 'addr'
    name.textContent = address
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove'
    remove.title = `Ask again before showing the pictures of mail from ${address}`
    remove.addEventListener('click', () => {
      remove.disabled = true
      ccPanel.post({ type: 'remove', address })
    })
    li.append(name, remove)
    ul.append(li)
  }
  $('empty').hidden = list.length > 0
}

function add() {
  const address = $('address').value.trim()
  if (!address) return
  showError('')
  ccPanel.post({ type: 'add', address })
}

$('add').addEventListener('click', add)
$('address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') add()
})

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'senders' && Array.isArray(m.list)) {
    render(m.list.filter((x) => typeof x === 'string'))
    if (m.added) $('address').value = ''
    showError('')
  } else if (m.type === 'refused') showError(String(m.reason || 'Not saved.'))
})

ccPanel.post({ type: 'ready' })
