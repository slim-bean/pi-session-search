/** Deterministic lexical retrieval and corpus browsing. No model calls. */
import type { SessionIndex } from "./indexer.ts";
import { readSummary } from "./summary-store.ts";

export const HL_START = "\u0001";
export const HL_END = "\u0002";
export type SearchRole = "user" | "assistant" | "summary" | "custom" | "meta" | "generated";
export interface SearchHit {
  path: string; cwd: string; name: string | null; firstMessage: string | null;
  createdAt: number | null; modifiedAt: number; activityAt?: number | null; messageCount: number;
  hits: number; bestRank: number; metadataOnly?: boolean;
  summaryStatus?: string;
  summaryPreview?: string;
  snippets: { role: string; text: string; entryIndex: number | null; timestampMs?: number | null; sourceRefs?: number[] }[];
}
export interface QueryOptions { prefix?: boolean; match?: "all" | "any" }
export interface SearchOptions extends QueryOptions {
  query?: string;
  /** OR'd alternative queries, each internally AND'd. Combined with query using AND. */
  anyOf?: string[];
  project?: string;
  projectScope?: "exact" | "tree";
  excludePath?: string;
  since?: string;
  until?: string;
  dateField?: "activity" | "created" | "message";
  roles?: SearchRole[];
  sort?: "relevance" | "recent" | "oldest";
  offset?: number;
  limit?: number;
  snippets?: number;
  snippetChars?: number;
  /** Panel avoids the extra count pass on each keystroke. */
  count?: boolean;
}
export interface SearchPage {
  hits: SearchHit[]; total: number; offset: number; nextOffset?: number; options: SearchOptions;
}
export interface ProjectHit { cwd: string; sessions: number; messages: number; createdAt: number | null; activityAt: number | null }
export interface ProjectPage { projects: ProjectHit[]; total: number; offset: number; nextOffset?: number; options: SearchOptions }

/** Quote all user terms, never execute user-supplied FTS operators. Phrases remain stemmed. */
export function buildMatchQuery(input: string, options?: QueryOptions): string {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  const parts: string[] = [];
  for (const token of tokens) {
    const quoted = token.startsWith('"') && token.endsWith('"') && token.length >= 2;
    const inner = (quoted ? token.slice(1, -1) : token).trim();
    if (inner && /[\p{L}\p{N}]/u.test(inner)) parts.push(`"${inner.replace(/"/g, '""')}"${options?.prefix && !quoted ? "*" : ""}`);
  }
  return parts.join(options?.match === "any" ? " OR " : " ");
}

function matchExpression(options: SearchOptions): string {
  const base = buildMatchQuery(options.query ?? "", options);
  const alternatives = (options.anyOf ?? []).map((q) => buildMatchQuery(q, { prefix: options.prefix })).filter(Boolean);
  const clauses = [base, alternatives.map((q) => `(${q})`).join(" OR ")].filter(Boolean);
  return clauses.map((q) => `(${q})`).join(" AND ");
}

/** UTC date-only bounds; explicit timezone required on timestamps. until dates include the entire day. */
export function dateBound(input: string, end = false, now = Date.now()): number {
  const relative = /^(\d+)(h|d|w)$/.exec(input);
  if (relative) return now - Number(relative[1]) * ({ h: 3600000, d: 86400000, w: 604800000 }[relative[2]!]!);
  if (input === "today" || input === "yesterday") {
    const day = new Date(now).toISOString().slice(0, 10);
    return Date.parse(day) - (input === "yesterday" ? 86400000 : 0) + (end ? 86399999 : 0);
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input);
  if (!date && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
    throw new Error(`Invalid date "${input}". Use YYYY-MM-DD (UTC), an ISO timestamp with timezone, today/yesterday, or 7d/2w/24h.`);
  }
  const ms = Date.parse(input);
  const day = input.slice(0, 10);
  if (!Number.isFinite(ms) || new Date(Date.parse(day)).toISOString().slice(0, 10) !== day) throw new Error(`Invalid date "${input}".`);
  return ms + (date && end ? 86399999 : 0);
}

function selection(options: SearchOptions): { cte: string; params: (string | number)[]; match: string; chunkWhere: string; chunkParams: (string | number)[] } {
  const sessionWhere: string[] = [];
  const sessionParams: (string | number)[] = [];
  if (options.project) {
    if (options.projectScope === "tree") {
      const root = options.project.replace(/\/+$/, "") + "/";
      sessionWhere.push("(s.cwd = ? OR substr(s.cwd, 1, ?) = ?)");
      sessionParams.push(options.project, root.length, root);
    } else { sessionWhere.push("s.cwd = ?"); sessionParams.push(options.project); }
  }
  if (options.excludePath) { sessionWhere.push("s.path != ?"); sessionParams.push(options.excludePath); }
  const match = matchExpression(options);
  if (!match && ((options.query ?? "").trim() || options.anyOf?.some((q) => q.trim()))) {
    throw new Error("Query has no searchable words. Use an empty query to browse sessions.");
  }
  const chunks: string[] = [];
  const chunkParams: (string | number)[] = [];
  if (match) { chunks.push("chunks MATCH ?"); chunkParams.push(match); }
  if (options.roles?.length) {
    chunks.push(`role IN (${options.roles.map(() => "?").join(",")})`);
    chunkParams.push(...options.roles);
  }
  const now = Date.now();
  const since = options.since ? dateBound(options.since, false, now) : undefined;
  const until = options.until ? dateBound(options.until, true, now) : undefined;
  if (since !== undefined && until !== undefined && since > until) throw new Error("since must be before until.");
  const messageDates = options.dateField === "message";
  const field = messageDates ? "timestamp_ms" : options.dateField === "created" ? "s.created_at" : "s.activity_at";
  for (const [bound, op] of [[since, ">="], [until, "<="]] as const) {
    if (bound === undefined) continue;
    (messageDates ? chunks : sessionWhere).push(`${field} ${op} ?`);
    (messageDates ? chunkParams : sessionParams).push(bound);
  }
  const eligible = `SELECT s.path FROM sessions s${sessionWhere.length ? ` WHERE ${sessionWhere.join(" AND ")}` : ""}`;
  if (sessionWhere.length) {
    chunks.push(`session_path IN (${eligible})`);
    chunkParams.push(...sessionParams);
  }
  const chunkWhere = chunks.join(" AND ") || "1";
  const needChunks = Boolean(match || options.roles?.length || (messageDates && (since !== undefined || until !== undefined)));
  const cte = needChunks
    ? `WITH matches AS (SELECT session_path AS path, COUNT(*) AS hits, ${match ? "MIN(rank)" : "0"} AS best,
        MIN(CASE WHEN role = 'meta' THEN 1 ELSE 0 END) AS metadata_only
        FROM chunks WHERE ${chunkWhere} GROUP BY session_path),
        selected AS (SELECT s.*, m.hits, m.best, m.metadata_only FROM matches m JOIN sessions s ON s.path = m.path)`
    : `WITH selected AS (SELECT s.*, 0 AS hits, 0 AS best FROM sessions s${sessionWhere.length ? ` WHERE ${sessionWhere.join(" AND ")}` : ""})`;
  return { cte, params: needChunks ? chunkParams : sessionParams, match, chunkWhere, chunkParams };
}

function order(options: SearchOptions, hasQuery: boolean): string {
  const sort = options.sort ?? (hasQuery ? "relevance" : "recent");
  return sort === "relevance" && hasQuery ? "best ASC, activity_at DESC, path ASC"
    : `activity_at ${sort === "oldest" ? "ASC" : "DESC"}, path ASC`;
}

export function searchSessions(index: SessionIndex, options: SearchOptions = {}): SearchPage {
  const db = index.db;
  const query = selection(options);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? 10);
  const total = options.count === false ? -1 : Number((db.prepare(`${query.cte} SELECT COUNT(*) AS n FROM selected`).get(...query.params) as any).n);
  const rows = db.prepare(`${query.cte} SELECT * FROM selected ORDER BY ${order(options, Boolean(query.match))} LIMIT ? OFFSET ?`)
    .all(...query.params, limit, offset) as any[];
  const hits: SearchHit[] = rows.map((row) => {
    const summary = readSummary(db, row.path, row.conversation_hash);
    return {
      path: row.path, cwd: row.cwd, name: row.name, firstMessage: row.first_message,
      createdAt: row.created_at, activityAt: row.activity_at, modifiedAt: row.modified_at, messageCount: row.message_count,
      hits: query.match ? row.hits : 0, bestRank: row.best, metadataOnly: Boolean(query.match && row.metadata_only), snippets: [], summaryStatus: summary.status,
      summaryPreview: summary.status === "ready" ? summary.sections[0]?.summary.overview : undefined,
    };
  });
  const snippetCount = options.snippets ?? 3;
  if (query.match && hits.length && snippetCount > 0) {
    const wanted = new Map(hits.map((hit) => [hit.path, hit]));
    // Filter candidates to this page before limiting. The old global LIMIT 500 starved later hits.
    // No MATCH + rowid lookup: node:sqlite's FTS query planner can ignore that constraint.
    const candidates = db.prepare(`SELECT rowid AS id, session_path AS path, role, entry_index AS entryIndex,
      timestamp_ms AS timestampMs, source_refs AS sourceRefs FROM chunks WHERE ${query.chunkWhere}
      AND session_path IN (${hits.map(() => "?").join(",")}) ORDER BY rank`);
    const text = db.prepare(`SELECT text FROM chunks WHERE rowid = ?`);
    const tokens = [...extractTokens(options.query ?? ""), ...(options.anyOf ?? []).flatMap(extractTokens)];
    let filled = 0;
    for (const row of candidates.iterate(...query.chunkParams, ...wanted.keys()) as Iterable<any>) {
      const hit = wanted.get(row.path)!;
      if (row.role === "meta" || hit.snippets.length >= snippetCount) continue;
      const body = (text.get(row.id) as any)?.text;
      if (typeof body !== "string") continue;
      hit.snippets.push({
        role: row.role, text: makeSnippet(body, tokens, options.snippetChars ?? 360),
        entryIndex: row.entryIndex > 0 ? Number(row.entryIndex) : null, timestampMs: row.timestampMs,
        sourceRefs: row.sourceRefs ? JSON.parse(row.sourceRefs) : undefined,
      });
      if (hit.snippets.length === snippetCount) filled++;
      if (filled === hits.length) break;
    }
  }
  return { hits, total, offset, nextOffset: total > offset + hits.length ? offset + hits.length : undefined, options };
}

export function searchProjects(index: SessionIndex, options: SearchOptions = {}): ProjectPage {
  const { cte, params } = selection(options);
  const groups = `${cte}, projects AS (SELECT cwd, COUNT(*) AS sessions, SUM(message_count) AS messages,
    MIN(created_at) AS createdAt, MAX(activity_at) AS activityAt FROM selected GROUP BY cwd)`;
  const total = Number((index.db.prepare(`${groups} SELECT COUNT(*) AS n FROM projects`).get(...params) as any).n);
  const offset = Math.max(0, options.offset ?? 0);
  const projects = index.db.prepare(`${groups} SELECT * FROM projects ORDER BY sessions DESC, cwd LIMIT ? OFFSET ?`)
    .all(...params, options.limit ?? 20, offset) as unknown as ProjectHit[];
  return { projects, total, offset, nextOffset: total > offset + projects.length ? offset + projects.length : undefined, options };
}

/** Compatibility wrappers for the live panel and smoke tests. */
export function search(index: SessionIndex, input: string, limit = 20, options?: QueryOptions): SearchHit[] {
  if (!input.trim() || !buildMatchQuery(input, options)) return [];
  return searchSessions(index, { query: input, limit, ...options, count: false }).hits;
}
export function recentSessions(index: SessionIndex, limit = 20): SearchHit[] {
  return searchSessions(index, { limit, count: false }).hits;
}

export function extractTokens(input: string): string[] {
  return (input.match(/"[^"]*"|\S+/g) ?? []).map((token) => token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1) : token).map((token) => token.trim()).filter(Boolean);
}

/** Prefer a window covering multiple query terms over the first generic occurrence. */
export function makeSnippet(text: string, tokens: string[], windowChars = 360): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const escaped = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return clean.slice(0, windowChars) + (clean.length > windowChars ? " …" : "");
  // Display highlighting is approximate; FTS5 performs the actual stemming/tokenization.
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${escaped.join("|")})[\\p{L}\\p{N}_-]*`, "giu");
  const occurrences: { at: number; word: string }[] = [];
  for (const match of clean.matchAll(re)) {
    occurrences.push({ at: match.index!, word: match[0].toLowerCase() });
    if (occurrences.length >= 2000) break;
  }
  let anchor = occurrences[0]?.at ?? 0;
  let best = 0;
  for (let i = 0; i < occurrences.length; i++) {
    const words = new Set<string>();
    for (let j = i; j < occurrences.length && occurrences[j]!.at - occurrences[i]!.at < windowChars * 0.75; j++) words.add(occurrences[j]!.word);
    if (words.size > best) { best = words.size; anchor = occurrences[i]!.at; }
  }
  const start = Math.max(0, anchor - Math.floor(windowChars / 4));
  const end = Math.min(clean.length, start + windowChars);
  const snippet = clean.slice(start, end).replace(re, (word) => HL_START + word + HL_END);
  return (start ? "… " : "") + snippet + (end < clean.length ? " …" : "");
}
