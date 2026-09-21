/** Incremental SQLite FTS5 index. Source text is never truncated. */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { conversationEntry, fingerprint, readSessionSource, textFromContent, timestamp, type ConversationEntry } from "./session-file.ts";
import { ensureSummarySchema, publishSummaryChunks, SUMMARY_VERSION } from "./summary-store.ts";

const SCHEMA_VERSION = "4";
export interface SyncProgress { total: number; scanned: number; indexed: number }
export interface SyncResult { totalFiles: number; indexed: number; removed: number; skipped: number }
interface Chunk {
  entryId: string;
  entryIndex: number;
  role: string;
  timestampMs: number | null;
  text: string;
}
export interface ParsedSession {
  cwd: string;
  name: string | null;
  firstMessage: string | null;
  createdAt: number | null;
  activityAt: number | null;
  messageCount: number;
  conversationHash: string;
  chunks: Chunk[];
}

export function defaultSessionsRoot(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
}
export function defaultDbPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "session-search", "index.db");
}

export function parseSessionFile(path: string): ParsedSession | null {
  let source: ReturnType<typeof readSessionSource>;
  try { source = readSessionSource(path); } catch { return null; }
  const { header, entries } = source;
  const parsed: ParsedSession = {
    cwd: typeof header.cwd === "string" ? header.cwd : "", name: null, firstMessage: null,
    createdAt: timestamp(header.timestamp), activityAt: null, messageCount: 0, conversationHash: "", chunks: [],
  };
  const conversation: ConversationEntry[] = [];
  for (const { index, value: entry } of entries) {
    const id = typeof entry.id === "string" ? entry.id : "";
    const when = timestamp(entry.timestamp) ?? timestamp(entry.message?.timestamp);
    const message = conversationEntry(entry, index);
    if (message) {
      conversation.push(message);
      if (message.timestampMs !== null) parsed.activityAt = Math.max(parsed.activityAt ?? -Infinity, message.timestampMs);
    }
    let role: string | undefined;
    let text = "";
    switch (entry.type) {
      case "message": {
        if (!entry.message) break;
        parsed.messageCount++;
        if (message) {
          role = message.role;
          text = message.text;
          if (role === "user" && !parsed.firstMessage) parsed.firstMessage = text.slice(0, 300);
        }
        break;
      }
      case "custom_message": role = "custom"; text = textFromContent(entry.content).trim(); break;
      case "compaction":
      case "branch_summary": role = "summary"; text = typeof entry.summary === "string" ? entry.summary.trim() : ""; break;
      case "session_info": parsed.name = typeof entry.name === "string" && entry.name ? entry.name : null; break;
    }
    if (role && text) parsed.chunks.push({ entryId: id, entryIndex: index, role, text, timestampMs: when });
  }
  parsed.activityAt ??= parsed.createdAt;
  parsed.conversationHash = fingerprint(conversation);
  return parsed;
}

export class SessionIndex {
  readonly db: DatabaseSync;
  private syncing: Promise<SyncResult> | undefined;

  constructor(dbPath = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.ensureSchema();
  }
  close(): void { this.db.close(); }
  /** Shutdown may race a yielding sync. Let it finish before closing SQLite. */
  async dispose(): Promise<void> {
    try { await this.syncing; } finally { this.close(); }
  }

  private ensureSchema(): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
      const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as any;
      if (version && version.value !== SCHEMA_VERSION) db.exec(`DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS chunks;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          path TEXT PRIMARY KEY, cwd TEXT NOT NULL, name TEXT, first_message TEXT,
          created_at INTEGER, activity_at INTEGER, modified_at INTEGER NOT NULL,
          size INTEGER NOT NULL, message_count INTEGER NOT NULL, conversation_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);
        CREATE INDEX IF NOT EXISTS sessions_activity ON sessions(activity_at);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
          text, session_path UNINDEXED, entry_id UNINDEXED, entry_index UNINDEXED,
          role UNINDEXED, timestamp_ms UNINDEXED, source_refs UNINDEXED,
          tokenize = 'porter unicode61', prefix = '2 3 4'
        );
      `);
      // Summary caches survive FTS schema rebuilds; freshness is checked before reuse.
      ensureSummarySchema(db);
      db.prepare(`INSERT OR REPLACE INTO meta VALUES ('schema_version', ?)`).run(SCHEMA_VERSION);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** Rebuild lexical data, preserving paid-for summaries and their provenance. */
  reset(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.exec("DELETE FROM sessions; DELETE FROM chunks; COMMIT;"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Share concurrent tool syncs rather than overlapping scans/writes. */
  sync(root: string, onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncFiles(root, onProgress).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async syncFiles(root: string, onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    // A temporarily unavailable root must not delete the entire existing index/cache.
    if (!existsSync(root)) {
      if (this.db.prepare("SELECT 1 FROM sessions LIMIT 1").get()) throw new Error(`Session directory unavailable: ${root}. Existing index retained, but freshness cannot be checked.`);
      return { totalFiles: 0, indexed: 0, removed: 0, skipped: 0 };
    }
    const files = this.scanFiles(root);
    const known = new Map<string, { modified_at: number; size: number }>();
    for (const row of this.db.prepare(`SELECT path, modified_at, size FROM sessions`).all() as any[]) known.set(row.path, row);
    const changed = files.filter((file) => {
      const old = known.get(file.path);
      return !old || old.modified_at !== file.mtimeMs || old.size !== file.size;
    });
    const onDisk = new Set(files.map((f) => f.path));
    const removed = [...known.keys()].filter((path) => !onDisk.has(path));
    let indexed = 0;
    let skipped = 0;
    for (const [i, file] of changed.entries()) {
      const parsed = parseSessionFile(file.path);
      if (parsed) { this.upsert(file.path, file.mtimeMs, file.size, parsed); indexed++; }
      else skipped++;
      // A partially written/corrupt file isn't evidence of deletion. Retry on next sync.
      if (i % 5 === 0) {
        onProgress?.({ scanned: i + 1, total: changed.length, indexed });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    for (const path of removed) this.remove(path);
    // A prompt/version change also invalidates generated FTS rows, even when
    // source files haven't changed and therefore aren't reparsed this sync.
    for (const row of this.db.prepare(`SELECT m.session_path FROM summaries m JOIN sessions s ON s.path = m.session_path
      WHERE m.version != ? OR m.source_hash != s.conversation_hash`).all(SUMMARY_VERSION) as any[]) {
      this.db.prepare(`DELETE FROM chunks WHERE session_path = ? AND role = 'generated'`).run(row.session_path);
    }
    // Caches retained by reset() also need cleanup for deleted sessions.
    for (const row of this.db.prepare(`SELECT session_path FROM summaries UNION SELECT session_path FROM summary_cache`).all() as any[]) {
      if (!onDisk.has(row.session_path)) this.remove(row.session_path);
    }
    onProgress?.({ scanned: changed.length, total: changed.length, indexed });
    return { totalFiles: files.length, indexed, removed: removed.length, skipped };
  }

  private scanFiles(root: string): { path: string; mtimeMs: number; size: number }[] {
    const files: { path: string; mtimeMs: number; size: number }[] = [];
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const folder = join(root, dir.name);
      for (const name of readdirSync(folder)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(folder, name);
        try {
          const stat = statSync(path);
          if (stat.isFile()) files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
    }
    return files;
  }

  private upsert(path: string, mtime: number, size: number, parsed: ParsedSession): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`DELETE FROM chunks WHERE session_path = ?`).run(path);
      db.prepare(`INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(path, parsed.cwd, parsed.name, parsed.firstMessage, parsed.createdAt, parsed.activityAt,
          mtime, size, parsed.messageCount, parsed.conversationHash);
      const insert = db.prepare(`INSERT INTO chunks
        (text, session_path, entry_id, entry_index, role, timestamp_ms, source_refs) VALUES (?, ?, ?, ?, ?, ?, NULL)`);
      insert.run([parsed.name, parsed.cwd, basename(path)].filter(Boolean).join(" "), path, "", 0, "meta", null);
      for (const chunk of parsed.chunks) insert.run(chunk.text, path, chunk.entryId, chunk.entryIndex, chunk.role, chunk.timestampMs);
      publishSummaryChunks(db, path, parsed.conversationHash);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private remove(path: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, column] of [["chunks", "session_path"], ["sessions", "path"], ["summaries", "session_path"], ["summary_cache", "session_path"]]) {
        this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(path);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
