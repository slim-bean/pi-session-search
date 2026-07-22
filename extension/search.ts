/**
 * Full-text search over the session index (FTS5 BM25, grouped by session).
 */
import type { SessionIndex } from "./indexer.ts";

/** Snippet highlight markers (rendered by the UI as accent/bold). */
export const HL_START = "\u0001";
export const HL_END = "\u0002";

export interface SearchHit {
  path: string;
  cwd: string;
  name: string | null;
  firstMessage: string | null;
  createdAt: number | null;
  modifiedAt: number;
  messageCount: number;
  /** Number of matching chunks in this session. */
  hits: number;
  /** Best BM25 rank (lower = better). */
  bestRank: number;
  snippets: { role: string; text: string }[];
}

/**
 * Convert free-form user input into a safe FTS5 MATCH expression.
 * Quoted phrases are preserved; every other token is quoted (implicit AND).
 */
export function buildMatchQuery(input: string): string {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  const parts: string[] = [];
  for (const token of tokens) {
    const inner =
      token.startsWith('"') && token.endsWith('"') && token.length >= 2
        ? token.slice(1, -1)
        : token;
    const escaped = inner.replace(/"/g, '""').trim();
    if (escaped) parts.push(`"${escaped}"`);
  }
  return parts.join(" ");
}

export function search(index: SessionIndex, input: string, limit = 20): SearchHit[] {
  const match = buildMatchQuery(input);
  if (!match) return [];
  const db = index.db;

  const groups = db
    .prepare(
      `SELECT session_path AS path, COUNT(*) AS hits, MIN(rank) AS best
       FROM chunks WHERE chunks MATCH ?
       GROUP BY session_path
       ORDER BY best
       LIMIT ?`,
    )
    .all(match, limit) as { path: string; hits: number; best: number }[];
  if (groups.length === 0) return [];

  const sessionStmt = db.prepare(
    `SELECT cwd, name, first_message, created_at, modified_at, message_count
     FROM sessions WHERE path = ?`,
  );
  const snippetStmt = db.prepare(
    `SELECT role, snippet(chunks, 0, ?, ?, ' … ', 14) AS snip
     FROM chunks WHERE chunks MATCH ? AND session_path = ?
     ORDER BY rank
     LIMIT 3`,
  );

  const results: SearchHit[] = [];
  for (const group of groups) {
    const session = sessionStmt.get(group.path) as any;
    if (!session) continue;
    const snippets = (snippetStmt.all(HL_START, HL_END, match, group.path) as any[])
      .filter((row) => row.role !== "meta" && row.snip)
      .map((row) => ({ role: row.role as string, text: row.snip as string }));
    results.push({
      path: group.path,
      cwd: session.cwd,
      name: session.name ?? null,
      firstMessage: session.first_message ?? null,
      createdAt: session.created_at ?? null,
      modifiedAt: session.modified_at,
      messageCount: session.message_count,
      hits: group.hits,
      bestRank: group.best,
      snippets,
    });
  }
  return results;
}
