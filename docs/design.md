# Gmail (bronos.gmail)

Status: design agreed with the user on 2026-11-03 (answers: accounts per project, read-only,
start with the old connector's shape, triage by Jev triage). External plugin (own repo
`BronOS/cc-cockpit-gmail`, for the marketplace). The second source plugin for jev-triage, after
Jira; built the same way (`~/Projects/cc-cockpit-jira` is the model: its docs/design.md, its
panel, its reviewer use, its tests and fakes).

Prior art (port its decisions, not its user-specific text): the old cockpit's mail connector
`~/Projects/claude-config/cockpit/connectors/mail.py` and `lib/convs.py` (queries, alert
grouping, triage text, hints). It read Gmail through the `gws` CLI; this plugin talks to the
Gmail REST API itself.

Manifest: `services: { uses: { triage: 1, reviewer: 1 } }` (both optional at run time, as in
Jira); a panel (default zone right) with lanes; CLI `ccc gmail`. Needs cc-cockpit 0.9.1+
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
  `.apps.googleusercontent.com`) and stores id and secret itself (the secret in `ctx.secrets`, not
  in a plain setting), then offers Sign in. `ccc gmail client <path-to-json>` does the same from a
  file. The settings fields stay for people who prefer them; a pasted client wins until removed.
  The README has the same steps with screenshots-free text, with the two cases:
  - Personal Gmail: user type External, publishing status **In production** (unverified). In
    Testing the refresh token expires after 7 days. Google shows an "unverified app" screen once.
  - Google Workspace (work): user type **Internal** inside the organisation: no verification, no
    warning, no expiry. An admin may block third-party apps; then it cannot work (say so).
- Sign in: a "Sign in with Google" button in the panel (and `ccc gmail login`, which only starts
  it: the browser does the rest) calls `ctx.oauth.authorize`. The refresh token goes to
  `ctx.secrets` under a key per project and client (`refresh:<projectKey>:<sha256(clientId) 12>`,
  since secrets are app-wide while accounts are per project); the access token stays in memory
  and is refreshed by `ctx.oauth.refresh` shortly before `expiresAt`. `invalid_grant` = signed out:
  drop the token, show "Sign in again" (the 7-day Testing expiry is the usual cause: say so).
  "Sign out" deletes the secret. Changing `clientId` signs out.
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

- item: `{ id: threadId | "alert:<name>", text, hint?, floor?, fields: { from, to, lane, list } }`.
- text (`triageText: full`): who it is from and to, the subject, earlier messages of the thread as
  context (sender + snippet), then the newest message's snippet marked as new. `summary`: only
  from + subject (for an employer that objects to mail text leaving).
- hints (the old connector's rules that need no Jira): every alert -> noise. The Jira-mail hints
  (moves = noise, Done = fyi, mention of me on my open issue = action) need Jira lookups: left out
  of v1 (a later version can ask the Jira plugin through a service).
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

## CLI

`ccc gmail status | refresh | list [lane] | show <threadId> | login | logout | help`. No stdin.

## Left out of v1

Writing (mark read, archive, labels, replies: needs `gmail.modify` and a review of the consent
text), the Jira-mail hints, attachment download for non-images, push notifications (needs a
public endpoint), several accounts in one project.
