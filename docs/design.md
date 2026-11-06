# Gmail (bronos.gmail)

Status: design agreed with the user on 2026-11-03 (answers: accounts per project, read-only,
start with the old connector's shape, triage by Jev triage). External plugin (own repo
`BronOS/cc-cockpit-gmail`, for the marketplace). The second source plugin for jev-triage, after
Jira; built the same way (`~/Projects/cc-cockpit-jira` is the model: its docs/design.md, its
panel, its reviewer use, its tests and fakes).
0.2.0 (2026-11-03, designed with the user together with bronos.jira 0.5.0): Jira mail through the
Jira plugin's `jira` service (section "Jira mail"), and a pasted client that survives a reinstall
(section "Auth"); no app change needed (cc-cockpit 0.9.2).
0.3.0 (2026-11-03, asked for by the user): the first write, limited to the read state: Mark read /
Mark unread and markReadOnOpen (section "Read state"), with the scope gmail.modify; no app change
needed (cc-cockpit 0.9.3).
0.6.0 (2026-11-06, the mail overlay redesign the user approved from a mock-up): the reviewer's mail
layout (annotate `kind: 'mail'`), remote pictures on request through the host with an SSRF guard and
an optional proxy, the sender's footer folded, the Jira issue as a card (sections "The thread view"
and "Remote images"). Needs the reviewer of cc-cockpit 0.13.0 (features `mail`, `actions`, `update`)
for the layout and the buttons; an older app gets the cards as before.

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
  scope `https://www.googleapis.com/auth/gmail.modify` only since 0.3.0 (0.1.0 and 0.2.0:
  `gmail.readonly`). gmail.modify includes reading and is "restricted" like gmail.readonly, so for
  the person's own client only the scope ticked on the Data access page changes (Internal: no
  verification; External in production: the unverified screen once). Google's consent text for it
  says "Read, compose, and send emails"; what the plugin does with it is section "Read state". An
  older sign-in keeps reading (a refresh sends no scope; the grant keeps its own) and is asked to
  sign in again before a write (section "Read state", "The scope upgrade").
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

## Fetching (Gmail API v1)

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

Unread is Gmail's own UNREAD label. Since 0.3.0 the plugin changes it (and only it) on Mark read /
Mark unread and when a thread is opened with markReadOnOpen on (section "Read state"). No plugin
seen state is needed.

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
via `ctx.openExternal`), Mark read / Mark unread (0.3.0, section "Read state"), the triage verdict button ("action ▾", as Jira 0.4.0), Discuss, New.
Header: title bar meta (last poll · address) and ↻. Not signed in: the panel shows what is missing
(client id / secret) or the Sign in button, with a link to the README section.

## The thread view (reviewer annotate, as Jira)

- `threads.get format=full` fresh on open. Each message as a card: sender, to/cc, date, then the
  body: `text/html` part sanitized by our own builder into the reviewer's allow-list (as Jira's
  `adfhtml`: parse, keep only allowed tags, escape every text, links http(s)/mailto only, no style
  attributes, no remote images: an `<img>` with an http(s) src becomes a muted "[image: alt]"
  label, since remote images are tracking pixels; a link until 0.6.0, which let one click load it
  outside the rules below), else `text/plain` as paragraphs. Quoted history
  (`gmail_quote`, `blockquote type=cite`) folded into `<details>`.
- The mail layout (0.6.0): when the reviewer's `features()` has `mail`, annotate gets `kind: 'mail'`
  and the document uses the reviewer's `mail-*` classes (`document.js` `messageCard`): `<h1>`
  subject, the Jira card, the images bar, then per message a `mail-head` (initials avatar, name and
  address, "to … · cc …", "Today HH:MM" and an Unread chip) and the `mail-body`. No aside unless the
  issue is a companion. A lone call-to-action link ("View …", "Open …") gets `mail-cta`. An older
  reviewer gets the 0.5 cards (asked once per open, never assumed).
- The sender's footer (`sanitize.js` `foldFooter`, every view): folded into `<details
  class="mail-footer">` "Sender's footer" only at the end of a body, from the first short block
  with a footer signal (unsubscribe, privacy policy, "this email was sent to", manage preferences,
  app-store badges, opt out) when every later block is a signal or short boilerplate, some block of
  it has a link, 40+ characters of text come before it, no quote follows, and the cut does not
  pass through a link, list, `pre` or data table. A false fold hides real text, so each doubt keeps
  the mail as written.
- Attribute entities: an alt or title decoded once more when a character reference remains (Jira
  sends `alt="&amp;#x2192;"` for its status arrow, shown as the literal `&#x2192;` before 0.6.0).
- Inline images (`cid:` parts) and image attachments: downloaded through
  `users.messages.attachments.get` (raster types only, checked by magic number, the same budgets
  as Jira's images.js: at most 15, 700 KiB each, 7.5 MiB in all) as reviewer assets.
- Other attachments listed (name, size) with no download in v1.
- `aside`: from, to, cc, date, labels, the thread's message count, the Gmail link.
- Discuss / New session send a prompt `About the mail "<subject>" from <sender>` + readable text.

## Remote images (0.6.0)

Code: `lib/remote.js` (fetch, address rules, loader, policy), `sanitize.js` (placeholders), the
host's `startRemote` / `onReviewerAction`. Decisions:

- **Who fetches**: the host (Node), never the page: the reviewer's CSP allows no remote image, and
  a page fetch would carry the app's cookies and headers. The bytes go to the reviewer as assets
  (`r` + 20 hex of the URL's sha256, so one URL is one asset).
- **When**: `showRemote`: Remote images "Always", the message's sender on the always-show list
  (`ctx.appStorage` `imageSenders`, read again on each open since another window may change it), or
  Show images pressed on that reviewer key this run. Else placeholders: `<img data-asset class=
  "mail-remote">` whose asset the reviewer was not given draws as a dashed chip with the alt; the
  minor ones (logos, avatars, both sides at most 48 px or one at most 24, by name, alt or title)
  carry `mail-minor` and are hidden until loaded. The bar counts the others.
- **Buttons**: the bar's `<span data-action="show-images">` and `"always-sender"` are buttons in
  the reviewer (feature `actions`); a click is the reviewer service event `action { key, id,
  caller }`, acted on only for `caller === ctx.pluginId` and a key in `S.views` (the newest 10
  opened, holding the URLs not loaded and the budget left). The pictures go in with `update({ key,
  assets, hide: ['images-bar'], status? })` (feature `update`): in place, the notes' anchors kept.
  The bar stays, with the reason as the status, when none could be loaded. A key not remembered (a
  restart) gets a status asking to open the mail again. Without both features the bar has no buttons.
- **SSRF**: `dns.lookup({ all: true })`, every address checked (`blockedAddress`: loopback,
  private, link-local, CGNAT, this-network, multicast, reserved and documentation ranges, IPv6
  unique-local, link-local, site-local, multicast, Teredo; IPv4-mapped, IPv4-compatible, NAT64 and
  6to4 read as their IPv4 address), then the connection pinned to the first checked address (a
  `lookup` passed to `http(s).request`, `agent: false`): no rebinding between check and connect.
  http(s) only, no credentials, at most 3 redirects each checked again.
- **Type and size**: Content-Type png/jpeg/gif/webp and the magic bytes (`images.sniff`); SVG never.
  700 KiB a picture (Content-Length and while streaming), 5.5 MiB, 30 pictures and the room the
  mail's `cid:` pictures and a Jira issue (its JIRA_DOC share, reserved before it answers) leave of
  30 assets / 7.5 MiB; 10 s a picture, 15 s all; 4 at a time; content before minor ones.
- **Proxy** (`imageProxy`, `{url}` URL-encoded; none built in): the template's scheme+host+port is
  exempt from the address check (the person chose it; a proxy on the LAN is common). The target URL
  is checked statically, never resolved (resolving it would tell the sender's DNS of the open):
  scheme, credentials, an IP literal by the table, `localhost`/`.local`/`.internal`/single-label
  names refused. Redirects from the proxy are checked normally (exempt only back on its host). A bad
  template is a panel problem and loads nothing, rather than fetching directly behind the person's back.
- **Older reviewer** (no `mail`): label mode: loaded pictures as images, the rest as a muted
  "[image: alt]", minor ones dropped; no buttons. The own reader page gets the same.

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
- The card (0.6.0, mail layout; `jira.js` `relatedCard`): under the subject, `mail-related` with a
  JIRA badge, `KEY · summary` (from `issue()`, else the subject without `Re:` and the `[JIRA]` /
  `[Site]` / `(KEY)` prefixes) and a status line: the move the newest Jira message states
  (`statusChange` on its plain part, else its html as text with picture alts: Jira's arrow is a
  16 px picture), plus `now <status>` when `issue()` has moved on; without a move, `issue()`'s
  status, type and assignee. Open is the existing https browse link (`<a class="mail-related-open">`,
  opened by the reviewer's link handling): Jira's inbox-feed `act` knows only the issues of its own
  panel, so it is no general "open this issue", and no new service method was worth adding for it.
  The issue document stays below the mail (or beside it) as before.
- `ccc gmail status` has a `jira` line (on / off).

## Read state (0.3.0: mark read / mark unread)

Asked for by the user on 2026-11-03: writes, limited to the read state. Code: `lib/http.js`
(`setThreadUnread`), `lib/client.js` (`setUnread`), `lib/readstate.js` (the bound, the overlay), the
host's `writeReadState` / `markRow`.

- **One write, one label.** `POST users/me/threads/<id>/modify` with `{ removeLabelIds: ['UNREAD'] }`
  (read) or `{ addLabelIds: ['UNREAD'] }` (unread), built in `http.readStateBody` from a boolean, so
  no caller can pass a label list: the plugin never archives (INBOX), labels, stars, trashes or sends.
  It is the only request that is not a GET; `test/manifest.test.js` checks the sources for any other
  method, write endpoint or label list. threads.modify changes every message of the thread (Mark
  unread makes all of them unread); the same call both ways keeps it one function.
- **Where**: a hover button on every row: Mark read (an unread thread in Unread or Alerts; an alert
  group: all of its unread threads), Mark unread (a read thread in Read). `ccc gmail read <id>`
  (`alert:<name>` too) and `ccc gmail unread <threadId>`. Opening a thread from the panel marks it
  read when the project setting `markReadOnOpen` (boolean, default false since 0.4.0; it was true) is on: the threads the open
  read fresh that have an UNREAD message (an alert row: the up to 10 it shows); in the background,
  after the read, never for Discuss, New session or `ccc gmail show`.
- **Optimistic**: the host keeps an override per thread (`S.marks`: unread or not) over the cached
  lists (`readstate.overlayCache`): read leaves Unread and Alerts for Read (an alert sender's thread
  does not show in Read, as in the poll), unread leaves Read for Unread, the messages take the new
  state. The panel gets the moved row before the call. A failed call takes the override back (to an
  earlier one of the same thread still waiting for a poll) and the panel says why ("… could not be
  marked read in Gmail: …. It is back where it was."; for a group "1 of 2 threads of …"). A call that
  succeeded keeps its override until a full poll that started after it (that poll read Gmail again);
  a "no change" history answer does not clear it. A new account or client clears them all.
- **Bound**: `readstate.createGate`: at most 4 calls at once and 120 started in any 60 s
  (threads.modify is 10 quota units; an alert group is at most 100 threads, one minute's worth); past
  that a call waits for the window, and past 300 waiting it is refused. One thread's calls go in
  order (a quick read then unread lands as pressed). Deactivate stops the gate: what waits is
  refused, every call checks `S.stopped` (and the generation) again when its turn comes, the request
  carries the host's abort signal, and nothing is posted after stop: no call on a disposed ctx.
  `ccc gmail read|unread` waits at most 25 s (the CLI deadline), then says it is still waiting.
- **The scope upgrade.** A sign-in from 0.1.0 / 0.2.0 holds gmail.readonly. cc-cockpit's
  `ctx.oauth` does not pass the token response's `scope` (as of 0.9.3; FRICTION.md), so the plugin
  tells it apart without a request: the `signedIn` storage marker gets a `scope` (`modify` /
  `readonly`) from 0.3.0 on, and a marker without one is a 0.2.0 sign-in, read-only. A 0.3.0 sign-in
  asked for gmail.modify and is taken as granted unless the token response's `scope` says otherwise
  (read when an app passes it) or the first write gets 403 insufficientPermissions (the Gmail box
  unticked on Google's granular consent page); then the marker says `readonly`, the row goes back,
  and no error notice: the prompt says it. Read-only sign-ins keep polling and opening as before;
  writes are not tried (markReadOnOpen skips them silently), and the panel shows an info prompt
  "Sign in again to allow marking mail read" with **Sign in again** and **Not now** (hidden for the
  run; the next Mark read press shows it again); `ccc gmail status` has a `write` line, `ccc gmail
  read` fails with the same text. Signing in again with the same Google account keeps the lanes and
  the verdicts (the account is read with `profile` after the sign-in; another account starts over as
  before), so nothing is judged by Jev again.

## CLI

`ccc gmail status | refresh | list [lane] | show <threadId> | read <threadId> | unread <threadId> |
login | logout | client <file> | help`. No stdin.

## Left out of v1

Other writes (archive, labels, trash, replies: they would need a new review of what the scope's
consent text allows and the plugin does), attachment download for non-images, push notifications
(needs a public endpoint), several accounts in one project.
