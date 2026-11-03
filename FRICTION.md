# Friction log

Each entry is one place where the cc-cockpit guide (`ccc guide`, every topic, `ccc guide types`, and
`ccc help`) was not enough, was ambiguous, or an API was missing, found while building
`bronos.gmail` against cc-cockpit 0.9.1 on 2026-11-03. Format: what I needed, what the guide says,
what I did instead. Status: **Open** unless marked.

Known gaps already reported in bronos.jira's and bronos.jev-triage's FRICTION.md, only referenced
here: panels cannot submit a `<form>` (buttons throughout); no host test kit (this repo has its own
fake ctx in `test/fakes.js`); a consumer cannot tell "the provider has no such method" from "the
method failed" except by the rejection's text (`isMissingAnnotate`, `dist/lib/actions.js`), and the
same for the reviewer refusing the HTML mode (the plugin falls back to text and remembers it).

## Sign-in

- **`api`: no project id for per-project secrets.** Open.
  Needed: one Google account per project (design), with the refresh token in `ctx.secrets`.
  Guide: secrets are app-wide; "for per-project sign-ins name keys yourself (`google:work`) and let
  a project setting pick one". A setting the person has to fill in is one more setup step, and two
  projects that pick the same name share a sign-in without knowing. `ctx.dataDir` and the log
  lines contain a `<projectId>`, but the guide says not to derive anything from the layout, and
  `ctx.projectDir` changes when the folder moves. Did: a random 12-hex key made once and kept in
  `ctx.storage` (`projectKey`), keys `refresh:<projectKey>:<sha256(clientId) 12>` and
  `client:<projectKey>:<...>` (`dist/lib/auth.js`). Would help: `ctx.projectId`.

- **`types`: `invalid_grant` is only in the rejection's text.** Open.
  Needed: tell "Google revoked the sign-in" (sign out, say why) from "the network is down" (keep
  the sign-in, retry). Guide: `refresh` says "`invalid_grant` in the error: sign in again". Did:
  match `\binvalid_grant\b` in the message (`isInvalidGrant`). Would help: a `code` on the error
  (`invalid_grant`, `network`, `rate`).

- **`types`: a pending `authorize` cannot be cancelled by the plugin.** Open.
  Needed: the person signs out, removes the pasted client or saves another client id while the
  browser sign-in is still open. Guide: a pending one is cancelled only when the host stops or the
  window closes; another `authorize` rejects meanwhile. Did: when the sign-in finishes, the tokens
  are thrown away if the client changed in between ("sign in again"), and the panel and `ccc gmail
  login` say a sign-in is already open (it gives up after 5 minutes). Would help: an `AbortSignal`
  in `authorize`.

- **Uninstall deletes `ctx.secrets` but keeps `ctx.storage`.** Worked around in 0.2.0 (by design in the app).
  Found in real use (2026-11-03): after an uninstall and a Marketplace install the pasted client and
  the sign-in were gone. The cause is not the project key (`projectKey` is in `ctx.storage`, which an
  uninstall keeps, and it is per project already: nothing in `ctx` is steadier, since `ctx.storage`
  and `ctx.dataDir` both follow the app's project id and `ctx.projectDir` is the folder path) but the
  app deleting every `ctx.secrets` key of the plugin on uninstall (`installer.ts`: no credential
  outlives the plugin), the 0.1.0 client secret and the refresh token with them. A secret settings
  field (`clientSecret`) goes the same way. Did: the pasted client (id and secret) is kept in
  `ctx.storage` since 0.2.0 (a Desktop app client's secret is not confidential in Google's own terms;
  0.1.0's keychain copy is moved on load), so it survives; the refresh token stays in `ctx.secrets`
  and cannot survive, so a storage marker lets the panel say "the sign-in is gone, sign in again"
  after a reinstall. Would help: the guide saying that a reinstall needs a new sign-in by design, or
  an uninstall option "keep this plugin's secrets" for a reinstall or an update by hand.

## Tooling

- **`cli` / `dev-loop`: no way to check a plugin folder without linking it.** Open.
  Needed: validate the manifest and the settings schema (no regex keywords, the secret field's
  rules) before linking into the running app. Guide: `ccc plugin list` shows why a linked plugin is
  invalid; nothing checks an unlinked folder. Did: bundled the app's `src/main/plugins/validate.ts`
  (`loadManifest`, `compileSettingsSchema`, `validateSettings`) with the app repo's esbuild into a
  scratch script and ran it on this folder; `test/manifest.test.js` repeats the rules that matter.
  Would help: `ccc plugin validate <dir>` (works with the app closed, like `ccc guide`).

## Jira mail (0.2.0, the bronos.jira `jira` service), 2026-11-03

- **`api`: a service call cannot be cancelled, and has no timeout.** Open (also in bronos.jira's FRICTION.md).
  Needed: a poll that never waits long for Jira, and a thread view that opens even when the Jira
  plugin is slow. Guide: "No timeout: race your own"; an `AbortSignal` is not plain data. Did: every
  call is raced (2 s for `site()`, 4 s for a round of lookups, 15 s for the issue below the mail); a
  lookup that lands late re-judges its rows; the provider's work goes on unseen after a race is lost.

- **`api`: no event when the provider's answers change.** Noted.
  Needed: re-judge a Jira mail when its issue moves to Done. Did: the lookups have a TTL (10 min) and
  are asked again when a newer mail about the issue arrives (a status change sends one); the
  service has no events in v1.

- **`reviewer`: the issue could only go below the mail.** Fixed in cc-cockpit 0.9.3 (annotate's
  `companion` and `features()`). Needed: read the mail and its issue side by side, notes on both.
  Did: the issue goes beside the mail when `features()` lists `companion`, below it otherwise.

## Mark read (0.3.0, gmail.modify), 2026-11-03

- **`types`: `OAuthTokens` has no `scope`: a plugin cannot see what the person granted.** Open.
  Needed: tell a sign-in that can write (gmail.modify) from one that only reads (a 0.2.0 sign-in
  with gmail.readonly, or Google's granular consent with the Gmail box unticked), to ask for a new
  sign-in before a write fails. Guide: `OAuthTokens` is `{ accessToken, refreshToken, expiresAt }`;
  the app's token parser (`src/main/oauth/oauth.ts`) drops the response's `scope` (RFC 6749 §5.1).
  Did: a `scope` in the plugin's own `signedIn` storage marker (none = a 0.2.0 sign-in, read-only),
  a 0.3.0 sign-in taken as granted until the first write gets 403 insufficientPermissions, and
  `scope` read from the tokens should an app pass it (`grantedScope`, `dist/lib/oauth-client.js`).
  Would help: `scope?: string` (the granted scopes, as the provider sent them) in `OAuthTokens`
  from `authorize` and `refresh`.
