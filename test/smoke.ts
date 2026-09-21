/**
 * Smoke test: build a throwaway index over real sessions and run a few searches.
 * Run: node test/smoke.ts [query]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex, defaultSessionsRoot } from "../extension/indexer.ts";
import { search, searchSessions } from "../extension/search.ts";

const dir = mkdtempSync(join(tmpdir(), "session-search-"));
const dbPath = join(dir, "index.db");
const index = new SessionIndex(dbPath);

const started = Date.now();
const result = await index.sync(defaultSessionsRoot(), (p) => {
  if (p.scanned % 50 === 0) console.log(`  indexing ${p.scanned}/${p.total}`);
});
console.log(
  `Synced ${result.totalFiles} files (${result.indexed} indexed, ${result.removed} removed) in ${Date.now() - started}ms`,
);

// Incremental re-sync should be a no-op and fast.
const started2 = Date.now();
const result2 = await index.sync(defaultSessionsRoot());
console.log(`Re-sync: ${result2.indexed} indexed in ${Date.now() - started2}ms`);

const query = process.argv[2] ?? "session search extension";
console.log(`\nQuery: ${JSON.stringify(query)}`);
for (const hit of search(index, query, 5)) {
  console.log(`\n  ${hit.name ?? hit.firstMessage?.slice(0, 60) ?? "(empty)"}`);
  console.log(`    ${hit.cwd}  (${hit.hits} hits, ${hit.messageCount} msgs)`);
  for (const snippet of hit.snippets.slice(0, 2)) {
    const clean = snippet.text.replace(/\s+/g, " ").replace(/\u0001/g, "[").replace(/\u0002/g, "]");
    console.log(`    ${snippet.role}: ${clean.slice(0, 140)}`);
  }
}

console.log("\nRetrieval timings (median of 3 runs):");
for (const term of ["semantic search", "embedding", "se", "th"]) {
  const elapsed: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    search(index, term, 20, { prefix: true });
    elapsed.push(performance.now() - start);
  }
  console.log(`  panel prefix ${JSON.stringify(term)}: ${elapsed.sort((a, b) => a - b)[1]!.toFixed(1)}ms`);
}
const scopedStart = performance.now();
const scoped = searchSessions(index, { project: process.cwd(), anyOf: ["embedding", "reranking", '"semantic search"'], limit: 5 });
console.log(`  scoped alternatives + count: ${(performance.now() - scopedStart).toFixed(1)}ms (${scoped.total} sessions)`);

index.close();
rmSync(dir, { recursive: true, force: true });
