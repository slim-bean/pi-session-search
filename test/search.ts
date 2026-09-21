import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SessionIndex, parseSessionFile } from "../extension/indexer.ts";
import { loadSessionFile } from "../extension/reader.ts";
import { buildMatchQuery, dateBound, makeSnippet, searchSessions, searchProjects } from "../extension/search.ts";
import { formatSearchPage, formatProjectPage } from "../extension/format.ts";
import { fixture, message } from "./fixtures.ts";

const f = fixture();
const index = new SessionIndex(join(f.dir, "index.db"));
try {
  const project = "/work/pi-session-search";
  const design = f.write("design", project, [
    message("user", "Can we find old conversations by meaning?"),
    message("assistant", "Defer embeddings. Try LLM reranking for fuzzy retrieval."),
    message("user", "Keep the initial version keyword-only.", "2026-09-19T10:00:00Z"),
  ]);
  const child = f.write("child", project + "/child", [message("user", "Embeddings in a separate experiment.")]);
  const other = f.write("other", project + "-other", [message("user", "Embedding analytics for dashboards.")]);
  const current = f.write("current", project, [message("user", "semantic search capabilities", "2026-09-20T10:00:00Z")]);
  const long = f.write("long", "/work/long", [message("assistant", "earlyTerm " + "filler ".repeat(5000) + "tailNeedle lateTerm")]);
  const roles = f.write("roles", "/work/roles", [
    message("user", "ordinary conversation"),
    { type: "message", timestamp: "2026-07-23T00:00:00Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: "THINKINGSECRET" }, { type: "toolCall", name: "bash", arguments: { command: "CALLSECRET" } },
      { type: "text", text: "Visible assistant running tests." },
    ] } },
    message("toolResult", "OUTPUTSECRET", undefined, { toolName: "bash" }),
    { type: "compaction", summary: "Compact summary of choices" },
    "{broken json", null, { type: "unknown" },
    message("user", "later user keyword"),
  ]);
  const first = await index.sync(f.root);
  assert.equal(first.indexed, 6);
  assert.equal((await index.sync(f.root)).indexed, 0);
  // Common-query duplicates used to consume the global snippet candidate budget.
  f.write("many", "/work/many", Array.from({ length: 550 }, () => message("user", "frequent")));
  f.write("few", "/work/few", [message("user", "frequent with extra words")]);
  await index.sync(f.root);

  assert.equal(searchSessions(index, { query: "tailNeedle" }).hits[0]?.path, long, "full text after old 16K cap is indexed");
  assert.equal(searchSessions(index, { query: "earlyTerm lateTerm" }).total, 1, "no arbitrary chunk boundary AND loss");
  assert.equal(searchSessions(index, { query: "meaning reranking" }).total, 0, "AND applies to one entry, not whole session");
  assert.equal(searchSessions(index, { query: "THINKINGSECRET" }).total, 0);
  assert.equal(searchSessions(index, { query: "OUTPUTSECRET" }).total, 0);
  assert.equal(searchSessions(index, { query: "CALLSECRET" }).total, 0);
  assert.equal(searchSessions(index, { query: "running", roles: ["user"] }).total, 0);
  assert.equal(searchSessions(index, { query: '"run test"', roles: ["assistant"] }).total, 1, "phrases still stem");
  assert.equal(searchSessions(index, { query: "choices", roles: ["summary"] }).total, 1);
  const metadata = searchSessions(index, { query: "roles", roles: ["meta"] });
  assert.equal(metadata.hits[0]?.path, roles);
  assert(formatSearchPage(metadata).text.includes("metadata only"));

  const narrowed = searchSessions(index, { project, excludePath: current, anyOf: ['"semantic search"', "embedding", "rerank"] });
  assert.equal(narrowed.total, 1);
  assert.equal(narrowed.hits[0]?.path, design);
  assert.equal(searchSessions(index, { query: "embedding", project }).total, 1);
  const subtree = searchSessions(index, { query: "embedding", project, projectScope: "tree" }).hits.map((h) => h.path);
  assert.deepEqual(new Set(subtree), new Set([design, child]));
  assert(!subtree.includes(other));
  assert.equal(searchSessions(index, { query: "Defer", anyOf: ["embedding", "dashboard"] }).total, 1);
  assert.equal(searchSessions(index, { query: "nonsense embeddings", match: "any", project }).total, 1);
  assert.equal(searchSessions(index, { query: '"foo) OR (bar"' }).total, 0, "query syntax is quoted");
  assert.throws(() => searchSessions(index, { query: "!!!" }), /no searchable words/);
  assert.equal(buildMatchQuery("foo OR bar"), '"foo" "OR" "bar"');

  assert.equal(searchSessions(index, { query: "reranking", since: "2026-09-01", dateField: "activity" }).total, 1);
  assert.equal(searchSessions(index, { query: "reranking", since: "2026-09-01", dateField: "created" }).total, 0);
  assert.equal(searchSessions(index, { query: "reranking", since: "2026-09-01", dateField: "message" }).total, 0);
  assert.equal(searchSessions(index, { project, query: "keyword", since: "2026-09-19", until: "2026-09-19", dateField: "message" }).total, 1);
  assert.equal(searchSessions(index, { project, since: "2026-09-19", until: "2026-09-19", dateField: "message" }).total, 1);
  assert.equal(dateBound("2026-07-22", true), Date.parse("2026-07-22T23:59:59.999Z"));
  assert.equal(dateBound("7d", false, Date.parse("2026-07-22")), Date.parse("2026-07-15"));
  assert.equal(dateBound("yesterday", true, Date.parse("2026-07-22")), Date.parse("2026-07-21T23:59:59.999Z"));
  for (const value of ["2026-02-30", "nope", "2026-07-22T12:00", "2026-99-99", "2026-02-30T12:00:00Z"]) assert.throws(() => dateBound(value), /Invalid date/);
  assert.throws(() => searchSessions(index, { since: "2026-08-01", until: "2026-07-01" }), /since/);

  const all = searchSessions(index, { limit: 50 });
  const one = searchSessions(index, { limit: 2 });
  const two = searchSessions(index, { limit: 2, offset: one.nextOffset });
  assert.equal(one.total, 8);
  assert.equal(two.total, 8);
  assert.deepEqual([...one.hits, ...two.hits].map((h) => h.path), all.hits.slice(0, 4).map((h) => h.path));
  assert.equal(searchSessions(index, { offset: 999 }).total, 8, "count survives past-end pages");
  assert.equal(searchSessions(index, { query: "frequent", offset: 1, limit: 1 }).hits[0]?.snippets.length, 1, "later candidate not starved by 550 earlier entries");
  const projects = searchProjects(index, { query: "embedding" });
  assert.equal(projects.total, 3);
  assert(formatProjectPage(projects).text.includes("3"));
  assert.equal(searchProjects(index, { project, excludePath: current }).projects[0]?.sessions, 1);

  const output = formatSearchPage(narrowed).text;
  assert(output.includes("Scope:"));
  assert(output.includes("current session excluded"));
  assert(output.includes("#2"));
  assert(!output.includes("resume:"));
  assert(formatSearchPage(narrowed, { includeResume: true }).text.includes("resume:"));
  const capped = formatSearchPage(all, { maxChars: 2000 });
  assert(capped.text.length <= 2000);
  assert.equal(capped.nextOffset, capped.shown);
  assert(formatSearchPage(searchSessions(index, { query: "NONEXISTENTTERM" })).text.includes("does NOT establish"));
  const snippet = makeSnippet("generic " + "filler ".repeat(100) + "generic specific evidence", ["generic", "specific"], 100);
  assert(snippet.includes("specific"), "snippet favors multiple terms");

  const parsed = parseSessionFile(roles)!;
  const read = loadSessionFile(roles);
  for (const chunk of parsed.chunks) assert.equal(read.entries[chunk.entryIndex - 1]?.id, chunk.entryId, "shared ordinals incl corrupt/null/unknown entries");
  const hash = parsed.conversationHash;
  assert(hash);
  index.reset();
  assert.equal(searchSessions(index).total, 0);
  assert.equal((await index.sync(f.root)).indexed, 8);
  rmSync(other);
  assert.equal((await index.sync(f.root)).removed, 1);
  assert.equal(searchSessions(index, { project: project + "-other" }).total, 0);
  const oldPath = join(f.dir, "v3.db");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version','3');
    CREATE TABLE sessions (path TEXT); CREATE VIRTUAL TABLE chunks USING fts5(text);`);
  old.close();
  const migrated = new SessionIndex(oldPath);
  try {
    await migrated.sync(f.root);
    assert.equal(searchSessions(migrated, { query: "tailNeedle" }).hits[0]?.path, long, "old schema rebuilt automatically");
  } finally { migrated.close(); }
  writeFileSync(design, "invalid header\n");
  assert.equal((await index.sync(f.root)).skipped, 1, "unreadable files reported, not silently deleted");
  await assert.rejects(index.sync(join(f.dir, "unavailable")), /unavailable/);
  console.log("search tests passed (scope, recall, evidence, pagination, dates, migrations, no-match cases)");
} finally { index.close(); f.cleanup(); }
