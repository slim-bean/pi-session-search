/** Small deterministic sessions for unit/evaluation fixtures; never touch user data. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const when = "2026-07-22T12:00:00.000Z";
export function message(role: string, text: string, at = when, extra: any = {}): any {
  return { type: "message", timestamp: at, message: { role, content: [{ type: "text", text }], ...extra } };
}
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-search-test-"));
  const root = join(dir, "sessions");
  mkdirSync(root);
  let clock = Date.now();
  const write = (name: string, cwd: string, entries: any[], created = when): string => {
    const folder = join(root, "project");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${name}.jsonl`);
    const lines = [{ type: "session", id: name, version: 3, timestamp: created, cwd }, ...entries.map((entry, i) => {
      if (entry === null || typeof entry === "string") return entry;
      return { id: `e${i + 1}`, parentId: i ? `e${i}` : null, ...entry };
    })];
    writeFileSync(path, lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
    clock += 1000;
    utimesSync(path, clock / 1000, clock / 1000);
    return path;
  };
  return { dir, root, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
