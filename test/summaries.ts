import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { SessionIndex } from "../extension/indexer.ts";
import { buildSections, generateSummary, loadConversation, parseSummary, planSummary } from "../extension/summarizer.ts";
import { cachedSection, readSummary, SUMMARY_VERSION } from "../extension/summary-store.ts";
import { fingerprint } from "../extension/session-file.ts";
import { searchSessions } from "../extension/search.ts";
import { formatSummary } from "../extension/format.ts";
import { fixture, message } from "./fixtures.ts";

const f = fixture();
const dbPath = join(f.dir, "index.db");
let index = new SessionIndex(dbPath);
const model = "fake/frontier";
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
const reply = (input: string) => {
  const spans = JSON.parse(input);
  return JSON.stringify({ overview: "Conversation overview", topics: [{ title: "Semantic retrieval", summary: "The user asked about finding previous work; the assistant suggested an experiment, not an implemented feature.", keywords: ["semantic discovery", "topic navigation"], entries: [spans[0].index] }] });
};
try {
  const entries = [
    message("user", "Find my past work " + "🔎 \"\\\n".repeat(400)),
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "HIDDEN_THINKING" }, { type: "toolCall", name: "bash", arguments: { command: "HIDDEN_CALL" } },
      { type: "text", text: "Consider a search experiment. " + "explanation ".repeat(600) },
    ] } },
    message("toolResult", "HIDDEN_OUTPUT", undefined, { toolName: "bash" }),
    { type: "compaction", summary: "HIDDEN_COMPACTION" },
    message("user", "A brief unrelated aside about frobnication."),
  ];
  const path = f.write("summary", "/work/search", entries);
  await index.sync(f.root);
  const conversation = loadConversation(path);
  const sections = buildSections(conversation, 2000);
  assert(sections.length > 4);
  assert(sections.every((s) => s.input.length <= 2000));
  for (const entry of conversation) {
    const spans = sections.flatMap((s) => s.spans).filter((s) => s.index === entry.index);
    assert.equal(spans.map((s) => s.text).join(""), entry.text, "every character covered, including escaped/emoji text");
    assert.equal(spans[0]?.startChar, 0);
    assert.equal(spans.at(-1)?.endChar, entry.text.length);
    spans.forEach((s, i) => { if (i) assert.equal(spans[i - 1]!.endChar, s.startChar); });
  }
  assert(sections.at(-1)?.input.includes("frobnication"), "brief final aside is not sampled away");
  const initial = planSummary(index, path, model, 2000);
  assert.equal(initial.cached, 0);
  assert.equal(initial.sourceHash, (index.db.prepare("SELECT conversation_hash FROM sessions WHERE path = ?").get(path) as any).conversation_hash);
  assert.equal(searchSessions(index, { query: "semantic discovery" }).total, 0);
  let calls = 0;
  const complete = async (system: string, input: string) => {
    calls++;
    assert(system.includes("UNTRUSTED"));
    for (const hidden of ["HIDDEN_THINKING", "HIDDEN_CALL", "HIDDEN_OUTPUT", "HIDDEN_COMPACTION"]) assert(!input.includes(hidden));
    return { text: reply(input), usage };
  };
  const partial = await generateSummary(index, initial, complete, { maxSections: 1 });
  assert.equal(partial.generated, 1);
  assert.equal(partial.remaining, initial.sections.length - 1);
  assert.equal(partial.usage.totalTokens, 30);
  assert.equal(partial.usage.cost.total, 0.003);
  assert.equal(readSummary(index.db, path, initial.sourceHash).status, "partial");
  assert.equal(searchSessions(index, { query: "semantic discovery" }).total, 0, "partial generation not published");

  index.close(); index = new SessionIndex(dbPath);
  const resumed = planSummary(index, path, model, 2000);
  assert.equal(resumed.cached, 1, "cache survives process restart");
  const done = await generateSummary(index, resumed, complete, { maxSections: 20 });
  assert(done.complete);
  assert.equal(calls, initial.sections.length, "resumed section not charged twice");
  const record = readSummary(index.db, path, initial.sourceHash);
  assert.equal(record.status, "ready");
  assert.equal(record.version, SUMMARY_VERSION);
  assert.equal(record.sections.length, sections.length);
  const found = searchSessions(index, { query: '"semantic discovery"', roles: ["generated"] });
  assert.equal(found.total, 1, "LLM-supplied terms work through the existing FTS index");
  assert.equal(found.hits[0]?.snippets[0]?.role, "generated");
  assert(found.hits[0]?.snippets[0]?.sourceRefs?.length);
  assert.equal(searchSessions(index, { query: "semantic", roles: ["generated"], dateField: "message", since: "2020-01-01" }).total, 0);
  assert(formatSummary(record, path).includes("Verify claims"));
  const free = await generateSummary(index, planSummary(index, path, model, 2000), complete);
  assert.equal(free.generated, 0); assert(free.complete); assert.equal(free.usage.totalTokens, 0);
  assert.equal(planSummary(index, path, "fake/different-model", 2000).cached, 0, "cache keys include model");
  assert(formatSummary(record, path, { limit: 1 }).includes("offset:1"), "summary overview/topic items are paginated");
  assert(!formatSummary(record, path, { limit: 1, offset: 1 }).includes("Section 1 overview"));

  // Version invalidation must work even with no source-file changes.
  index.db.prepare("UPDATE summaries SET version = 'old' WHERE session_path = ?").run(path);
  assert.equal((await index.sync(f.root)).indexed, 0);
  assert.equal(searchSessions(index, { query: "semantic discovery" }).total, 0);
  assert.equal(readSummary(index.db, path, initial.sourceHash).status, "stale");
  assert((await generateSummary(index, planSummary(index, path, model, 2000), complete)).complete);

  index.reset(); await index.sync(f.root);
  assert.equal(searchSessions(index, { query: "semantic discovery" }).total, 1, "FTS rebuild retains/re-attaches summaries");
  entries[2] = message("toolResult", "DIFFERENT_TOOL_OUTPUT", undefined, { toolName: "bash" });
  f.write("summary", "/work/search", entries); await index.sync(f.root);
  assert.equal(readSummary(index.db, path, fingerprint(loadConversation(path))).status, "ready", "tool-only changes do not invalidate summaries");

  entries.push(message("user", "New discussion about Kubernetes capability restrictions."));
  f.write("summary", "/work/search", entries); await index.sync(f.root);
  const changedHash = fingerprint(loadConversation(path));
  assert.equal(readSummary(index.db, path, changedHash).status, "stale");
  assert.equal(searchSessions(index, { query: "semantic discovery" }).total, 0, "stale generated content excluded");
  const staleText = formatSummary(readSummary(index.db, path, changedHash), path);
  assert(!staleText.includes("Semantic retrieval"), "stale entry references not presented as current");
  const incremental = planSummary(index, path, model, 2000);
  assert(incremental.cached >= initial.sections.length - 1, "unchanged completed sections reused on append");
  assert((await generateSummary(index, incremental, complete, { maxSections: 20 })).complete);

  const bad = planSummary(index, path, "fake/bad-model", 2000);
  const badReply = JSON.parse(reply(bad.sections[0]!.input)); badReply.topics[0].entries = [99999];
  assert.throws(() => parseSummary(JSON.stringify(badReply), bad.sections[0]!), /source references/);
  assert.throws(() => parseSummary("not json", bad.sections[0]!), /valid JSON/);
  const invalid = await generateSummary(index, bad, async () => ({ text: "not json", usage }));
  assert(invalid.error); assert.equal(invalid.generated, 0); assert.equal(invalid.usage.totalTokens, 30);
  assert(!cachedSection(index.db, path, bad.sections[0]!.hash, bad.model));
  const failed = await generateSummary(index, bad, async () => ({ text: "", usage, error: "provider failed" }));
  assert.equal(failed.error, "provider failed"); assert.equal(failed.usage.totalTokens, 30);

  const controller = new AbortController();
  const cancelled = await generateSummary(index, bad, async (_system, input) => {
    controller.abort(); return { text: reply(input), usage };
  }, { signal: controller.signal });
  assert(cancelled.error); assert.equal(cancelled.generated, 0); assert.equal(cancelled.usage.totalTokens, 30);
  let called = false;
  await generateSummary(index, bad, async () => { called = true; return { text: "" }; }, { signal: controller.signal });
  assert(!called, "pre-aborted work never reaches provider");

  const racing = planSummary(index, path, "fake/racing", 24000);
  const result = await generateSummary(index, racing, async (_system, input) => {
    f.write("summary", "/work/search", [...entries, message("user", "Changed while waiting for model")]);
    return { text: reply(input) };
  });
  assert(result.error?.includes("Source changed")); assert(!result.complete);
  rmSync(path); await index.sync(f.root);
  assert.equal(index.db.prepare("SELECT * FROM summaries").all().length, 0);
  assert.equal(index.db.prepare("SELECT * FROM summary_cache").all().length, 0);
  console.log("summary tests passed (coverage, provenance, cache, resumability, freshness, cancellation, usage)");
} finally { index.close(); f.cleanup(); }
