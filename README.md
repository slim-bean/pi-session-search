# pi-session-search

Search and read **all your local pi conversations**, across projects. Designed
for a frontier model to investigate history using scoped keyword searches,
compact evidence, and optional, inspectable topic summaries—not vectors.

- `/session-search` — instant prefix-search picker; open a session or copy its
  resume command.
- `session_search` — lexical search, session browsing, and project discovery.
- `session_read` — conversation text, context around a hit, full forensic
  entries, or cached topic summaries.
- `session_summarize` — explicitly plan/generate cached topic summaries.
  **Only generation makes additional model calls.**

## Install

```bash
pi install git:github.com/slim-bean/pi-session-search
# or, for development:
pi install /path/to/pi-session-search
```

Node ≥22.13 with `node:sqlite` is required. No third-party runtime dependencies
or build step; pi provides its peer packages and loads TypeScript.

A local installation loads files in place. Run `/reload` after edits. Don't
also symlink the extension into `~/.pi/agent/extensions/`, or it loads twice.
Local package paths in `~/.pi/agent/settings.json` resolve relative to that file:

```json
{ "packages": ["../../projects/pi-session-search"] }
```

**Upgrading from 0.2:** the index rebuilds automatically on first search.
`session_read` now defaults to conversation-only text; request `view:"full"`
for the previous behavior. Reload other running pi sessions using this
extension too, so they don't access the shared database with the old schema.

## Search and discovery

These examples are tool arguments (ask pi to make the calls):

```js
// Find the project first, without guessing conversation vocabulary.
session_search({ group: "projects", limit: 20 })

// Alternative terminology, restricted independently to this project's sessions.
session_search({
  project: "current",
  anyOf: ['"semantic search"', "embedding", "reranking"],
  limit: 5
})

// What the user said during a particular period—not when the session began.
session_search({
  query: "index",
  roles: ["user"],
  since: "2026-07-01", until: "2026-07-31", dateField: "message"
})

// Browse session metadata and available summary previews.
session_search({ project: "/path/to/project", snippets: 0, offset: 10 })
```

### Search contract

- `query` terms are AND'd **within one entry**. `match:"any"` ORs those terms.
- `anyOf` ORs alternative queries, each internally AND'd. When both are
  present, `query AND (alternative1 OR alternative2 …)` must match one entry.
- Quotes require adjacent tokens, **not byte-exact text**: FTS5's Porter
  stemming still applies. For example, “embedding” can also match “embedded”.
  Operators typed into the query are literal words; use the structured fields.
- `project` is an **exact working-directory filter**, not “discusses this
  project”. It accepts `current`, an absolute path, `~/`, or a relative path.
  `projectScope:"tree"` includes child directories, not similarly named siblings.
  Omit it to search discussions that happened elsewhere.
- `excludeCurrent` defaults to `true` to avoid rediscovering the question just
  asked. The interactive picker still includes the current session.
- `since`/`until` accept UTC dates, ISO timestamps with a timezone,
  `today`/`yesterday`, or relative durations such as `7d`, `2w`, `24h`.
  Bounds are inclusive; an `until` date includes its entire UTC day.
- `dateField` defaults to `activity` (last user/assistant text timestamp).
  `created` uses the session header; `message` filters matching entry
  timestamps and excludes metadata/generated summaries. None uses filesystem
  modification time. Activity includes all stored branches.
- `roles` can restrict `user`, `assistant`, `summary` (pi compaction/branch),
  `custom`, `meta` (name/path), or `generated` (cached topic summaries).
- `sort` is `relevance`, `recent`, or `oldest` (the latter two use activity).
  Default: relevance with a query, recent without one. `group:"projects"`
  always sorts by matching session count.
- `limit` (default 10, max 50), `offset`, `snippets` (default 3, max 5), and
  `maxChars` bound output. The response reports the **total** and an actionable
  next offset, including when the output budget shortened the page. The live
  index can change between calls; pagination isn't a frozen snapshot.
- `includeResume:true` adds shell commands; otherwise paths and source entry
  references are returned without that extra overhead.

Results distinguish generated summaries and metadata-only matches. Excerpts
prefer windows covering several query terms; highlighting is approximate,
while matching is performed by FTS5. **No keyword matches is not proof a topic
was never discussed.** Try alternatives, broaden scope, or browse summaries.

## Read the evidence

```js
session_read({ path: "...jsonl", around: 42, context: 2 })
session_read({ path: "...jsonl", entries: "40-45,52", roles: ["user"] })
session_read({ path: "...jsonl", query: "embeddings", match: "any" })
session_read({ path: "...jsonl", entries: "42", view: "full" })
session_read({ path: "...jsonl", view: "summary" })
```

- **Default `view:"conversation"`:** only user/assistant text blocks. No
  thinking, tool calls/results, images, extension messages, or compactions.
- **`view:"full"`:** includes all entries, thinking, tool arguments and results.
  Images are represented by placeholders, not decoded/OCR'd.
- **`view:"summary"`:** cached, generated topic outline, without generation.
  Missing/partial/stale status is explicit; stale references aren't presented
  as current evidence.
- No selection returns an outline. `entries` reads original ordinals;
  `around` adds `context` visible messages **on each side** (default 2), not
  raw entries or user/assistant pairs. `entries`, `around`, and `query` are
  mutually exclusive.
- Filtered views **never renumber** `#indices`. `offset` counts visible outline
  entries, matches, or summary overview/topic items—not original ordinals.
- In-session `query` is case-insensitive **substring** matching, without
  stemming. `match` is `all` (default) or `any`; quotes group phrases.
- Reads include timestamps and entry/parent IDs. All branches are retained in
  file order; adjacent entries are not necessarily on the same branch.
- `maxChars` defaults to 20,000 (max 40,000), with additional UTF-8 byte/line output
  ceilings. A partial entry returns `offsetChars` and separate instructions for
  subsequent entries. Continue with the same view/roles.

## Optional summary indexing

```js
// Free/local planning: chooses the active model unless one is specified.
session_summarize({ path: "...jsonl", action: "plan" })

// Explicit paid work: use the model reported by the plan.
session_summarize({
  path: "...jsonl", action: "generate",
  model: "provider/model-id", maxSections: 4
})
```

Generation sends historical **user/assistant text** to the selected provider
using pi's model registry and existing authentication. It does not change the
active model. Check the plan/provider before generating sensitive history.
Normal searches and reads never generate summaries automatically.

- One session per call; discover a batch with `session_search`, then plan or
  generate each explicitly. Default work cap: 4 new calls; maximum: 20.
- Whole messages are packed into bounded sections (at most 24,000 serialized
  input characters; smaller for limited-context models). Oversized messages
  are split with exact source offsets. **No sampling.**
- Each section produces an overview and topic records: intent, proposals,
  decisions/outcomes, open questions, keywords/aliases, and source indices.
  The prompt requests attribution and cautions about branches/incomplete context.
- JSON shape, size, and source references are validated. This is **not factual
  validation**: generated summaries are navigation aids, never authoritative
  evidence of what was decided or implemented.
- Successful sections persist immediately. Repeat a call with the same
  path/model to resume after a work cap, cancellation, or failure. Unchanged
  sections are reused after appends. Model/version changes use separate cache keys.
- Only a **complete, fresh generation** is published to FTS5. Edits mark old
  summaries stale and remove them from search on sync. A source change during
  generation prevents publication. Cached sections remain reusable.
- Provider calls are abortable and have a two-minute deadline each. Reported
  nested usage is returned to pi, including usage from completed requests
  before a later validation/failure/cancellation.
- No daemon, embeddings, automatic reranker, or session-file mutation.

## Interactive picker

```text
/session-search [query]
/session-search "phrase" word
/session-search --rebuild
```

Searches on every keystroke, with prefix matching for unquoted terms.
`↑`/`↓` or `Ctrl+P`/`Ctrl+N` navigate; `Enter` opens; `Tab` copies the resume
command; `Esc` cancels. Opening across projects uses pi's session switching,
which rebinds cwd/tools/trust. The richer filters above belong to the LLM tool.

## Storage and development

Sessions: `~/.pi/agent/sessions/<project>/*.jsonl`. Database:
`~/.pi/agent/session-search/index.db`. `PI_CODING_AGENT_DIR` relocates both.
The database contains private conversation text and derived summaries; treat
it like your session files. Deleting it is safe but discards paid-for summaries.
`--rebuild` preserves summary caches and reattaches fresh summaries.

SQLite FTS5 supplies the inverted keyword index, Porter stemming, BM25
ranking, and prefix indexes. Files sync by mtime + size. Unreadable/malformed
files are reported rather than silently discarded; unavailable session roots
fail without deleting the existing index. **All** indexed text
is retained (the old 16,000-character cutoff is gone); tools/thinking are
excluded. Index and reader share JSONL parsing/ordinals. No build step.

```text
extension/
  index.ts          registration/lifecycle and /session-search
  tools.ts          three LLM-facing tool schemas/handlers
  panel.ts          live picker components
  session-file.ts   shared parser, text extraction, fingerprints
  indexer.ts        incremental FTS5 storage/sync
  search.ts         lexical queries, filters, grouping, snippets
  reader.ts         full source rendering and filtered projections
  summary-store.ts  versioned cache, freshness, publication
  summarizer.ts     bounded/resumable generation, validation
  format.ts         bounded LLM-facing output
```

```bash
npm test                         # synthetic fixtures + fake provider; no API calls
node test/smoke.ts [query]        # throwaway DB over real history + timing probes
```

Standalone tests need Node's strip-types support (Node ≥22.18, or the
appropriate experimental flag on older Node) and local `node_modules`
resolution for the optional pi peers. pi itself supplies these via aliases.
See [test/EVALUATION.md](test/EVALUATION.md) for testing retrieval quality,
not just implementation correctness.
