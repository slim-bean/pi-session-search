/**
 * SQLite FTS5 index over all pi sessions.
 *
 * Zero dependencies: uses node:sqlite (Node >= 22 with FTS5 built in).
 * Index lives at ~/.pi/agent/session-search/index.db and is synced
 * incrementally by comparing file mtime + size against the index.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = "1";
const MAX_CHUNK_CHARS = 16_000;

export interface SyncProgress {
  scanned: number;
  total: number;
  indexed: number;
}

export interface SyncResult {
  totalFiles: number;
  indexed: number;
  removed: number;
}

interface Chunk {
  entryId: string;
  role: string;
  text: string;
}

interface ParsedSession {
  cwd: string;
  name: string | null;
  firstMessage: string | null;
  createdAt: number | null;
  messageCount: number;
  chunks: Chunk[];
}

export function defaultSessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

export function defaultDbPath(): string {
  return join(homedir(), ".pi", "agent", "session-search", "index.db");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function clip(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text;
}

export function parseSessionFile(path: string): ParsedSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  let header: any;
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      header = JSON.parse(line);
    } catch {
      return null;
    }
    headerIdx = i;
    break;
  }
  if (!header || header.type !== "session") return null;

  const parsed: ParsedSession = {
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name: null,
    firstMessage: null,
    createdAt: header.timestamp ? Date.parse(header.timestamp) || null : null,
    messageCount: 0,
    chunks: [],
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip corrupt lines
    }

    const id = typeof entry.id === "string" ? entry.id : "";
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (!msg) break;
        parsed.messageCount++;
        if (msg.role === "user") {
          const text = textFromContent(msg.content).trim();
          if (text) {
            if (!parsed.firstMessage) parsed.firstMessage = text.slice(0, 300);
            parsed.chunks.push({ entryId: id, role: "user", text: clip(text) });
          }
        } else if (msg.role === "assistant") {
          const text = textFromContent(msg.content).trim(); // text blocks only (skips thinking/toolCall)
          if (text) parsed.chunks.push({ entryId: id, role: "assistant", text: clip(text) });
        }
        break;
      }
      case "custom_message": {
        const text = textFromContent(entry.content).trim();
        if (text) parsed.chunks.push({ entryId: id, role: "custom", text: clip(text) });
        break;
      }
      case "compaction":
      case "branch_summary": {
        const text = typeof entry.summary === "string" ? entry.summary.trim() : "";
        if (text) parsed.chunks.push({ entryId: id, role: "summary", text: clip(text) });
        break;
      }
      case "session_info": {
        parsed.name = typeof entry.name === "string" && entry.name ? entry.name : null;
        break;
      }
    }
  }

  return parsed;
}

export class SessionIndex {
  readonly db: DatabaseSync;

  constructor(dbPath: string = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.ensureSchema();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (row && row.value !== SCHEMA_VERSION) {
      this.db.exec(`DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS chunks;`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        path TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        name TEXT,
        first_message TEXT,
        created_at INTEGER,
        modified_at INTEGER NOT NULL,
        size INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        text,
        session_path UNINDEXED,
        entry_id UNINDEXED,
        role UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
      .run(SCHEMA_VERSION);
  }

  /** Drop all indexed data (schema stays). Next sync() rebuilds from scratch. */
  reset(): void {
    this.db.exec(`DELETE FROM sessions; DELETE FROM chunks;`);
  }

  /**
   * Incrementally sync the index with session files on disk.
   * Yields to the event loop periodically so the TUI can repaint.
   */
  async sync(
    sessionsRoot: string = defaultSessionsRoot(),
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncResult> {
    const files = this.scanFiles(sessionsRoot);

    const known = new Map<string, { modified_at: number; size: number }>();
    for (const row of this.db.prepare(`SELECT path, modified_at, size FROM sessions`).all() as any[]) {
      known.set(row.path, { modified_at: row.modified_at, size: row.size });
    }

    const toIndex = files.filter((f) => {
      const k = known.get(f.path);
      return !k || k.modified_at !== f.mtimeMs || k.size !== f.size;
    });
    const onDisk = new Set(files.map((f) => f.path));
    const toRemove = [...known.keys()].filter((p) => !onDisk.has(p));

    let indexed = 0;
    for (const file of toIndex) {
      const parsed = parseSessionFile(file.path);
      if (parsed) {
        this.upsert(file.path, file.mtimeMs, file.size, parsed);
        indexed++;
      } else {
        this.remove(file.path);
      }
      if (indexed % 5 === 0) {
        onProgress?.({ scanned: indexed, total: toIndex.length, indexed });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    for (const path of toRemove) this.remove(path);

    onProgress?.({ scanned: toIndex.length, total: toIndex.length, indexed });
    return { totalFiles: files.length, indexed, removed: toRemove.length };
  }

  private scanFiles(sessionsRoot: string): { path: string; mtimeMs: number; size: number }[] {
    const files: { path: string; mtimeMs: number; size: number }[] = [];
    if (!existsSync(sessionsRoot)) return files;
    for (const dirEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      const dir = join(sessionsRoot, dirEntry.name);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (st.isFile()) files.push({ path, mtimeMs: Math.round(st.mtimeMs), size: st.size });
        } catch {
          // race: file deleted mid-scan
        }
      }
    }
    return files;
  }

  private upsert(path: string, mtimeMs: number, size: number, parsed: ParsedSession): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM chunks WHERE session_path = ?`).run(path);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sessions
           (path, cwd, name, first_message, created_at, modified_at, size, message_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          path,
          parsed.cwd,
          parsed.name,
          parsed.firstMessage,
          parsed.createdAt,
          mtimeMs,
          size,
          parsed.messageCount,
        );
      const insert = this.db.prepare(
        `INSERT INTO chunks (text, session_path, entry_id, role) VALUES (?, ?, ?, ?)`,
      );
      // Meta chunk so folder names and session names are searchable.
      insert.run([parsed.name, parsed.cwd, basename(path)].filter(Boolean).join(" "), path, "", "meta");
      for (const chunk of parsed.chunks) {
        insert.run(chunk.text, path, chunk.entryId, chunk.role);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private remove(path: string): void {
    this.db.prepare(`DELETE FROM chunks WHERE session_path = ?`).run(path);
    this.db.prepare(`DELETE FROM sessions WHERE path = ?`).run(path);
  }
}
