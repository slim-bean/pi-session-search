/**
 * Standalone tests for the live search panel and match-query building.
 * Run: node test/panel.ts
 * Requires node_modules/@earendil-works symlinks (see AGENTS.md).
 */
import assert from "node:assert";
import { ResultsList, SearchPanel } from "../extension/index.ts";
import {
  HL_END,
  HL_START,
  buildMatchQuery,
  extractTokens,
  makeSnippet,
  type SearchHit,
} from "../extension/search.ts";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function makeHits(n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `/tmp/sessions/s${i}.jsonl`,
    cwd: "/tmp",
    name: i === 0 ? "named session" : null,
    firstMessage: `first message of session ${i} which is fairly long and should be truncated at some point`,
    createdAt: Date.UTC(2026, 5, 1 + i),
    modifiedAt: Date.UTC(2026, 5, 1 + i),
    messageCount: 10 + i,
    hits: 3,
    bestRank: -i,
    snippets: [{ role: "user", text: `some ${HL_START}match${HL_END} in session ${i}` }],
  }));
}

// --- buildMatchQuery ---------------------------------------------------------
assert.equal(buildMatchQuery("foo bar"), '"foo" "bar"');
assert.equal(buildMatchQuery('"a phrase" word'), '"a phrase" "word"');
assert.equal(buildMatchQuery('has"quote'), '"has""quote"');
assert.equal(buildMatchQuery("duckd", { prefix: true }), '"duckd"*');
assert.equal(buildMatchQuery("sess sear", { prefix: true }), '"sess"* "sear"*', "all tokens prefixed");
assert.equal(buildMatchQuery('"exact" par', { prefix: true }), '"exact" "par"*', "no prefix on quoted");

// --- extractTokens / makeSnippet ---------------------------------------------
assert.deepEqual(extractTokens('"a phrase" word'), ["a phrase", "word"]);

const snip = makeSnippet("x ".repeat(200) + "the session indexer works", ["sess"]);
assert(snip.includes(`${HL_START}session${HL_END}`), "prefix highlight");
assert(snip.startsWith("…"), "leading ellipsis when windowed");
assert(!snip.includes("x x x x x x x x x x x x x x x x x x x x x x x x x x x"), "windowed");
assert.equal(makeSnippet("no match here", ["zzz"]).includes(HL_START), false, "no false highlight");
assert(
  !makeSnippet("assessment of sessions", ["sess"]).includes(`${HL_START}ssment`),
  "mid-word occurrence not anchored",
);

// --- ResultsList -------------------------------------------------------------
const hits = makeHits(8);
const list = new ResultsList(theme, hits[2]!.path);
list.setHits(hits);

let lines = list.render(80);
assert(lines.some((l) => l.includes("❯")), "has selection marker");
assert(lines.some((l) => l.includes("named session")), "shows session name");
assert(lines.some((l) => l.includes("match")), "shows snippet");
assert(!lines.some((l) => l.includes(HL_START)), "markers replaced");

list.moveDown();
list.moveDown();
lines = list.render(80);
assert(lines.some((l) => l.includes("❯") && l.includes("(current)")), "current marker on selected");

for (let i = 0; i < 10; i++) list.moveDown();
lines = list.render(80);
assert(lines.some((l) => l.includes("↑") && l.includes("more")), "scroll indicator");
assert.equal(list.getSelected()!.path, hits[7]!.path, "clamped at end");

list.setHits([]);
assert(list.render(80).some((l) => l.includes("no matches")), "empty state");

// --- SearchPanel: live search on keystrokes ----------------------------------
const queries: string[] = [];
let result: unknown = "unset";
const panel = new SearchPanel({
  theme,
  initialQuery: "",
  currentSessionPath: undefined,
  runSearch: (q) => {
    queries.push(q);
    return q ? makeHits(3) : makeHits(1);
  },
  done: (r) => (result = r),
});

assert.deepEqual(queries, [""], "initial search for recent sessions");
panel.handleInput("d");
panel.handleInput("u");
assert.deepEqual(queries, ["", "d", "du"], "search per keystroke");
assert.equal(panel.getQuery(), "du");

lines = panel.render(100);
assert(lines.some((l) => l.includes("3 results")), "count line");
assert(lines.some((l) => l.includes("du")), "input echoes query");

// Backspace re-searches
panel.handleInput("\x7f");
assert.equal(queries.at(-1), "d", "backspace triggers search");

// Navigation does not touch the query
panel.handleInput("\x1b[B");
panel.handleInput("\x1b[B");
assert.equal(queries.at(-1), "d", "arrows do not re-search");

// Enter opens the selected hit
panel.handleInput("\r");
assert.equal((result as any).type, "open");
assert.equal((result as any).hit.path, makeHits(3)[2]!.path);

// Tab copies
result = "unset";
panel.handleInput("\t");
assert.equal((result as any).type, "copy");

// Escape cancels
result = "unset";
panel.handleInput("\x1b");
assert.equal(result, null);

console.log("panel tests passed");
