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

export interface QueryOptions {
  /**
   * Treat every unquoted token as a prefix (`"tok"*`) so partial words match
   * while typing (fzf-style). Quoted phrases stay exact.
   */
  prefix?: boolean;
}

/**
 * Convert free-form user input into a safe FTS5 MATCH expression.
 * Quoted phrases are preserved; every other token is quoted (implicit AND).
 */
export function buildMatchQuery(input: string, options?: QueryOptions): string {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  const parts: string[] = [];
  for (const token of tokens) {
    const isQuoted = token.startsWith('"') && token.endsWith('"') && token.length >= 2;
    const inner = isQuoted ? token.slice(1, -1) : token;
    const escaped = inner.replace(/"/g, '""').trim();
    if (escaped) {
      parts.push(`"${escaped}"` + (options?.prefix && !isQuoted ? "*" : ""));
    }
  }
  return parts.join(" ");
}

export function search(
  index: SessionIndex,
  input: string,
  limit = 20,
  options?: QueryOptions,
): SearchHit[] {
  const match = buildMatchQuery(input, options);
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

  // One global pass for snippet candidates (rowids only), then fetch chunk
  // text by plain rowid and build snippets in JS. Running FTS snippet()
  // per session re-evaluates the full-text match ~20 times (10x slower), and
  // `MATCH ? AND rowid = ?` mis-plans in some SQLite builds.
  const wanted = new Set(groups.map((g) => g.path));
  const candidates = db
    .prepare(
      `SELECT rowid AS id, session_path AS path, role
       FROM chunks WHERE chunks MATCH ?
       ORDER BY rank
       LIMIT 500`,
    )
    .all(match) as { id: number; path: string; role: string }[];
  const snippetRows = new Map<string, { id: number; role: string }[]>();
  for (const row of candidates) {
    if (!wanted.has(row.path) || row.role === "meta") continue;
    const list = snippetRows.get(row.path) ?? [];
    if (list.length < 3) {
      list.push({ id: row.id, role: row.role });
      snippetRows.set(row.path, list);
    }
  }
  const textStmt = db.prepare(`SELECT text FROM chunks WHERE rowid = ?`);
  const tokens = extractTokens(input);

  const results: SearchHit[] = [];
  for (const group of groups) {
    const session = sessionStmt.get(group.path) as any;
    if (!session) continue;
    const snippets: { role: string; text: string }[] = [];
    for (const row of snippetRows.get(group.path) ?? []) {
      const text = (textStmt.get(row.id) as any)?.text;
      if (typeof text === "string" && text) {
        snippets.push({ role: row.role, text: makeSnippet(text, tokens) });
      }
    }
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

/** Plain search terms from user input (quotes stripped), for highlighting. */
export function extractTokens(input: string): string[] {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  return tokens
    .map((t) => (t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t))
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Build a highlighted snippet around the first token occurrence.
 * Tokens highlight as word prefixes ("sess" lights up "sessions"), which
 * matches the prefix/stemmed FTS behavior closely enough for display.
 */
export function makeSnippet(text: string, tokens: string[], windowChars = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();

  let first = -1;
  for (const token of tokens) {
    const needle = token.toLowerCase();
    let from = 0;
    while (from <= lower.length) {
      const i = lower.indexOf(needle, from);
      if (i === -1) break;
      if (i === 0 || !/[\w-]/.test(lower[i - 1]!)) {
        if (first === -1 || i < first) first = i;
        break;
      }
      from = i + 1;
    }
  }

  const anchor = first === -1 ? 0 : first;
  const start = Math.max(0, anchor - Math.floor(windowChars / 4));
  const end = Math.min(clean.length, start + windowChars);
  let slice = clean.slice(start, end);

  if (tokens.length > 0) {
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(?<![\\w-])(?:${escaped.join("|")})[\\w-]*`, "gi");
    slice = slice.replace(re, (m) => HL_START + m + HL_END);
  }

  return (start > 0 ? "… " : "") + slice + (end < clean.length ? " …" : "");
}

/** Most recently modified sessions — shown while the query is empty. */
export function recentSessions(index: SessionIndex, limit = 20): SearchHit[] {
  const rows = index.db
    .prepare(
      `SELECT path, cwd, name, first_message, created_at, modified_at, message_count
       FROM sessions ORDER BY modified_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
  return rows.map((row) => ({
    path: row.path,
    cwd: row.cwd,
    name: row.name ?? null,
    firstMessage: row.first_message ?? null,
    createdAt: row.created_at ?? null,
    modifiedAt: row.modified_at,
    messageCount: row.message_count,
    hits: 0,
    bestRank: 0,
    snippets: [],
  }));
}
