/**
 * Standalone tests for the session reader and session_read output formatting.
 * Run: node test/reader.ts
 * Builds a synthetic session file in a temp dir; no pi required.
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatEntriesRead,
  formatOverview,
  formatSessionMatches,
} from "../extension/format.ts";
import { parseSessionFile } from "../extension/indexer.ts";
import { entriesAround, visibleEntries, conversationEntries, loadSessionFile, parseEntryRanges, resolveSessionPath } from "../extension/reader.ts";
import { fingerprint } from "../extension/session-file.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-session-read-"));
const sessionPath = join(dir, "2026-07-01T00-00-00-000Z_test.jsonl");

const lines = [
  { type: "session", version: 3, id: "u-1", timestamp: "2026-07-01T00:00:00.000Z", cwd: dir },
  // #1 user
  {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { role: "user", content: "hello, can you fix the docker compose file?" },
  },
  // #2 assistant with thinking + text + tool calls
  {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-07-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the ports are probably wrong" },
        { type: "text", text: "Sure, let me check the compose setup." },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "docker compose ps" } },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "docker compose config" } },
        { type: "toolCall", id: "c3", name: "read", arguments: { path: "compose.yaml" } },
      ],
      stopReason: "toolUse",
    },
  },
  // #3 tool result (only findable via session_read query, not FTS)
  {
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-07-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "NAME grafana STATUS Up SECRETTOKEN-IN-OUTPUT" }],
      isError: false,
    },
  },
  // #4 custom message
  {
    type: "custom_message",
    id: "e4",
    parentId: "e3",
    timestamp: "2026-07-01T00:00:04.000Z",
    customType: "my-ext",
    content: "injected extension context",
    display: true,
  },
  // #5 compaction
  {
    type: "compaction",
    id: "e5",
    parentId: "e4",
    timestamp: "2026-07-01T00:00:05.000Z",
    summary: "We fixed docker compose port mappings.",
    tokensBefore: 5000,
  },
  // #6 session name
  {
    type: "session_info",
    id: "e6",
    parentId: "e5",
    timestamp: "2026-07-01T00:00:06.000Z",
    name: "docker fix session",
  },
  // corrupt line must be skipped by BOTH reader and indexer (ordinal alignment)
  "this is not json {{",
  // #7 model change
  {
    type: "model_change",
    id: "e7",
    parentId: "e6",
    timestamp: "2026-07-01T00:00:07.000Z",
    provider: "anthropic",
    modelId: "claude-x",
  },
  // #8 big user message (budget/truncation tests)
  {
    type: "message",
    id: "e8",
    parentId: "e7",
    timestamp: "2026-07-01T00:00:08.000Z",
    message: { role: "user", content: "B".repeat(5000) },
  },
];
writeFileSync(sessionPath, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));

try {
  // --- loadSessionFile ---------------------------------------------------------
  const session = loadSessionFile(sessionPath);
  assert.equal(session.entries.length, 8, "corrupt line skipped");
  assert.equal(session.name, "docker fix session");
  assert.equal(session.messageCount, 4);
  assert.equal(session.cwd, dir);

  const [u1, a2, t3, c4, comp5, , m7, u8] = session.entries;
  assert.equal(u1!.kind, "user");
  assert.equal(a2!.kind, "assistant");
  assert.deepEqual(a2!.toolNames, ["bash", "bash", "read"]);
  assert(a2!.text.includes("[thinking] the ports are probably wrong"), "thinking in full text");
  assert(a2!.text.includes('→ bash({"command":"docker compose ps"})'), "tool call args in full text");
  assert(a2!.preview.startsWith("Sure, let me check"), "assistant preview skips thinking/tools");
  assert.equal(t3!.kind, "tool:bash");
  assert(t3!.text.includes("SECRETTOKEN-IN-OUTPUT"), "tool output in full text");
  assert.equal(c4!.kind, "custom:my-ext");
  assert.equal(comp5!.kind, "compaction");
  assert.equal(m7!.kind, "model");
  assert.equal(m7!.text, "anthropic/claude-x");
  assert.equal(u8!.index, 8, "ordinals skip corrupt line but stay sequential");

  // --- ordinal alignment with the FTS indexer ----------------------------------
  const parsed = parseSessionFile(sessionPath)!;
  const byId = new Map(session.entries.map((e) => [e.id, e.index]));
  assert(parsed.chunks.length >= 4, "indexer found chunks");
  for (const chunk of parsed.chunks) {
    if (!chunk.entryId) continue; // meta chunk
    assert.equal(
      chunk.entryIndex,
      byId.get(chunk.entryId),
      `indexer ordinal matches reader for entry ${chunk.entryId}`,
    );
  }

  // --- parseEntryRanges ---------------------------------------------------------
  assert.deepEqual(parseEntryRanges("3", 8), [3]);
  assert.deepEqual(parseEntryRanges("2-4,6", 8), [2, 3, 4, 6]);
  assert.deepEqual(parseEntryRanges("7-", 8), [7, 8]);
  assert.deepEqual(parseEntryRanges("6-100", 8), [6, 7, 8], "clamped to max");
  assert.throws(() => parseEntryRanges("abc", 8), /Invalid entry range/);
  assert.throws(() => parseEntryRanges("0", 8), /Invalid entry range/);
  assert.throws(() => parseEntryRanges("99", 8), /No valid entries/);

  // --- formatOverview ------------------------------------------------------------
  const overview = formatOverview(session);
  assert(overview.includes("Session: docker fix session"), "title");
  assert(overview.includes("8 entries, 4 messages"), "counts");
  assert(overview.includes("Entries #1-#8 of 8"), "range line");
  assert(overview.includes("tool:bash"), "tool result kind in outline");
  assert(overview.includes("[bash ×2, read]"), "tool call summary in outline");

  const page = formatOverview(session, { offset: 6, limit: 2 });
  assert(page.includes("Entries #7-#8 of 8"), "pagination");
  assert(!page.includes("#1 user"), "offset skips entries");

  const past = formatOverview(session, { offset: 50 });
  assert(past.includes("past the end"), "offset past end");

  // --- formatEntriesRead ----------------------------------------------------------
  const read = formatEntriesRead(session, [2, 3]);
  assert(read.includes("--- #2 assistant"), "entry header");
  assert(read.includes("[thinking]"), "thinking included in read");
  assert(read.includes("SECRETTOKEN-IN-OUTPUT"), "tool output included in read");

  const truncated = formatEntriesRead(session, [8], { maxChars: 1000 });
  assert(truncated.includes("[truncated: showing chars 0-"), "truncation note");
  const next = Number(/offsetChars:(\d+)/.exec(truncated)?.[1]);
  assert(next > 0 && next < 1000, "budget includes headers and continuation hints");
  assert(truncated.length <= 1000, "bounded total output");
  assert(truncated.includes('entries:"8", offsetChars:'), "continuation hint");

  const continued = formatEntriesRead(session, [8], { maxChars: 2000, offsetChars: 4500 });
  assert(continued.includes("B".repeat(500)), "offsetChars continues the entry");
  assert(!continued.includes("[truncated"), "tail fits in budget");

  const wholeRange = formatEntriesRead(session, parseEntryRanges("1-8", 8), { maxChars: 1000 });
  assert(wholeRange.includes("[truncated: showing chars"), "big trailing entry truncated in range read");

  // Budget exhausted mid-list: big entry first, more entries pending.
  const budget = formatEntriesRead(session, [8, 1, 2], { maxChars: 1000 });
  assert(budget.includes("[truncated:"), "cross-entry budget stop");
  assert(budget.includes('then read remaining entries:"1-2"'), "finish partial entry before reading subsequent entries");

  assert.throws(
    () => formatEntriesRead(session, [1, 2], { offsetChars: 10 }),
    /single entry/,
    "offsetChars needs one entry",
  );

  // --- formatSessionMatches --------------------------------------------------------
  const found = formatSessionMatches(session, "SECRETTOKEN-IN-OUTPUT");
  assert(found.includes("1 of 8 visible entries match"), "tool output searchable in-session");
  assert(found.includes("#3 tool:bash"), "match line has index and kind");
  assert(found.includes("«SECRETTOKEN-IN-OUTPUT»"), "highlighted snippet");

  const none = formatSessionMatches(session, "zzz-not-there");
  assert(none.includes("No entries match"), "no-match message");

  const and = formatSessionMatches(session, "docker ports");
  assert(and.includes("#2 assistant"), "AND across thinking + text");

  // --- filtered views preserve ordinals and never leak hidden content ---------------
  const conversation = { view: "conversation" as const };
  assert.deepEqual(visibleEntries(session, conversation).map((e) => e.index), [1, 2, 8]);
  assert.equal(fingerprint(conversationEntries(session)), parsed.conversationHash, "reader/indexer summary fingerprints agree");
  const clean = formatEntriesRead(session, [1, 2, 3, 4, 5], conversation);
  assert(clean.includes("Sure, let me check"));
  for (const hidden of ["[thinking]", "probably wrong", "→ bash", "SECRETTOKEN", "extension context", "We fixed docker"]) assert(!clean.includes(hidden), hidden);
  assert.deepEqual(entriesAround(session, 2, 1, conversation), [1, 2, 8]);
  assert.deepEqual(entriesAround(session, 3, 1, conversation), [2, 8], "hidden anchor still locates visible neighbors");
  assert.deepEqual(entriesAround(session, 2, 0, conversation), [2]);
  assert.throws(() => entriesAround(session, 100), /outside/);
  assert(formatOverview(session, { ...conversation, offset: 2 }).includes("#8 user"));
  assert(!formatOverview(session, conversation).includes("[bash"));
  assert(!formatSessionMatches(session, "SECRETTOKEN", conversation).includes("#3"));
  assert(formatSessionMatches(session, "missing compose", { ...conversation, match: "any" }).includes("#2"));
  assert(!formatSessionMatches(session, "missing compose", conversation).includes("#2"));
  assert.deepEqual(visibleEntries(session, { ...conversation, roles: ["assistant"] }).map((e) => e.index), [2]);
  assert(formatEntriesRead(session, [3], conversation).includes('view:"full"'));
  assert(formatEntriesRead(session, [8], { ...conversation, offsetChars: 6000 }).includes("past the end"));

  const unicodeSession = { ...session, entries: session.entries.map((entry) => entry.index === 8 ? {
    ...entry, text: "語".repeat(30_000), conversationText: "語".repeat(30_000),
  } : entry) };
  const unicode = formatEntriesRead(unicodeSession, [8], { ...conversation, maxChars: 40_000 });
  assert(Buffer.byteLength(unicode) < 50_000, "UTF-8 byte ceiling as well as character budget");
  const unicodeOffset = Number(/offsetChars:(\d+)/.exec(unicode)?.[1]);
  assert(unicodeOffset > 10_000 && unicodeOffset < 20_000);
  assert(formatSessionMatches(session, "missing".repeat(1000), { ...conversation, maxChars: 2000 }).length <= 2000);
  const manyLines = { ...session, entries: session.entries.map((entry) => entry.index === 8 ? {
    ...entry, text: "x\n".repeat(10_000), conversationText: "x\n".repeat(10_000),
  } : entry) };
  const lineLimited = formatEntriesRead(manyLines, [8], { ...conversation, maxChars: 40_000 });
  assert(lineLimited.split("\n").length < 2000, "line ceiling with a usable continuation");
  assert(lineLimited.includes("offsetChars:"));

  // --- resolveSessionPath -----------------------------------------------------------
  assert.equal(resolveSessionPath(`@${sessionPath}`, "/"), sessionPath, "@ stripped");
  assert.equal(resolveSessionPath("rel.jsonl", "/tmp"), "/tmp/rel.jsonl", "relative resolved");
  assert.equal(resolveSessionPath("/tmp/dir/../foo/", "/"), "/tmp/foo", "normalize project paths too");
  assert(resolveSessionPath("~/x.jsonl", "/").endsWith("/x.jsonl"), "~ expanded");
  assert(!resolveSessionPath("~/x.jsonl", "/").startsWith("~"), "~ removed");

  // --- error cases --------------------------------------------------------------------
  assert.throws(() => loadSessionFile(join(dir, "missing.jsonl")), /not found/);
  const notSession = join(dir, "not-session.jsonl");
  writeFileSync(notSession, `${JSON.stringify({ type: "other" })}\n`);
  assert.throws(() => loadSessionFile(notSession), /Not a pi session file/);

  console.log("reader tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
