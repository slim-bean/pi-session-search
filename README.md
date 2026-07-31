# pi-session-search

Centralized full-text search over **all** pi sessions, from any pi session.

pi stores sessions per-project under `~/.pi/agent/sessions/--<escaped-cwd>--/*.jsonl`,
and the built-in `/resume` only sees the current project. This extension indexes
every session across every project and exposes:

- `/session-search` — a live search panel that can open any result in place —
  pi rebinds cwd, tools, trust, and project config to the session's original
  directory, so it behaves exactly like resuming from that folder.
- `session_search` — a tool the LLM can call to find past sessions ("what did
  we decide about X last week?") without opening the panel.
- `session_read` — a tool the LLM can call to examine one session found via
  `session_search`: outline, read entry ranges, or search inside it — without
  ever pulling a whole (potentially multi-MB) session into context.

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

### `session_search` tool

The LLM can search sessions itself: terms are AND'd and stemmed, `"quoted
phrases"` match exactly, an empty query lists the most recent sessions.
Results include the project directory, highlighted snippets labelled with
entry `#indices`, and a `cd <dir> && pi --session <file>` resume command the
model can hand back to you. The index is synced incrementally before every
call, same as the panel.

### `session_read` tool

Sessions can be enormous (multi-MB, thousands of messages), so `session_read`
exposes one session at three depths instead of dumping it:

1. **Overview** (default) — metadata plus a paginated outline: one line per
   entry with `#index`, kind (`user`, `assistant`, `tool:bash`, `compaction`,
   …), size, and a one-line preview.
2. **Targeted read** — `entries:"40-45,52"` returns the full text of those
   entries, *including tool calls, tool output, and thinking* (which the
   search index deliberately excludes), under a `maxChars` budget with
   continuation hints (`offsetChars` resumes inside a single huge entry).
3. **In-session search** — `query:"…"` scans the full rendered text of every
   entry (tool output included) and returns matching `#indices` + snippets.

Entry `#indices` line up with the labels on `session_search` snippets, so the
typical flow is: `session_search` → `session_read` with `entries` around a
snippet's `#index`.

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
- **Entry ordinals**: the index stores each chunk's entry ordinal
  (`chunks.entry_index`), counted identically by the indexer and the reader,
  so search snippets and `session_read` share one `#index` numbering.
- **Live typing**: FTS5 prefix indexes (`prefix='2 3 4'`) keep worst-case
  keystroke latency around ~60ms even for very common short tokens.

## Layout

```
extension/
  index.ts     extension entry: session_search + session_read tools,
               /session-search command + picker UI
  indexer.ts   SQLite FTS5 schema, session JSONL parsing, incremental sync
  search.ts    MATCH query building + grouped BM25 search
  reader.ts    full session parsing for session_read (tool calls/output,
               thinking); entry ordinals aligned with the index
  format.ts    shared helpers + compact tool output for the LLM
test/
  smoke.ts     indexes real sessions into a temp DB and runs sample queries
               (node test/smoke.ts [query])
  panel.ts     unit tests for query building, snippets, tool output formatting,
               results list, and live panel key handling (node test/panel.ts)
  reader.ts    unit tests for the session reader, entry ranges, budgets, and
               indexer/reader ordinal alignment (node test/reader.ts)
```

## Roadmap

- **Phase 2 — LLM re-ranking**: for fuzzy queries ("that session where I debugged
  the flaky CI thing"), feed the top ~30 FTS candidates as compact digests to a
  fast model via pi's model registry, re-rank, and annotate why each matches.
- Possible later: embeddings, date/project filters (`in:daas`, `after:2026-06`).
