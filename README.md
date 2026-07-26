# pi-session-search

Centralized full-text search over **all** pi sessions, from any pi session.

pi stores sessions per-project under `~/.pi/agent/sessions/--<escaped-cwd>--/*.jsonl`,
and the built-in `/resume` only sees the current project. This extension indexes
every session across every project and exposes a `/session-search` command that can open
any result in place — pi rebinds cwd, tools, trust, and project config to the
session's original directory, so it behaves exactly like resuming from that folder.

## Usage

```
/session-search [query]             open the live search panel (optionally prefilled)
/session-search "exact phrase" word quoted phrases + AND'd terms (FTS5 syntax-safe)
/session-search --rebuild           drop and rebuild the index first
```

The panel searches on **every keystroke**; words match as prefixes while you
type (`sess sear` finds "session search"), quoted phrases match exactly. An
empty query shows the most recent sessions.

Keys:

- type — refine the search
- `↑`/`↓` (or `Ctrl+P`/`Ctrl+N`) — navigate results
- `Enter` — open the session in the current pi (cross-project resume)
- `Tab` — copy `cd <dir> && pi --session <file>` to the clipboard for a new terminal
- `Esc` — cancel

## Install

As a pi package (recommended — works for git remotes and local checkouts):

```bash
pi install git:github.com/slim-bean/pi-session-search   # from the git remote
pi install /path/to/pi-session-search                 # from a local checkout
```

That records the source in `~/.pi/agent/settings.json`; a hand-written entry
works the same, with paths resolved relative to the settings file:

```json
{ "packages": ["../../projects/pi-session-search"] }
```

A local path is loaded in place, so edits apply on the next `/reload` — no
reinstall needed. `pi list` shows what is configured.

Alternatively, symlink the `extension/` directory into pi's global extensions
dir. Pick one mechanism, not both, or the command loads twice as
`/session-search:1` and `/session-search:2`:

```bash
ln -sfn "$(pwd)/extension" ~/.pi/agent/extensions/session-search
```

Then `/reload` (or restart pi). No npm install needed — zero runtime dependencies.

## How it works

- **Index**: SQLite with FTS5 (built into `node:sqlite`, Node ≥ 22) at
  `~/.pi/agent/session-search/index.db`.
- **What's indexed**: user messages, assistant text, extension messages,
  compaction/branch summaries, session names, and the session's folder path.
  Tool output and thinking blocks are excluded to keep the index small.
- **Incremental sync**: on each `/session-search`, files are compared by mtime + size and
  only changed sessions are re-parsed. Full build of ~270 sessions (~200MB) takes
  ~2s; subsequent syncs are milliseconds.
- **Ranking**: BM25 per chunk, grouped by session (best chunk wins), with
  highlighted snippets built in JS around the first match.
- **Live typing**: FTS5 prefix indexes (`prefix='2 3 4'`) keep worst-case
  keystroke latency around ~60ms even for very common short tokens.

## Layout

```
extension/
  index.ts     extension entry: /session-search command + results picker UI
  indexer.ts   SQLite FTS5 schema, session JSONL parsing, incremental sync
  search.ts    MATCH query building + grouped BM25 search
test/
  smoke.ts     indexes real sessions into a temp DB and runs sample queries
               (node test/smoke.ts [query])
  panel.ts     unit tests for query building, snippets, results list, and the
               live panel key handling (node test/panel.ts)
```

## Roadmap

- **Phase 2 — LLM re-ranking**: for fuzzy queries ("that session where I debugged
  the flaky CI thing"), feed the top ~30 FTS candidates as compact digests to a
  fast model via pi's model registry, re-rank, and annotate why each matches.
- Possible later: embeddings, date/project filters (`in:daas`, `after:2026-06`).
