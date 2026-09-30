/** Rebuildable, model/version-keyed summary cache. Never writes source sessions. */
import type { DatabaseSync } from "node:sqlite";

export const SUMMARY_VERSION = "1";
export interface TopicSummary {
  title: string;
  summary: string;
  keywords: string[];
  entries: number[];
}
export interface SectionSummary { overview: string; topics: TopicSummary[] }
export interface StoredSection {
  hash: string;
  startIndex: number;
  endIndex: number;
  /** Exact input spans, including partial oversized messages (UTF-16 offsets). */
  spans: { index: number; startChar: number; endChar: number }[];
  summary: SectionSummary;
  generatedAt: number;
}
export interface SummaryRecord {
  status: "ready" | "stale" | "partial" | "missing";
  model?: string;
  version?: string;
  generatedAt?: number;
  sourceHash?: string;
  sections: StoredSection[];
}

export function ensureSummarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_cache (
      session_path TEXT NOT NULL, section_hash TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL,
      section_json TEXT NOT NULL,
      PRIMARY KEY (session_path, section_hash, model, version)
    );
    CREATE TABLE IF NOT EXISTS summaries (
      session_path TEXT PRIMARY KEY, source_hash TEXT NOT NULL, model TEXT NOT NULL,
      version TEXT NOT NULL, section_hashes TEXT NOT NULL, generated_at INTEGER NOT NULL
    );
    -- Per-call accounting (no conversation text). Feeds calibrated estimates.
    CREATE TABLE IF NOT EXISTS summary_calls (
      id INTEGER PRIMARY KEY, model TEXT NOT NULL, version TEXT NOT NULL, purpose TEXT NOT NULL,
      session_path TEXT NOT NULL, section_hash TEXT NOT NULL, input_chars INTEGER NOT NULL,
      started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT,
      stop_reason TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, cost REAL NOT NULL,
      output_chars INTEGER NOT NULL, topics INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS summary_calls_model ON summary_calls(model, version);
  `);
}

export interface CallRecord {
  model: string; purpose: string; sessionPath: string; sectionHash: string; inputChars: number;
  startedAt: number; durationMs: number; ok: boolean; error?: string; stopReason?: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  cost: number; outputChars: number; topics: number;
}

export function logCall(db: DatabaseSync, call: CallRecord): void {
  db.prepare(`INSERT INTO summary_calls (model, version, purpose, session_path, section_hash, input_chars, started_at,
    duration_ms, ok, error, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, output_chars, topics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    call.model, SUMMARY_VERSION, call.purpose, call.sessionPath, call.sectionHash, call.inputChars, call.startedAt,
    call.durationMs, call.ok ? 1 : 0, call.error ?? null, call.stopReason ?? null, call.inputTokens, call.outputTokens,
    call.cacheReadTokens, call.cacheWriteTokens, call.cost, call.outputChars, call.topics);
}

export function cachedSection(db: DatabaseSync, path: string, hash: string, model: string): StoredSection | undefined {
  const row = db.prepare(`SELECT section_json FROM summary_cache
    WHERE session_path = ? AND section_hash = ? AND model = ? AND version = ?`)
    .get(path, hash, model, SUMMARY_VERSION) as { section_json: string } | undefined;
  return row ? JSON.parse(row.section_json) : undefined;
}

export function saveSection(db: DatabaseSync, path: string, model: string, section: StoredSection): void {
  db.prepare(`INSERT OR REPLACE INTO summary_cache VALUES (?, ?, ?, ?, ?)`)
    .run(path, section.hash, model, SUMMARY_VERSION, JSON.stringify(section));
}

export function readSummary(db: DatabaseSync, path: string, sourceHash: string): SummaryRecord {
  const row = db.prepare(`SELECT * FROM summaries WHERE session_path = ?`).get(path) as any;
  if (!row) {
    const partial = db.prepare(`SELECT 1 FROM summary_cache WHERE session_path = ? LIMIT 1`).get(path);
    return { status: partial ? "partial" : "missing", sections: [] };
  }
  const hashes = JSON.parse(row.section_hashes) as string[];
  const sections = hashes.map((hash) => {
    const cached = db.prepare(`SELECT section_json FROM summary_cache
      WHERE session_path = ? AND section_hash = ? AND model = ? AND version = ?`)
      .get(path, hash, row.model, row.version) as any;
    return cached ? JSON.parse(cached.section_json) as StoredSection : undefined;
  });
  return {
    status: row.source_hash === sourceHash && row.version === SUMMARY_VERSION && sections.every(Boolean) ? "ready" : "stale",
    model: row.model, version: row.version, generatedAt: row.generated_at, sourceHash: row.source_hash,
    sections: sections.filter((s): s is StoredSection => Boolean(s)),
  };
}

/** Caller owns the transaction. Only complete, fresh summaries enter FTS. */
export function publishSummaryChunks(db: DatabaseSync, path: string, sourceHash: string): void {
  db.prepare(`DELETE FROM chunks WHERE session_path = ? AND role = 'generated'`).run(path);
  const record = readSummary(db, path, sourceHash);
  if (record.status !== "ready") return;
  const insert = db.prepare(`INSERT INTO chunks
    (text, session_path, entry_id, entry_index, role, timestamp_ms, source_refs)
    VALUES (?, ?, ?, ?, 'generated', NULL, ?)`);
  for (const [i, section] of record.sections.entries()) {
    for (const [j, topic] of section.summary.topics.entries()) {
      insert.run(`${topic.title}\n${topic.summary}\n${topic.keywords.join(" ")}`, path,
        `summary:${i}:${j}`, topic.entries[0]!, JSON.stringify(topic.entries));
    }
  }
}

export function commitSummary(db: DatabaseSync, path: string, sourceHash: string, model: string, hashes: string[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Index may have been updated concurrently by another pi process.
    const indexed = db.prepare(`SELECT conversation_hash FROM sessions WHERE path = ?`).get(path) as any;
    if (indexed?.conversation_hash !== sourceHash) throw new Error("Session changed during summarization; cached sections retained. Run again.");
    if (hashes.some((hash) => !cachedSection(db, path, hash, model))) throw new Error("Summary sections are incomplete.");
    db.prepare(`INSERT OR REPLACE INTO summaries VALUES (?, ?, ?, ?, ?, ?)`)
      .run(path, sourceHash, model, SUMMARY_VERSION, JSON.stringify(hashes), Date.now());
    publishSummaryChunks(db, path, sourceHash);
    // Do not prune other model/version caches here: another pi process may be
    // generating them concurrently. Deleting a session cleans up all its caches.
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
