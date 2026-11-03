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

- **Uninstall deletes `ctx.secrets` but keeps `ctx.storage`.** Noted (documented in `api`).
  A reinstall finds the pasted client's id in storage without its secret. Did: the panel and
  `ccc gmail status` say the secret is gone and to paste the file again; the stale record is
  replaced or removed.

## Tooling

- **`cli` / `dev-loop`: no way to check a plugin folder without linking it.** Open.
  Needed: validate the manifest and the settings schema (no regex keywords, the secret field's
  rules) before linking into the running app. Guide: `ccc plugin list` shows why a linked plugin is
  invalid; nothing checks an unlinked folder. Did: bundled the app's `src/main/plugins/validate.ts`
  (`loadManifest`, `compileSettingsSchema`, `validateSettings`) with the app repo's esbuild into a
  scratch script and ran it on this folder; `test/manifest.test.js` repeats the rules that matter.
  Would help: `ccc plugin validate <dir>` (works with the app closed, like `ccc guide`).
