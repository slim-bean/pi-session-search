/**
 * Standalone render/input test for the results picker (no TUI needed).
 * Run: node test/picker.ts
 * Requires node_modules/@earendil-works symlinks (see AGENTS.md).
 */
import assert from "node:assert";
import { ResultsPicker } from "../extension/index.ts";
import { HL_END, HL_START, type SearchHit } from "../extension/search.ts";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

const hits: SearchHit[] = Array.from({ length: 8 }, (_, i) => ({
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

let result: unknown = "unset";
const picker = new ResultsPicker(hits, theme, (r) => (result = r), hits[2]!.path);

// Render fits width, shows selection + highlight
let lines = picker.render(80);
assert(lines.some((l) => l.includes("❯")), "has selection marker");
assert(lines.some((l) => l.includes("named session")), "shows session name");
assert(lines.some((l) => l.includes("match")), "shows snippet");
assert(!lines.some((l) => l.includes(HL_START)), "markers replaced");
for (const l of lines) assert(l.length <= 80 + 20, "line roughly bounded"); // ansi-free theme

// Navigate down twice → third item selected → shows "(current)"
picker.handleInput("\x1b[B");
picker.handleInput("j");
lines = picker.render(80);
assert(lines.some((l) => l.includes("❯") && l.includes("(current)")), "current marker on selected");

// Scrolling: go to the end, expect scroll indicator at top
for (let i = 0; i < 10; i++) picker.handleInput("\x1b[B");
lines = picker.render(80);
assert(lines.some((l) => l.includes("↑") && l.includes("more")), "scroll indicator");

// Enter → open action for last hit
picker.handleInput("\r");
assert.deepEqual((result as any).type, "open");
assert.equal((result as any).hit.path, hits[7]!.path);

// Escape → null
const picker2 = new ResultsPicker(hits, theme, (r) => (result = r), undefined);
picker2.handleInput("\x1b");
assert.equal(result, null);

// Copy action
const picker3 = new ResultsPicker(hits, theme, (r) => (result = r), undefined);
picker3.handleInput("c");
assert.equal((result as any).type, "copy");

console.log("picker tests passed");
