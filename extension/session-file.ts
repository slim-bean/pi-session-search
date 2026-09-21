/** Shared JSONL parsing and conversation extraction. Original ordinals never change with views. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ConversationEntry {
  index: number;
  id: string;
  parentId: string | null;
  timestampMs: number | null;
  role: "user" | "assistant";
  text: string;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text).join("\n");
}

export function timestamp(value: unknown): number | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

export function conversationEntry(entry: any, index: number): ConversationEntry | null {
  const msg = entry?.type === "message" ? entry.message : null;
  if (msg?.role !== "user" && msg?.role !== "assistant") return null;
  const text = textFromContent(msg.content);
  if (!text.trim()) return null;
  return {
    index, id: typeof entry.id === "string" ? entry.id : "",
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    timestampMs: timestamp(entry.timestamp) ?? timestamp(msg.timestamp), role: msg.role, text,
  };
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readSessionSource(path: string): {
  header: any; entries: { index: number; value: any }[]; fileSize: number;
} {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error: any) {
    if (error.code === "ENOENT") throw new Error(`Session file not found: ${path}`);
    throw error;
  }
  const lines = raw.split("\n");
  const first = lines.findIndex((line) => line.trim());
  let header: any;
  try { header = JSON.parse(lines[first] ?? ""); }
  catch { throw new Error(`Not a pi session file (unparseable first line): ${path}`); }
  if (header?.type !== "session") throw new Error(`Not a pi session file (missing session header): ${path}`);
  const entries: { index: number; value: any }[] = [];
  for (const line of lines.slice(first + 1)) {
    if (!line.trim()) continue;
    let value: any;
    try { value = JSON.parse(line); } catch { continue; }
    // Every successfully parsed line counts, including unknown/null entries.
    entries.push({ index: entries.length + 1, value: value ?? {} });
  }
  return { header, entries, fileSize: Buffer.byteLength(raw) };
}
