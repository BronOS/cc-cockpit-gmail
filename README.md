# Gmail for cc-cockpit

`bronos.gmail` shows your Gmail in a cc-cockpit panel, in lanes, sorted by
[Jev triage](https://github.com/BronOS/cc-cockpit-jev-triage), and hands a thread to Claude to
discuss. It is **read-only**: it asks Google only for `gmail.readonly` and never marks anything
read, archives, labels or sends. Opening a thread here does not mark it read in Gmail.

- **Lanes**: Unread, Alerts (mail from the addresses you list, Grafana alerts grouped by alert
  name) and Read (the inbox of the last days). Choose which ones in the settings.
- **Triage**: each lane is sorted by priority (urgent, action, fyi, noise), then the newest
  message. Alert groups are noise by the plugin's own hint; the rest is judged by Jev through
  jev-triage.
- **Discuss with Claude**: click a row and the thread opens in the reviewer overlay as a clean
  page (every message as a card, its pictures, its attachments listed), where you select text to
  add notes and press Discuss (the Claude tab you are looking at) or New session.
- `ccc gmail ...` from any tab of the project.

Each project signs in on its own: a work project and a personal project can use different Google
accounts.

## Requirements

- **cc-cockpit 0.9.1 or later** (plugin API 1 with `ctx.oauth`, `ctx.secrets`, the panel title
  bar and `ctx.openExternal`). On an older app the panel says so and the plugin does nothing.
  **0.9.2 or later is recommended**: from 0.9.2 the links inside a mail (Open in Gmail among them)
  open in your browser, and Start over cancels a stuck sign-in.
- **Your own Google Cloud OAuth client** (free; the steps are below and in the panel). There is no
  shared client: Gmail's scopes are "restricted", so a client shared by every user would need
  Google's verification and a paid yearly security assessment, and it would tie your mail to
  someone else's app.
- **Jev triage (`bronos.jev-triage`) for sorting**, which in turn needs the Jev plugin
  (`bronos.jev`). Without it the lanes work unsorted and the panel says triage is off.
- What opening a thread shows, by reviewer:
  - the bundled reviewer of 0.9.1: the clean page with its pictures, a details column, notes,
    Discuss and New session;
  - a reviewer whose `annotate` takes text only: the thread as plain text, with notes (the plugin
    notices the refusal once and uses text for the rest of the run);
  - no reviewer with `annotate` (or none enabled): the plugin's own read-only page with the same
    clean thread and pictures, and Discuss, New session and ↗ buttons (no notes).

## Set up Google Cloud

About ten minutes, once per Google account. The panel shows the same steps with buttons that open
each console page.

1. **Create a project**: <https://console.cloud.google.com/projectcreate>. Any name
   ("cc-cockpit mail"). It is yours alone: nobody else sees your mail through it.
2. **Enable the Gmail API** in that project:
   <https://console.cloud.google.com/apis/library/gmail.googleapis.com> > Enable.
3. **The consent screen**: Google Auth Platform > Get started
   (<https://console.cloud.google.com/auth/branding>). App name (anything), your address as the
   support and contact address. Then the **Audience**, which depends on the account:
   - **Personal Gmail account (`@gmail.com`)**: user type **External**. Then, on the Audience page
     (<https://console.cloud.google.com/auth/audience>), press **Publish app** so the publishing
     status is **In production**. Do not leave it in Testing: Google ends the sign-in of a Testing
     app every 7 days (the panel then says `invalid_grant`). You do not need Google's
     verification for your own use; Google shows an "unverified app" screen once at sign-in.
   - **Google Workspace (work) account**: user type **Internal**. Only people of your organisation
     can use the app; there is no verification, no warning screen and no expiry. Your admin may
     block apps that are not on an allow list: then the sign-in is refused and this plugin cannot
     work for that account (ask the admin to allow the client id).
4. **Data access** (<https://console.cloud.google.com/auth/scopes>): Add or remove scopes, filter
   for Gmail API, tick `.../auth/gmail.readonly` ("View your email messages and settings"), Update,
   Save. Nothing else is needed.
5. **Create the client** (<https://console.cloud.google.com/auth/clients/create>): application
   type **Desktop app**, any name, Create. In the dialog that follows, **Download JSON**
   (`client_secret_<id>.json`). A "Web application" client does not work: the sign-in returns to
   `127.0.0.1` on a random port, which only a Desktop client allows.
6. **Give the client to the plugin**, either way:
   - in the Gmail panel, paste the whole file into the box and press **Save client**, or
   - from a tab: `ccc gmail client ~/Downloads/client_secret_<id>.json`.

   (Or enter the client ID and secret in Settings > This project > Gmail; a pasted file wins.)
7. **Sign in**: press **Sign in with Google** in the panel (or `ccc gmail login`). Your browser
   opens Google's sign-in: pick the account. For a personal account Google says it has not
   verified the app: it is your own app, so choose **Advanced > Go to &lt;app name&gt;**. Leave the
   Gmail box ticked on the consent page and allow. Once the browser says the sign-in is done, the
   panel fills in a few seconds.

   **"Access blocked: … has not completed the Google verification process" (Error 403
   access_denied)**: the app is still in Testing and the account you picked is not one of its test
   users (or it is a Workspace account signing in to another organisation's External app). Add the
   address under **Test users** on the Audience page, press **Publish app** there if you can, or,
   for a Workspace account, make a project inside that organisation with user type Internal.
   Google's error page never returns to the app, so after the fix press **Start over** in the panel
   (or run `ccc gmail login` again): it cancels the stuck sign-in. Starting over needs cc-cockpit
   0.9.2 or later; on 0.9.1 the stuck sign-in gives up by itself after 5 minutes.

The same file works for several projects (each signs in on its own). To stop: **Sign out** in the
panel (or `ccc gmail logout`) deletes the stored sign-in; to revoke the app at Google:
<https://myaccount.google.com/connections>.

## Settings (per project)

Settings > This project > Gmail, or from a tab: `ccc plugin config bronos.gmail <key>=<value>`
(everything but the client secret).

| Setting | Default | |
|---|---|---|
| `clientId` | | your Desktop client's ID (ends in `.apps.googleusercontent.com`); a pasted client file wins; changing it signs you out |
| `clientSecret` | | secret, Settings only; the same client's secret |
| `lanes` | all on | `unread`, `alerts`, `read`: a hidden lane is not fetched and never sent to triage |
| `rowsPerLane` | 10 | threads a lane shows; the rest behind Show all at the bottom of the lane (remembered per lane) |
| `unreadDays` | 14 | how far back Unread and Alerts look |
| `maxUnread` | 15 | the newest unread threads fetched (1 to 100); alerts do not count |
| `readDays` | 2 | how far back Read looks in the inbox |
| `maxRead` | 10 | the newest read inbox threads shown (alerts left out) |
| `alertSenders` | `[]` | addresses whose mail goes to Alerts; empty: no Alerts lane |
| `pollMinutes` | 2 | only while the project's window is open |
| `triageText` | `full` | `full` or `summary` (see Privacy) |

```sh
ccc plugin config bronos.gmail 'alertSenders=["alerts@grafana.example.com"]' pollMinutes=5
ccc plugin config bronos.gmail 'lanes={"unread":true,"alerts":true,"read":false}'
```

## Lanes

| Lane | Search |
|---|---|
| Unread | `is:unread -in:spam -in:trash newer_than:14d -from:<each alert sender>`, the newest `maxUnread` |
| Alerts | the same, `from:` the alert senders, up to 100 threads (listed apart, so an alert storm never pushes real mail out) |
| Read | `-is:unread in:inbox newer_than:2d`, the newest `maxRead` that are not alerts |

A thread found by two searches shows once (Alerts, then Unread, then Read). Gmail's copies of Google
Chat messages (`chat-noreply@google.com`) are left out. Unread is Gmail's own UNREAD label, so a
thread you read in Gmail leaves Unread with the next poll (and shows in Read while it is in the
inbox and recent).

**Alerts**: a mail from an alert sender with a subject `[FIRING…]` or `[RESOLVED…]` (Grafana) is
grouped by alert name, one row per name across its unread threads: a count, the nodes still
firing, and "resolved" when the newest message of that name is RESOLVED. Opening the row shows its
newest 10 threads. Other mail from an alert sender is a plain row in the lane.

**Polling**: every `pollMinutes` while the window is open, and with ↻ in the panel's title bar
(which also shows the last poll and the account). A poll first asks Gmail whether anything changed
since the last one (`users.history.list`, almost free); only then, or every 10th poll, it runs the
searches and reads the threads whose history changed (their headers only, 4 at a time). When Gmail
is busy (429 or 5xx) the interval doubles, up to 30 minutes, with a notice, until Gmail answers.

**Click a row** (or press Enter on it) to open the thread (see below). The other actions are small
buttons that show while the pointer is over a row or the row has the keyboard focus: **↗** (the
thread in Gmail, in this account; an alert row opens a Gmail search), the triage verdict
(**action ▾**: change how much the mail needs you; to record why, use Wrong? in the Jev triage
panel), **Discuss** (sends the thread to the Claude tab you are looking at; with several tabs and
no way to tell, you pick one) and **New** (a new Claude session about it). Keyboard: Tab to a row,
↑ / ↓ (Home / End) move between rows, Enter or Space opens, Tab goes on to the row's buttons.

## The thread view

Opening a thread reads it fresh from Gmail (`format=full`) and shows every message oldest first, as
a card: sender, address, date, To and Cc, an "unread" mark, then the body, then its attachments.
The details column has From, To, Cc, the dates, the labels, the message count and the Gmail link.

The page is built by the plugin from the mail's HTML with its own sanitizer, never shown as the
sender wrote it: only plain formatting tags are kept (paragraphs, lists, tables of data, links,
quotes, headings, code), every text is escaped, styles, scripts, forms and event attributes go,
links keep only `http(s)` and `mailto` addresses, hidden text (preheaders) is dropped, and quoted
history (Gmail, Outlook, Apple Mail, Yahoo, Proton, `>` lines) folds into a "Quoted text" section.
A mail with only a text part shows as paragraphs with its links.

**Pictures**: the page never loads anything from the web. A remote picture (an `<img>` with an
http address: often a tracking pixel that tells the sender you read the mail) is a "[image: alt]"
link, and a page with any says so; pictures of 3 pixels or less (trackers) are dropped. Pictures inside the mail (`cid:`
parts) and attached pictures are downloaded by the plugin from Gmail, inline ones first, then the
newest, within these limits:

| Limit | Value | Why |
|---|---|---|
| pictures per thread | 15 | the reviewer takes at most 30 assets |
| one picture | 700 KiB | its data URL stays under the reviewer's 1,000,000 characters |
| all pictures | 7.5 MiB of data URLs | under the reviewer's 8 MiB |
| types | PNG, JPEG, GIF, WebP | checked on the bytes, not the type the mail claims; SVG is never shown |
| waiting for downloads | 10 s an open | what is not there by then is listed by name this time |
| cache | 300 pictures, 64 MiB | in the plugin's project data folder, least recently used go first |

Other attachments are listed by name and size (no download in this version; open the mail in
Gmail for them). The page is at most 2 MB of HTML: when a long thread does not fit, the oldest
messages give way, with a line saying how many.

## CLI

```
ccc gmail status            client, account, last poll, counts per lane, errors
ccc gmail refresh           poll Gmail now and print the counts
ccc gmail list [lane]       unread, alerts, read
ccc gmail show <id>         a thread as readable text (alert:<name> for an alert group)
ccc gmail login             start the Google sign-in (the browser does the rest)
ccc gmail logout            sign out: the stored sign-in is deleted
ccc gmail client <file>     use the OAuth client file downloaded from Google Cloud
ccc gmail help
```

## Privacy

- The plugin talks to Google only: the sign-in through cc-cockpit's OAuth (your browser and
  `oauth2.googleapis.com`), the mail through `gmail.googleapis.com`. The access token is sent to
  nothing else and never follows a redirect. Tokens and the client secret are never logged, shown
  in the panel or printed by `ccc gmail`.
- The refresh token and the client secret are stored in the OS keychain (cc-cockpit's secrets
  store), under a key of this project and client. The access token stays in memory.
- With `triageText: full` (the default) the sender, recipients, subject and Gmail's snippets (the
  short preview Gmail shows in its list) of the newest message and up to 3 earlier ones of the
  threads in the shown lanes, never the full bodies, go to
  **Jev** (through jev-triage; Jev calls a model provider, see the Jev plugin) to be sorted. If your
  employer objects to mail text leaving, set `triageText` to `summary`: then only the sender and the
  subject go, or turn jev-triage off for the project.
- Discuss and New session put the thread's text into a Claude Code session, which sends it to
  Anthropic like anything else you type there.
- The plugin keeps a cache of the threads it shows (headers and snippets) and of the pictures it
  downloaded, in its project data folder, both bounded; nothing else of your mailbox is stored.
- The pictures of an opened thread go into the reviewer overlay (or the plugin's page) on your
  machine; Discuss and New session send the text, not the pictures.

## Development

Plain JavaScript, no build step and no dependencies: `dist/host.js` and `dist/lib/*.js` run as they
are. `npm test` (`node --test test/`) runs the suites (node:test, a fake Gmail and a fake Google
sign-in from recorded response shapes in `test/fixtures`; nothing reaches the network). Design:
`docs/design.md`. Where the cc-cockpit guide fell short while building it: `FRICTION.md`.

Link a checkout from a cc-cockpit tab: `ccc plugin link <folder>`; logs: `ccc plugin logs bronos.gmail`.

## License

MIT, see LICENSE.
