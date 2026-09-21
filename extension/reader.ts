/**
 * Full session-file reader for the session_read tool.
 *
 * indexer.parseSessionFile extracts only searchable text (no tool calls, tool
 * output, or thinking). This module renders EVERY entry so the LLM can
 * outline a session and read selected entries in full. Entry ordinals here
 * count every successfully parsed entry line after the header — exactly like
 * the indexer — so `chunks.entry_index` in the FTS index lines up with the
 * #indices shown by session_read, and a session_search snippet labelled
 * `[user #42]` can be read with `entries:"42"`.
 *
 * Session file format: see pi docs docs/session-format.md.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { conversationEntry, readSessionSource, timestamp, type ConversationEntry } from "./session-file.ts";

const PREVIEW_CHARS = 110;

export interface ReadEntry {
  /** 1-based ordinal in file order (matches chunks.entry_index). */
  index: number;
  id: string;
  parentId: string | null;
  /** User/assistant text blocks only; no thinking, tools, or image payloads. */
  conversationText: string;
  /** Compact kind label: user, assistant, tool:bash, shell, compaction, ... */
  kind: string;
  timestampMs: number | null;
  /** Full rendered text (tool args, tool output, thinking included). */
  text: string;
  /** One-line collapsed preview for the outline. */
  preview: string;
  /** Tool names called (assistant entries only). */
  toolNames: string[];
}

export interface LoadedSession {
  path: string;
  cwd: string;
  createdAt: number | null;
  name: string | null;
  fileSize: number;
  messageCount: number;
  entries: ReadEntry[];
}

/** Expand ~/, strip a leading @ (some models add it), resolve against cwd. */
export function resolveSessionPath(input: string, cwd: string): string {
  let path = input.trim().replace(/^@/, "");
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  return resolve(cwd, path);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push(block.mimeType ? `[image ${block.mimeType}]` : "[image]");
  }
  return parts.join("\n");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function makePreview(text: string): string {
  const clean = collapse(text);
  return clean.length > PREVIEW_CHARS ? `${clean.slice(0, PREVIEW_CHARS - 1)}…` : clean;
}

interface Rendered {
  kind: string;
  text: string;
  /** Preferred preview source (e.g. assistant text without thinking/tool args). */
  previewSource?: string;
  toolNames?: string[];
}

function renderMessage(msg: any): Rendered {
  switch (msg?.role) {
    case "user":
      return { kind: "user", text: contentToText(msg.content) };
    case "assistant": {
      const parts: string[] = [];
      const textParts: string[] = [];
      const toolNames: string[] = [];
      if (typeof msg.content === "string") {
        parts.push(msg.content);
        textParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block) continue;
          if (block.type === "thinking" && block.thinking) {
            parts.push(`[thinking] ${block.thinking}`);
          } else if (block.type === "text" && block.text) {
            parts.push(block.text);
            textParts.push(block.text);
          } else if (block.type === "toolCall") {
            toolNames.push(String(block.name ?? "?"));
            let args: string;
            try {
              args = JSON.stringify(block.arguments ?? {});
            } catch {
              args = "[unserializable arguments]";
            }
            parts.push(`→ ${block.name}(${args})`);
          }
        }
      }
      if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse") {
        parts.push(`[stopReason: ${msg.stopReason}${msg.errorMessage ? ` — ${msg.errorMessage}` : ""}]`);
      }
      return { kind: "assistant", text: parts.join("\n"), previewSource: textParts.join(" "), toolNames };
    }
    case "toolResult":
      return {
        kind: `tool:${msg.toolName ?? "?"}${msg.isError ? " (error)" : ""}`,
        text: contentToText(msg.content),
      };
    case "bashExecution": {
      const exit = typeof msg.exitCode === "number" && msg.exitCode !== 0 ? `\n[exit ${msg.exitCode}]` : "";
      return { kind: "shell", text: `$ ${msg.command ?? ""}\n${msg.output ?? ""}${exit}` };
    }
    case "custom":
      return { kind: `custom:${msg.customType ?? "?"}`, text: contentToText(msg.content) };
    case "branchSummary":
      return { kind: "branch-summary", text: typeof msg.summary === "string" ? msg.summary : "" };
    case "compactionSummary":
      return { kind: "compaction", text: typeof msg.summary === "string" ? msg.summary : "" };
    default:
      return { kind: msg?.role ? String(msg.role) : "unknown", text: contentToText(msg?.content) };
  }
}

function renderEntry(entry: any): Rendered {
  switch (entry.type) {
    case "message":
      return renderMessage(entry.message);
    case "custom_message":
      return { kind: `custom:${entry.customType ?? "?"}`, text: contentToText(entry.content) };
    case "compaction": {
      const tail = Array.isArray(entry.retainedTail)
        ? `\n[retained tail: ${entry.retainedTail.length} messages, duplicated from entries above]`
        : "";
      return { kind: "compaction", text: `${typeof entry.summary === "string" ? entry.summary : ""}${tail}` };
    }
    case "branch_summary":
      return { kind: "branch-summary", text: typeof entry.summary === "string" ? entry.summary : "" };
    case "session_info":
      return { kind: "info", text: `session named: ${entry.name ?? ""}` };
    case "model_change":
      return { kind: "model", text: `${entry.provider ?? "?"}/${entry.modelId ?? "?"}` };
    case "thinking_level_change":
      return { kind: "thinking-level", text: String(entry.thinkingLevel ?? "") };
    case "label":
      return {
        kind: "label",
        text: entry.label ? `"${entry.label}" on ${entry.targetId}` : `label cleared on ${entry.targetId}`,
      };
    case "custom":
      return { kind: `state:${entry.customType ?? "?"}`, text: "[extension state entry, not in LLM context]" };
    default:
      return { kind: String(entry.type ?? "unknown"), text: "" };
  }
}

/** Parse a session file into fully rendered entries. Throws on bad files. */
export function loadSessionFile(path: string): LoadedSession {
  const { header, entries, fileSize } = readSessionSource(path);

  const session: LoadedSession = {
    path,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    createdAt: timestamp(header.timestamp),
    name: null,
    fileSize,
    messageCount: 0,
    entries: [],
  };

  for (const { index, value: entry } of entries) {
    if (entry.type === "message" && entry.message) session.messageCount++;
    if (entry.type === "session_info") {
      session.name = typeof entry.name === "string" && entry.name ? entry.name : null;
    }

    const rendered = renderEntry(entry);
    session.entries.push({
      index,
      id: typeof entry.id === "string" ? entry.id : "",
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      conversationText: conversationEntry(entry, index)?.text ?? "",
      kind: rendered.kind,
      timestampMs: timestamp(entry.timestamp) ?? timestamp(entry.message?.timestamp),
      text: rendered.text,
      preview: makePreview(rendered.previewSource || rendered.text),
      toolNames: rendered.toolNames ?? [],
    });
  }

  return session;
}

export interface ViewOptions {
  view?: "conversation" | "full";
  roles?: ("user" | "assistant")[];
}

/** Projection only: never renumber or mutate the loaded source entries. */
export function visibleEntries(session: LoadedSession, options: ViewOptions = {}): ReadEntry[] {
  return session.entries.flatMap((entry) => {
    if (options.roles?.length && !options.roles.includes(entry.kind as "user" | "assistant")) return [];
    if (options.view !== "conversation") return [entry];
    if (!entry.conversationText) return [];
    return [{ ...entry, text: entry.conversationText, preview: makePreview(entry.conversationText), toolNames: [] }];
  });
}

export function conversationEntries(session: LoadedSession): ConversationEntry[] {
  return visibleEntries(session, { view: "conversation" }).map((entry) => ({
    index: entry.index, id: entry.id, parentId: entry.parentId, timestampMs: entry.timestampMs,
    role: entry.kind as "user" | "assistant", text: entry.text,
  }));
}

/** Neighbors count visible messages, not hidden tool/thinking entries. */
export function entriesAround(session: LoadedSession, around: number, context = 2, options: ViewOptions = {}): number[] {
  if (!Number.isInteger(around) || around < 1 || around > session.entries.length) throw new Error("around is outside this session.");
  const entries = visibleEntries(session, options);
  const before = context ? entries.filter((e) => e.index < around).slice(-context) : [];
  const after = entries.filter((e) => e.index > around).slice(0, context);
  return [...before, ...entries.filter((e) => e.index === around), ...after].map((e) => e.index);
}

/**
 * Parse an entries spec like "12", "40-45,52", "100-" (open end) into sorted,
 * de-duplicated 1-based indices clamped to maxIndex.
 */
export function parseEntryRanges(spec: string, maxIndex: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)(-(\d+)?)?$/);
    if (!m) {
      throw new Error(`Invalid entry range "${trimmed}" — use forms like "12", "40-45", "100-" (comma-separated).`);
    }
    const start = parseInt(m[1]!, 10);
    const end = m[2] ? (m[3] ? parseInt(m[3], 10) : maxIndex) : start;
    if (start < 1 || end < start) throw new Error(`Invalid entry range "${trimmed}".`);
    for (let i = start; i <= Math.min(end, maxIndex); i++) out.add(i);
  }
  if (out.size === 0) {
    throw new Error(`No valid entries in "${spec}" (session has ${maxIndex} entries).`);
  }
  return [...out].sort((a, b) => a - b);
}
