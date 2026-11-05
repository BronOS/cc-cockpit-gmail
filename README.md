# Gmail for cc-cockpit

`bronos.gmail` shows your Gmail in a cc-cockpit panel, in lanes, sorted by
[Jev triage](https://github.com/BronOS/cc-cockpit-jev-triage), and hands a thread to Claude to
discuss, and marks threads read or unread. **The plugin never archives, labels, trashes or sends**:
the only change it makes in your mailbox is Gmail's UNREAD label (mark read, mark unread), in one
function that can do nothing else. Since 0.3.0 it asks Google for `gmail.modify` for that (see
"Mark read and unread").

- **Lanes**: Unread, Alerts (mail from the addresses you list, Grafana alerts grouped by alert
  name) and Read (the inbox of the last days). Choose which ones in the settings.
- **Triage**: each lane is sorted by priority (urgent, action, fyi, noise), then the newest
  message. Alert groups are noise by the plugin's own hint; the rest is judged by Jev through
  jev-triage.
- **Discuss with Claude**: click a row and the thread opens in the reviewer overlay as a clean
  page (every message as a card, its pictures, its attachments listed), where you select text to
  add notes and press Discuss (the Claude tab you are looking at) or New session.
- **Mark read / Mark unread** (0.3.0): a button on each row; opening a thread leaves it unread
  unless you turn on `markReadOnOpen` (then it is marked read, as Gmail does).
- **Jira mail** (0.2.0, with the [Jira plugin](https://github.com/BronOS/cc-cockpit-jira) enabled in
  the project): a mail from Jira gets triage hints from the issue's real status, and opening it shows
  the issue beside the mail (see "Jira mail").
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
- **Optional: the Jira plugin (`bronos.jira` 0.5.0 or later)** for the Jira mail features. Without it
  (or with it off or not configured in the project) everything works as before.
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
   for Gmail API, tick `.../auth/gmail.modify` ("Read, compose, and send emails from your Gmail
   account": Google's words for the scope; the plugin uses it only to mark mail read or unread, and
   never archives, labels, trashes or sends), Update, Save. Nothing else is needed. Google files
   gmail.modify as **restricted**, like gmail.readonly: with user type **Internal** there is no
   verification; an **External** app **In production** shows Google's unverified-app screen once at
   sign-in (step 7). Set up with 0.1.0 or 0.2.0? Your client has `.../auth/gmail.readonly` ticked:
   tick `.../auth/gmail.modify` as well (or instead), then Sign in again (see "Mark read and
   unread").
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
   Gmail box ticked on the consent page and allow (unticked, the plugin can read but not mark mail
   read, and the panel asks to sign in again). Once the browser says the sign-in is done, the
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

**Uninstalling and installing again** (or switching from a linked copy to the Marketplace one):
cc-cockpit deletes a plugin's keychain entries when it is uninstalled, on purpose, so the Google
sign-in is gone and you press **Sign in with Google** once more; the panel says why. Since 0.2.0 a
pasted client file is kept with the plugin's project storage, which an uninstall keeps, so you do
not paste it again (a client from 0.1.0 is moved there the first time 0.2.0 starts; one already
lost to an uninstall under 0.1.0 has to be pasted once more). A client secret entered in the
settings field is a keychain entry too and goes with an uninstall.

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
| `markReadOnOpen` | `false` | on: opening a thread from the panel marks it read in Gmail (an alert row: the threads it shows); off (the default since 0.4.0): it stays unread until you press Mark read |

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
inbox and recent); one you mark read here moves at once.

**Alerts**: a mail from an alert sender with a subject `[FIRING…]` or `[RESOLVED…]` (Grafana) is
grouped by alert name, one row per name across its unread threads: a count, the nodes still
firing, and "resolved" when the newest message of that name is RESOLVED. Opening the row shows its
newest 10 threads. Other mail from an alert sender is a plain row in the lane.

**Polling**: every `pollMinutes` while the window is open, and with ↻ in the panel's title bar
(which also shows the last poll and the account). A poll first asks Gmail whether anything changed
since the last one (`users.history.list`, almost free); only then, or every 10th poll, it runs the
searches and reads the threads whose history changed (their headers only, 4 at a time). When Gmail
is busy (429 or 5xx) the interval doubles, up to 30 minutes, with a notice, until Gmail answers.

**Click a row** (or press Enter on it) to open the thread (see below; with `markReadOnOpen` on, it is
marked read; by default it stays unread). The other actions are small buttons that show while the pointer is
over a row or the row has the keyboard focus: **↗** (the thread in Gmail, in this account; an alert
row opens a Gmail search), **Mark read** / **Mark unread** (see "Mark read and unread"), the triage verdict
(**action ▾**: change how much the mail needs you; to record why, use Wrong? in the Jev triage
panel), **Discuss** (sends the thread to the Claude tab you are looking at; with several tabs and
no way to tell, you pick one) and **New** (a new Claude session about it). Keyboard: Tab to a row,
↑ / ↓ (Home / End) move between rows, Enter or Space opens, Tab goes on to the row's buttons.

## Mark read and unread

The only change the plugin makes in Gmail. **The plugin never archives, labels, trashes or sends**:
its one write call (`threads.modify`) adds or removes the UNREAD label and nothing else, built from
a yes/no in one function, so no other label change is possible.

- **Mark read** on a row of Unread or Alerts (an alert group: all of its unread threads), **Mark
  unread** on a row of Read. The row moves at once; if Gmail refuses, it moves back and the panel
  says why.
- **Opening a thread** from the panel marks it read (an alert row: the threads it shows) only when the
  project setting `markReadOnOpen` is on (off by default). Discuss, New session and `ccc gmail show` do not.
- `ccc gmail read <threadId>` and `ccc gmail unread <threadId>` (`read alert:<name>`: the group).
- A whole thread changes: Mark unread makes every message of the thread unread.
- At most 4 changes at once and 120 a minute (an alert group of 100 threads fits in one); more wait.

**Signed in with 0.1.0 or 0.2.0?** That sign-in only allows reading (`gmail.readonly`). Everything
keeps working as before, and the panel shows **Sign in again to allow marking mail read** with **Sign in
again** (and **Not now**, which hides it until you press Mark read). First tick
`.../auth/gmail.modify` on your client's Data access page (setup step 4), then press Sign in again
and leave the Gmail box ticked; the same Google account keeps its lanes and triage. The same
prompt shows when Google refuses the first change for the scope (the Gmail box was unticked).

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

## Jira mail

With the Jira plugin (`bronos.jira` 0.5.0+) enabled and configured in the same project, the Gmail
plugin asks it, through its `jira` service, which addresses Jira mails come from (`jira@<your site's
host>`, or the Jira plugin's `mailSenders` setting) and what an issue's status is now. Nothing here
talks to Jira itself, and nothing needs setting up in the Gmail plugin.

- **Which mail**: a message from one of those addresses. Its issue is the first issue key in the
  subject (`ABC-123`), else the first link to `<your site>/browse/ABC-123` in the mail.
- **Triage hints**, for an unread thread, judged on its new messages:

  | When | Then |
  |---|---|
  | every new message is Jira's and only moves the issue ("moved a work item") | noise: the Jira panel ranks the issue by its real status |
  | a new Jira message is about an issue that is Done now | fyi: even a mention there is to read, not to do |
  | every new message is Jira's and only mentions you on, or creates, an open issue assigned to you | at least action (Jev may say urgent) |
  | anything else | Jev decides, as for any mail |

  The issue key also goes to jev-triage as the field `jira`, for rules. The status is looked up
  (at most 10 issues a poll, cached for 10 minutes, asked again when a newer mail about the issue
  arrives); a poll waits at most 4 s for those answers, and a row whose answer comes later is
  judged again then.
- **The thread view**: with cc-cockpit 0.9.3 or later, the issue as the Jira plugin shows it
  (description, comments, attachments and their pictures) opens **beside the mail**: two columns,
  the mail left and the issue right, each scrolling on its own under a header row that stays put:
  **Mail** with an **Open in Gmail ↗** button, **Jira · ABC-123** with **Open in Jira ↗**, and each
  one's key fields (the issue's status, priority, assignee); a divider you can drag, the issue below
  the mail when the overlay is narrow. Notes go on either, and Claude is told which one each is about. With an
  older reviewer, the issue is a **Jira issue ABC-123** section below the mail instead, with its
  status, priority and assignee added to the details column (at most 800 KB of the page there).
  The pictures are one budget in the reviewer either way (the issue: 7 pictures, the mail: 8).
  When the issue cannot be shown (Jira unreachable, slow past 15 s, busy), the mail shows alone
  with a short note.

## Inbox

Since 0.5.0 the plugin provides the `inbox-feed` service (v2) for the Inbox plugin, which merges
Chat, Mail, Jira and more into one list and applies its own rules. The feed is the plugin's scope:
the **unread and read threads of the last days** (the Unread lane's days, the Read lane's days
and cap; the lanes you switched off are not in it) and the **alert threads**, each its own item
(an alert group is a panel idea). Each item carries what rules can use: subject, a preview, the
lead sender, whether you are in To or Cc, read or unread, the Inbox folder, labels (your Gmail
label names, `important`, `starred`, `category:updates`, `alert`, `alert:<name>`, `jira:ABC-12`)
and the actions open, mark read / mark unread. The triage verdicts of the panel stay in the panel.
It is built from the threads the panel already holds, never with a Gmail call. The plugin tells
Inbox what changed after each poll and each mark (an `item` per changed thread, `gone` for a
thread that left the scope) and sends the whole list when it starts, after a sign-in and after an
error is over. Inbox can open a thread (the same as a click on its row) and mark it read or
unread (the same write as Mark read). The panel's footer shows the scope line Inbox sees. Nothing
leaves your machine: the data goes to another plugin of the same project. Inbox 0.2.0 reads v2; an
older Inbox (v1) no longer gets Mail from this version. Providing needs no newer app; Inbox 0.2.0 itself
needs cc-cockpit 0.10.0, and the toolbar buttons below need an app with `ctx.overlay.buttons` (0.10).

**Thread overlays.** A thread opens with the overlay type `inbox-item { source: "bronos.gmail", id }`
(the reviewer gets it in `prepare` and `annotate`; our own reader page starts at once with
`ready: 'manual'`, before the thread is read, and drops its loader once the mail is drawn). On an app
that has `ctx.overlay.buttons`, the overlay of one of this plugin's own threads gets Mark read / Mark
unread in its toolbar (the same code as the feed's `act`; a Gmail error shows in the panel's notice),
and the reader page's Discuss with Claude sends the subject, sender and snippet. Only a thread still in
the feed gets the buttons: one that left it (no longer in the Unread or Read lanes, e.g. read and older than `readDays`) has none. Only an overlay this plugin or the bundled reviewer (`cockpit.reviewer`) opened gets them (the app's
`opener`, not the overlay's data): another plugin opening an overlay that names one of our threads gets none. An alert row
has no type.

## CLI

```
ccc gmail status            client, account, last poll, counts per lane, mark read on/off, Jira mail on/off, errors
ccc gmail refresh           poll Gmail now and print the counts
ccc gmail list [lane]       unread, alerts, read
ccc gmail show <id>         a thread as readable text (alert:<name> for an alert group)
ccc gmail read <id>         mark a thread read in Gmail (alert:<name>: all of the alert's unread threads)
ccc gmail unread <id>       mark a thread unread in Gmail
ccc gmail login             start the Google sign-in (the browser does the rest)
ccc gmail logout            sign out: the stored sign-in is deleted
ccc gmail client <file>     use the OAuth client file downloaded from Google Cloud
ccc gmail help
```

## Privacy

- The plugin talks to Google only: the sign-in through cc-cockpit's OAuth (your browser and
  `oauth2.googleapis.com`), the mail through `gmail.googleapis.com`. The scope `gmail.modify` would
  let an app change much more; this plugin uses it only for the UNREAD label (see "Mark read and
  unread"), and you can revoke it at <https://myaccount.google.com/connections>. The access token is sent to
  nothing else and never follows a redirect. Tokens and the client secret are never logged, shown
  in the panel or printed by `ccc gmail`.
- The refresh token is stored in the OS keychain (cc-cockpit's secrets store), under a key of this
  project and client. The access token stays in memory. A pasted client file (its id and secret)
  is kept in the plugin's storage for this project, a file only your user can read: Google does not
  treat a Desktop app client's secret as confidential (an installed app cannot keep one), and kept
  there it survives a reinstall. A client secret entered in the settings stays in the keychain.
- With the Jira plugin: issue keys go to it (on this machine) for their status; the issue text it
  sends back is shown in the thread view, and is not sent to triage.
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
