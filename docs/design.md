# Gmail (bronos.gmail)

Status: design agreed with the user on 2026-11-03 (answers: accounts per project, read-only,
start with the old connector's shape, triage by Jev triage). External plugin (own repo
`BronOS/cc-cockpit-gmail`, for the marketplace). The second source plugin for jev-triage, after
Jira; built the same way (`~/Projects/cc-cockpit-jira` is the model: its docs/design.md, its
panel, its reviewer use, its tests and fakes).
0.2.0 (2026-11-03, designed with the user together with bronos.jira 0.5.0): Jira mail through the
Jira plugin's `jira` service (section "Jira mail"), and a pasted client that survives a reinstall
(section "Auth"); no app change needed (cc-cockpit 0.9.2).

Prior art (port its decisions, not its user-specific text): the old cockpit's mail connector
`~/Projects/claude-config/cockpit/connectors/mail.py` and `lib/convs.py` (queries, alert
grouping, triage text, hints). It read Gmail through the `gws` CLI; this plugin talks to the
Gmail REST API itself.

Manifest: `services: { uses: { triage: 1, reviewer: 1, jira: 1 } }` (all optional at run time, as in
Jira; `jira` since 0.2.0); a panel (default zone right) with lanes; CLI `ccc gmail`. Needs cc-cockpit 0.9.1+
(`ctx.oauth`, `ctx.secrets`, `ctx.panels.header`, `ctx.openExternal`, reviewer `aside`); on an older
app it says so in the panel instead of half working.

## Auth (per project: a personal project and a work project use different accounts)

- Google OAuth 2.0 through `ctx.oauth` (authorization code + PKCE, loopback redirect on 127.0.0.1,
  the system browser). Auth URL `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent`
  (without both Google sends no refresh token), token URL `https://oauth2.googleapis.com/token`,
  scope `https://www.googleapis.com/auth/gmail.readonly` only.
- The person brings the OAuth client, always (decided 2026-11-03: no shared client, neither
  unverified nor verified: the user does not want to be linked to the plugin's users, and Gmail
  scopes are "restricted", so a shared client would need Google's verification and a paid yearly
  assessment). Settings (project scope): `clientId` (string), `clientSecret` (`"format": "secret"`).
- Setup has to be easy for a new user, so the panel, while not signed in, is a short guide with
  numbered steps and the exact Google Cloud console links (create a project, enable the Gmail API,
  the consent screen, a Desktop client, download its JSON), opened with `ctx.openExternal`, and a
  **Paste the client file** box: the JSON Google offers to download (`{"installed": {"client_id",
  "client_secret", ...}}`, also what the gws CLI keeps in `~/.config/gws/client_secret.json`). The
  host checks it (an `installed` client, Google's auth and token URIs, an id ending in
  `.apps.googleusercontent.com`) and stores id and secret itself, then offers Sign in. 0.1.0 kept
  the secret in `ctx.secrets`; since 0.2.0 the whole client is one `ctx.storage` record (`client:
  { clientId, clientSecret }`), because an uninstall deletes every `ctx.secrets` key of the plugin
  (the app's rule, `installer.ts`) and keeps `ctx.storage`: after an uninstall and a Marketplace
  install (seen 2026-11-03) the client was gone. A Desktop app client's secret is not confidential
  in Google's terms (an installed app cannot keep one; the downloaded file is plain text), unlike
  the refresh token. Load moves a 0.1.0 keychain copy into the record and deletes the old key. `ccc gmail client <path-to-json>` does the same from a
  file. The settings fields stay for people who prefer them; a pasted client wins until removed.
  The README has the same steps with screenshots-free text, with the two cases:
  - Personal Gmail: user type External, publishing status **In production** (unverified). In
    Testing the refresh token expires after 7 days. Google shows an "unverified app" screen once.
  - Google Workspace (work): user type **Internal** inside the organisation: no verification, no
    warning, no expiry. An admin may block third-party apps; then it cannot work (say so).
- Sign in: a "Sign in with Google" button in the panel (and `ccc gmail login`, which only starts
  it: the browser does the rest) calls `ctx.oauth.authorize`. The refresh token goes to
  `ctx.secrets` under a key per project and client (`refresh:<projectKey>:<sha256(clientId) 12>`,
  since secrets are app-wide while accounts are per project; `projectKey` is a random id in this
  project's `ctx.storage`, which is per project and kept by an uninstall, so the key is the same
  after a reinstall: nothing in `ctx` is steadier, as `ctx.storage` and `ctx.dataDir` both follow the
  app's project id and `ctx.projectDir` is the folder path); the access token stays in memory
  and is refreshed by `ctx.oauth.refresh` shortly before `expiresAt`. `invalid_grant` = signed out:
  drop the token, show "Sign in again" (the 7-day Testing expiry is the usual cause: say so).
  "Sign out" deletes the secret. Changing `clientId` signs out. The refresh token cannot outlive an
  uninstall (the app deletes it); a `ctx.storage` marker `signedIn: { client: <sha256(clientId) 12> }`,
  set with the refresh token and deleted with it, lets the panel say "the stored sign-in is gone
  (uninstalled): sign in again" instead of looking like a first setup.
- The account: `GET users/me/profile` (emailAddress, historyId) after sign in; shown in the title
  bar (`ctx.panels.header` meta, like Jira: last poll · address) with a ↻ action.
- Tokens are sent only to `https://gmail.googleapis.com` and the OAuth endpoints; never logged,
  never in a panel message, never in the CLI output.

## Fetching (Gmail API v1, read-only)

Three lists, as the old connector (settings in brackets, project scope, with these defaults):
- Unread mail: `is:unread -in:spam -in:trash newer_than:<unreadDays 14>d` minus the alert senders,
  the newest `<maxUnread 15>` threads (it showed 15; the "Issues per lane" style Show all applies
  in the panel, this is the fetch cap: allow up to 100).
- Alerts: the same query restricted to `from:` the alert senders, up to 100 threads (listed apart,
  so an alert storm never pushes real mail out).
- Read: `-is:unread in:inbox newer_than:<readDays 2>d`, the newest `<maxRead 10>` that are not
  alerts (ask for twice as many).
- `alertSenders` (list of addresses, default empty = no Alerts lane). No regex settings (the app
  refuses regexes in schemas): matching is by address in code.
- Gmail's copies of Google Chat messages (`chat-noreply@google.com`) are left out (a future chat
  plugin has them).
- Each listed thread: `threads.get format=metadata metadataHeaders=From,To,Cc,Subject,Date,List-Id`
  (sender, subject, snippet, labels, internalDate per message), read again only when its
  `historyId` changed (cache per project in the data dir, bounded). Concurrency 4.
- Polling every `<pollMinutes 2>` minutes while the window is open: `users.history.list
  startHistoryId=<last>` first (cheap; no change = no list calls); on a change or every 10th poll,
  the three list queries. A `404` on history (too old) = full refresh.
- Quotas are far above one person's use; a 429/5xx backs off (poll interval doubled, capped at 30
  min) and shows a notice.

## Alerts (Grafana, as the old connector)

An alert message: from an alert sender, subject `[FIRING…]` / `[RESOLVED…]`. Name from the body
(`alertname=X grafana_folder=`) else the subject minus the trailing `(labels)`; node from
`nodename=`. One row per alert name (all its unread threads), with a count badge and its nodes;
a name whose newest message is RESOLVED shows as resolved. A sender's mail that does not match the
Grafana shape is a plain row in the Alerts lane. Opening an alert row shows its newest 10 threads.

## Lanes

Unread, Alerts (only with `alertSenders`), Read (last `readDays`). Settings `lanes` (booleans, as
Jira) to hide any; "Issues per lane" style `rowsPerLane` with Show all / Hide (Jira 0.3.0, same
muted link style as the Sessions panel). Order inside a lane: triage priority, then newest.

Unread is Gmail's own UNREAD label (read-only: the plugin never changes it; opening a thread here
does not mark it read in Gmail, and the README says so). No plugin seen state is needed.

## Triage (jev-triage `triage` v1, source `gmail`)

- item: `{ id: threadId | "alert:<name>", text, hint?, floor?, fields: { from, to, lane, list, jira? } }`
  (`jira`: the issue key of a Jira mail, 0.2.0).
- text (`triageText: full`): who it is from and to, the subject, earlier messages of the thread as
  context (sender + snippet), then the newest message's snippet marked as new. `summary`: only
  from + subject (for an employer that objects to mail text leaving).
- hints: every alert -> noise; Jira mail (0.2.0) per section "Jira mail": moves only = hint noise,
  about a Done issue = hint fyi, only mentions me on / creates my open issue = floor action.
- Classify only what is shown and changed (hash of the item); listen to triage `change`; without
  triage the panel works unsorted and says triage is off (as Jira).

## Panel

Rows as Jira's: a triage dot, sender, subject (bold when unread), snippet on a second line, age.
Click / Enter opens the thread; hover buttons ↗ (the thread in Gmail: `https://mail.google.com/mail/?authuser=<address>#all/<threadId>`; `u/<address>/` gives a 404 in a browser not signed in to that account
via `ctx.openExternal`), the triage verdict button ("action ▾", as Jira 0.4.0), Discuss, New.
Header: title bar meta (last poll · address) and ↻. Not signed in: the panel shows what is missing
(client id / secret) or the Sign in button, with a link to the README section.

## The thread view (reviewer annotate, as Jira)

- `threads.get format=full` fresh on open. Each message as a card: sender, to/cc, date, then the
  body: `text/html` part sanitized by our own builder into the reviewer's allow-list (as Jira's
  `adfhtml`: parse, keep only allowed tags, escape every text, links http(s)/mailto only, no style
  attributes, no remote images: an `<img>` with an http(s) src becomes a "[image: alt]" link,
  since remote images are tracking pixels), else `text/plain` as paragraphs. Quoted history
  (`gmail_quote`, `blockquote type=cite`) folded into `<details>`.
- Inline images (`cid:` parts) and image attachments: downloaded through
  `users.messages.attachments.get` (raster types only, checked by magic number, the same budgets
  as Jira's images.js: at most 15, 700 KiB each, 7.5 MiB in all) as reviewer assets.
- Other attachments listed (name, size) with no download in v1.
- `aside`: from, to, cc, date, labels, the thread's message count, the Gmail link.
- Discuss / New session send a prompt `About the mail "<subject>" from <sender>` + readable text.

## Jira mail (0.2.0, the bronos.jira `jira` service v1)

`uses: { jira: 1 }`, optional: with `ctx.services.available('jira')` false (no Jira plugin, off,
or another major) nothing below runs and the items are exactly 0.1.0's. Code: `lib/jira.js` (pure),
the host's `jiraHints` / `jiraThread`. Prior art: the old connector's `Hints` and `show` (decisions
ported, its text and the user's site and name not).

- `site()` (asked at most every 5 min, raced against 2 s) gives `{ ready, site, senders }`; not
  ready, not https or no senders = no Jira. A message is from Jira when its sender address is one of
  `senders` (exact, lower case). Its key: the first issue key in the subject (`[A-Z][A-Z0-9_]*-N`,
  not inside a word), else the first `<site>/browse/KEY` in the snippet (polling) or in the Jira
  messages' bodies (thread view).
- Hints, only for an unread thread, on its new messages (the unread ones not from the person; the
  lead message when none): (1) every new message is Jira's and its snippet says it "moved a work
  item" (or "issue") -> hint noise, no lookup; (2) a new Jira message's issue is Done now -> hint fyi;
  (3) every new message is Jira's and each "mentioned you on" or "created a work item", and the issue
  is open and `mine` -> floor action. Else no hint (Jev). The order is the old connector's.
- Lookups (`createLookups`): `issue(key, { maxAgeMs })` with `maxAgeMs` = the age of the newest Jira
  mail about the key (15 s .. 10 min), so Jira's poll answers when it is newer than the mail. Cached
  per key: asked again after 10 min, after a newer mail, or a minute after a failure; an answer
  past its TTL is still used while the new one comes (no hint flapping, no extra Jev calls); never
  one older than the newest mail. At most 10 started a round (Jira allows 30 a minute), at most 300
  kept. A round waits at most 4 s; a lookup that lands later triggers one more classify, where only
  the changed items go to triage.
- Thread view, beside the mail (cc-cockpit 0.9.3+): when the reviewer's `features()` lists
  `companion` (asked at each open, raced against 2 s; an older reviewer has no `features` and the
  call rejects, read as no), the issue goes to annotate as `companion: { title, html, facts, url,
  assets, label: 'Jira · KEY', urlLabel: 'Jira' }` and the mail with `label: 'Mail', urlLabel:
  'Gmail'` (the reviewer's column header bars: the label and an "Open in <urlLabel> ↗" button): the
  document as the Jira plugin sent it, `document()` asked with `maxHtmlBytes: 2000000` (a document of its own, not a
  share of the mail's 2 MB), its own `aside` as `facts` (else the facts `jiraSection` makes from
  `issue()`), and its pictures through `fitAssets` (the reviewer has one budget for both
  documents). The mail's html and details column are then the mail's alone. A refused companion
  call is tried once more as below (a document over 800 KB is then too long there, said in the
  note), before text. A failed document: no companion, the section below with its note.
- Thread view, below the mail (an older reviewer, or the fallback above): a thread (not an alert group) with a Jira message and a key starts `issue(key)` and
  `document(key, { maxHtmlBytes: 800000, maxImages: 7, maxImageChars: 3.5 MiB, waitMs: 8000 })`
  at once, raced against 15 s, while the mail's pictures download with a smaller share (8, 4 MiB):
  together under the reviewer's 30 assets / 8 MiB (`fitAssets` drops Jira pictures that would not
  fit, which then show their alt text). The document is checked (`checkDocument`: html a string
  within the budget, assets with plain ids not used by the mail and `data:image/(png|jpeg|gif|webp)`
  URLs); its headings go two levels down under `<h2>Jira issue KEY</h2>` (linked) after the
  messages, its bytes counted first in the 2 MB page so the oldest messages give way. The details
  column gets Jira issue / Status / Priority / Assignee (`(you)` when mine) from `issue()`. Any
  failure: the mail alone plus `The issue is not shown here: <why>`, logged. The reviewer's text
  fallback gets one `Jira issue KEY: summary (status, priority, assignee) url` line first.
- `ccc gmail status` has a `jira` line (on / off).

## CLI

`ccc gmail status | refresh | list [lane] | show <threadId> | login | logout | help`. No stdin.

## Left out of v1

Writing (mark read, archive, labels, replies: needs `gmail.modify` and a review of the consent
text), attachment download for non-images, push notifications (needs a
public endpoint), several accounts in one project.
