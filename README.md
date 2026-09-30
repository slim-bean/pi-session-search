# pi-session-search

Search and read **all your local pi conversations**, across projects. Designed
for a frontier model to investigate history using scoped keyword searches,
compact evidence, and optional, inspectable topic summaries—not vectors.

- `/session-search` — instant prefix-search picker; open a session or copy its
  resume command.
- `session_search` — lexical search, session browsing, and project discovery.
- `session_read` — conversation text, context around a hit, full forensic
  entries, or cached topic summaries.
- `session_summarize` — plan (free cost estimate), calibrate (compare models on
  a small sample), and generate cached topic summaries for one session or a
  whole filtered scope. **Only calibrate/generate make model calls.**

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

**Upgrading to 0.4.1:** `SUMMARY_VERSION` 2 (lenient validator, prompt
wording). Earlier summaries/caches and calibration stats are not reused.

**Upgrading to 0.4:** summary cache keys now include the reasoning level
(`provider/model@low`), so 0.3 caches are not reused. `session_summarize`
takes `path`, `paths`, or `scope`, and plan output/details changed shape.

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
// Free/local: scope, cached vs. remaining work, cost estimate per model.
session_summarize({ scope: { all: true }, models: ["openai/gpt-6-luna", "anthropic/claude-sonnet-5"] })

// Paid, small: same size-spread sample through each model; measures tokens,
// cost, latency, failures; shows a side-by-side topic comparison. Not published.
session_summarize({ action: "calibrate", scope: { all: true },
  models: ["openai/gpt-6-luna", "anthropic/claude-sonnet-5"], samples: 6 })

// Paid batch: parallel, bounded, resumable; publishes complete sessions.
session_summarize({ action: "generate", scope: { project: "~/projects/x", projectScope: "tree" },
  model: "openai/gpt-6-luna", maxSections: 500, maxCost: 5, concurrency: 8 })
```

**Targets:** exactly one of `path`, `paths`, or `scope`. `scope` uses
`session_search` filters (`query`, `anyOf`, `project`, `projectScope`, `since`,
`until`, `dateField`); with no filter it requires `all: true`. The current
session is excluded unless `excludeCurrent: false` (it keeps changing).

**What is sent:** historical **user/assistant text** only, through pi's model
registry and existing authentication, to the named provider. Never tools,
thinking, images, or compaction text. The active model is the default but is
never changed. Normal searches and reads never generate summaries.

- Whole messages are packed into bounded sections (at most 24,000 serialized
  input characters; smaller for limited-context models). Oversized messages
  are split with exact source offsets. **No sampling.** Each section is one
  independent call: no cross-section context and no session-level rollup.
- Each section produces an overview and topic records: intent, proposals,
  decisions/outcomes, open questions, keywords/aliases, and source indices.
  Responses are **repaired rather than rejected**: over-limit text/lists are
  trimmed, references to non-text entries inside the section snap to the
  nearest preceding message, out-of-section references and unreferenced topics
  are dropped. A paid response is discarded only if no usable topic remains,
  with the exact reason. Repairs are stored with the section and in the call
  log. This is **not factual validation**: summaries are navigation aids.
- **Reasoning** (`reasoning`, default `low`) goes through pi's provider-neutral
  API and is clamped to what the model supports. The cache key is
  `provider/model@reasoning`; changing model, reasoning, or `SUMMARY_VERSION`
  means new generation. Output ceiling: 8,192 tokens (thinking + answer);
  only generated tokens are billed.
- **Budgets:** `maxSections` caps new calls per invocation (default 4);
  `maxCost` is an approximate USD ceiling on reported cost (one call runs first
  to learn per-call cost; in-flight calls can overshoot slightly).
  `concurrency` defaults to 4 (max 16). A failed section is billed, logged,
  and skipped; five consecutive failures stop the run. Repeat the same call to
  resume: cached sections are free, failed ones retry.
- **Estimates:** every billed call is logged (tokens, cost, latency, stop
  reason, failure; no text) in `summary_calls`. Plans for a model key with
  logged calls are **calibrated**: measured input tokens/char, mean output
  tokens, failure rate (retries), and wall time at the chosen concurrency.
  Otherwise they show a **rough range** (2.4–4 chars/token, 1k–4k output
  tokens per call). Prices come from pi's model registry.
- **Calibration** picks a deterministic sample spread across the scope's
  section-size distribution, the same sections for every model. The sample's
  sections are cached (reused by a later `generate` with that key), never
  published, and never replace a published summary.
- Only a **complete, fresh generation** is published to FTS5. Edits mark old
  summaries stale and remove them from search on sync. A source change during
  generation prevents publication. Cached sections remain reusable; appends
  normally regenerate only the final section.
- Provider calls are abortable (Esc cancels the tool) and have a three-minute
  deadline each. Nested usage is returned to pi, including failed attempts.
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
  tools.ts          session_search/session_read; registers session_summarize
  panel.ts          live picker components
  session-file.ts   shared parser, text extraction, fingerprints
  indexer.ts        incremental FTS5 storage/sync
  search.ts         lexical queries, filters, grouping, snippets
  reader.ts         full source rendering and filtered projections
  schemas.ts        shared tool parameter schemas
  summarize-tool.ts session_summarize: targets, plan/calibrate/generate
  summary-store.ts  versioned cache, freshness, publication, call log
  summarizer.ts     sections, prompt, validation, parallel bounded engine
  summary-model.ts  model resolution, reasoning clamp, streamSimple adapter
  summary-estimate.ts call stats, cost/time projection, calibration sample
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
