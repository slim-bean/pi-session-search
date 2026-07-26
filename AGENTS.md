# Agent notes

pi extension providing `/session-search` — global full-text search over all pi sessions.
See README.md for usage and architecture.

## Key facts

- Zero npm dependencies. Uses `node:sqlite` (FTS5) — requires the Node pi runs on
  to be ≥ 22. TypeScript is loaded by pi via jiti; no build step.
- Installable as a pi package (`package.json` has the `pi` manifest pointing at
  `./extension/index.ts`; pi deps are `peerDependencies` marked `optional` in
  `peerDependenciesMeta`, per docs/packages.md — pi injects them via loader
  aliases, and without the `optional` marker npm ≥ 7 auto-installs a second,
  unused pi tree (~300 MB) on every `pi install git:`).
  **Currently installed as a local package**: `"../../projects/pi-session-search"`
  in `~/.pi/agent/settings.json` `packages` (paths resolve relative to that
  file), loaded in place. A symlink in `~/.pi/agent/extensions/` is the
  alternative — never both, or the command becomes `/session-search:1` and
  `/session-search:2`. After edits, run `/reload` in pi to pick up changes.
- Index DB: `~/.pi/agent/session-search/index.db`. Safe to delete anytime
  (rebuilt on next `/session-search`). Schema changes: bump `SCHEMA_VERSION` in
  `extension/indexer.ts` — old data is dropped automatically.
- Session file format: see pi docs `docs/session-format.md`
  (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`).
- Cross-project open uses `ctx.switchSession(path)`; pi rebinds cwd/tools/trust
  to the session's stored cwd. Missing-directory errors are caught and shown.

- `node:sqlite` quirk: `WHERE chunks MATCH ? AND rowid = ?` mis-plans (ignores
  the rowid constraint). Snippets are therefore built in JS from plain rowid
  text lookups — do not reintroduce FTS `snippet()` per session.
- Search runs synchronously on every keystroke; FTS prefix indexes
  (`prefix='2 3 4'`) keep worst-case latency ~60ms. Re-measure with
  `test/smoke.ts` if changing the schema or query shape.
- Extension code must stay Node strip-types compatible (no parameter
  properties/enums) so tests run with plain `node`; relative imports need
  explicit `.ts` extensions.

## Testing

- `node test/smoke.ts [query]` — indexes real `~/.pi/agent/sessions` into a temp
  DB, checks incremental sync is a no-op, prints top hits. No pi required.
- `node test/panel.ts` — unit tests: match-query building, JS snippets, results
  list rendering, live panel keystroke handling. Needs the
  `node_modules/@earendil-works` symlinks (pi-coding-agent, pi-tui) to resolve
  pi imports outside pi.
- Manual: run `pi` anywhere and use `/session-search`.
