# Agent notes

pi extension providing `/search` — global full-text search over all pi sessions.
See README.md for usage and architecture.

## Key facts

- Zero npm dependencies. Uses `node:sqlite` (FTS5) — requires the Node pi runs on
  to be ≥ 22. TypeScript is loaded by pi via jiti; no build step.
- Installed by symlink: `~/.pi/agent/extensions/session-search -> ./extension`.
  After edits, run `/reload` in pi to pick up changes.
- Index DB: `~/.pi/agent/session-search/index.db`. Safe to delete anytime
  (rebuilt on next `/search`). Schema changes: bump `SCHEMA_VERSION` in
  `extension/indexer.ts` — old data is dropped automatically.
- Session file format: see pi docs `docs/session-format.md`
  (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`).
- Cross-project open uses `ctx.switchSession(path)`; pi rebinds cwd/tools/trust
  to the session's stored cwd. Missing-directory errors are caught and shown.

## Testing

- `node test/smoke.ts [query]` — indexes real `~/.pi/agent/sessions` into a temp
  DB, checks incremental sync is a no-op, prints top hits. No pi required.
- Manual: run `pi` anywhere and use `/search`.
