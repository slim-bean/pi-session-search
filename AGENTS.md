# Agent notes

pi package: `/session-search` live picker plus `session_search`, `session_read`,
and explicit `session_summarize` tools. Read README.md for the public contract.

## Invariants and architecture

- No third-party runtime dependencies/build step. `node:sqlite` FTS5 requires
  Node ≥22.13. pi injects optional peer packages through loader aliases.
  Keep peers **optional** or npm installs a second, unused pi tree.
- Keep code Node strip-types compatible: no parameter properties/enums;
  relative imports use explicit `.ts` extensions.
- `session-file.ts` owns JSONL parsing: every successfully parsed line after
  the header counts, including unknown/null entries; corrupt lines don't.
  Reader, index, and summary references must share these original ordinals.
  Filtered views never renumber. Tests assert both ordinals and fingerprints.
- Index user/assistant **text blocks**, extension messages, pi compaction/
  branch summaries, and metadata. Never thinking/tool calls/results/images.
  No truncation of indexed text. All branches are retained, not just the leaf.
- `reader.ts` renders full content; `visibleEntries` projects conversation
  text/roles. Public `session_read` defaults to conversation; internal formatter
  helpers retain full-view defaults for standalone callers. Offset pagination
  counts visible records, not original entry indices. Character offsets use
  UTF-16 in the chosen view.
- `search.ts`: query terms match within one entry, not across a session.
  Quotes are adjacent **stemmed** tokens, not byte-exact phrases. `anyOf`
  alternatives are OR'd, AND'd with the base query. Project filters are cwd
  metadata constraints, independent of text. Activity dates are message times,
  not filesystem mtimes. Current session exclusion is a tool default only.
- `index.ts` shares one lazily created `SessionIndex`; tools live in `tools.ts`
  and `summarize-tool.ts`,
  picker in `panel.ts`. Syncs are coalesced. Shutdown aborts generation and
  waits for a yielding sync before closing SQLite.
- All LLM-facing output belongs in `format.ts`. Preserve budgets, counts,
  source labels, explicit scope, and usable pagination/continuation hints.
  No-match results must not claim the conversation never occurred.

## Summary safety/lifecycle

- Search/read/plan NEVER invoke a model. Explicit `session_summarize`
  `action:calibrate|generate` or a trusted `pi-session-search:maintenance:v1` host
  run request do, via `summary-model.ts`. The optional maintenance adapter
  shares the engine/cache, processes one section at concurrency 1, reports usage,
  checks sourceHash, and cancels on foreground input. Host consent is separate
  from the model tool's explicit-user-request rules:
  `ctx.modelRegistry.streamSimple(...).result()` with `reasoning` clamped by
  pi-ai `clampThinkingLevel`. Never pass provider-specific options through
  `complete()`: Anthropic ignores `reasoningEffort`, and managed-effort Claude
  models then default to effort "high" inside the output ceiling.
- Summarizer receives user/assistant text only, no tools or thinking. Historical
  text is untrusted data; no tools are supplied to the nested model.
- Sections cover every conversation character without sampling. Oversized
  entries have exact source spans. `parseSummary` repairs (trim, snap in-range
  refs to visible entries, drop bad refs/topics) and records each repair; it
  rejects only when no usable topic remains, with a specific reason. Stored
  refs must always be visible entries of that section.
  Valid refs do not establish factual accuracy—verify original evidence.
- Cache keys include session path, source-section fingerprint, model key
  (`provider/id@reasoning`), and `SUMMARY_VERSION`. Section hashes alone are
  not unique across sessions; select/compare by path + hash.
  Changing prompt/schema/segmentation semantics requires bumping that version.
  Only complete manifests matching the indexed conversation hash/version
  enter FTS. Sync also purges version-stale generated rows even if files didn't
  change. Check the source again before publishing after async model work.
- `runSummaries` is the single engine (one session or a scope): bounded
  concurrency, call cap, approximate cost ceiling (learn one call's cost
  before fanning out), skip-and-log failed sections, stop after 5 consecutive
  failures. Persist sections as they succeed; propagate cancellation and
  provider deadlines; report nested usage even after partial failure.
- `summary_calls` logs every billed, non-aborted attempt (no text) and drives
  calibrated estimates; it survives session deletion (it's accounting).
  Calibration caches sample sections but never publishes or replaces a
  published summary.
  Do not prune other model/version caches during publication: another pi
  process could be generating them. Deleting a session cleans all its caches.
- Source session files are never modified. Derived data is private, local,
  rebuildable SQLite state. `--rebuild` preserves summary caches; deleting the
  database discards them. Increment `SCHEMA_VERSION` for lexical schema changes.

## Installation and testing

Installed locally via `"../../projects/pi-extensions/pi-session-search"` in
`~/.pi/agent/settings.json` packages (relative to that file). Never also install
an extensions-dir symlink. `/reload` picks up changes; reload other running
pi instances after shared database schema changes too.

Database: `~/.pi/agent/session-search/index.db`; session root:
`~/.pi/agent/sessions`. Both honor `PI_CODING_AGENT_DIR`.

- `npm test` — search/reader/summary/picker/tool integration fixtures; fake
  model registry, no API calls or writes to real history.
- `node test/smoke.ts [query]` — real history in a throwaway DB; incremental
  sync and query timings. Live sessions can change during the no-op probe.
- Standalone tests use Node ≥22.18 and peer symlinks in `node_modules`:
  `@earendil-works/{pi-ai,pi-coding-agent,pi-tui}` and `typebox`.
- `test/EVALUATION.md` describes the separate frontier-model retrieval eval.
- Manual: `/reload`, `/session-search`, then exercise the tools through pi.

**SQLite quirk:** `WHERE chunks MATCH ? AND rowid = ?` can ignore the rowid
constraint in node:sqlite. Keep snippets as plain rowid text lookups after
FTS candidate selection. No per-session FTS `snippet()` calls. Don't restore
an arbitrary global candidate limit: it starves later result pages. Keep the
ranked candidate scan ordered by `rank` alone so FTS can stream results.

Session/API docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
(`session-format.md`, `extensions.md`, `tui.md`, `packages.md`). Cross-project
open uses `ctx.switchSession`; only use the replacement context after switching.
