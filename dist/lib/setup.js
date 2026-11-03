'use strict'
// The setup guide the panel shows while not signed in (design "Auth": "setup has to be easy for a
// new user"): numbered steps with the exact Google Cloud console pages. The page gets the steps
// with link ids only; a click posts the id and the host opens the fixed URL here with
// ctx.openExternal, so a page (or anything that reached it) cannot make the host open an address
// of its choosing. The README has the same steps in more words.

const LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  gmailApi: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  scopes: 'https://console.cloud.google.com/auth/scopes',
  clients: 'https://console.cloud.google.com/auth/clients/create',
  readme: 'https://github.com/BronOS/cc-cockpit-gmail#set-up-google-cloud',
  permissions: 'https://myaccount.google.com/connections',
}

/** The steps: `{ text, links: [{ id, label }] }`. */
const STEPS = [
  { text: 'Create a Google Cloud project (any name, e.g. "cc-cockpit mail"). It is yours: nobody else sees the mail.', links: [{ id: 'project', label: 'New project' }] },
  { text: 'Enable the Gmail API in that project.', links: [{ id: 'gmailApi', label: 'Gmail API' }] },
  {
    text: 'Set up the consent screen (Google Auth Platform > Get started): an app name and your address. Audience: for a personal Gmail account choose External, then Publish app so it is "In production" (in Testing Google ends your sign-in every 7 days). For a Google Workspace (work) account choose Internal.',
    links: [{ id: 'branding', label: 'Branding' }, { id: 'audience', label: 'Audience' }],
  },
  { text: 'Data access: add the scope .../auth/gmail.readonly (Gmail API, read only). Nothing else is needed: the plugin never changes your mailbox.', links: [{ id: 'scopes', label: 'Data access' }] },
  { text: 'Clients > Create client: application type "Desktop app", any name. Download the JSON file Google offers.', links: [{ id: 'clients', label: 'Create client' }] },
  {
    text: 'Paste the whole file below and press Save client (or run `ccc gmail client <file>`), then Sign in with Google. For a personal account Google warns once that it has not verified the app: it is your own app, so choose Advanced > Go to <app name>.',
    links: [],
  },
]

/** The URL of a link id from the page, or null for any other value. */
function linkUrl(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(LINKS, id) ? LINKS[id] : null
}

module.exports = { LINKS, STEPS, linkUrl }
