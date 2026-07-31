/**
 * Shared formatting helpers + compact text rendering for the LLM tools
 * (session_search results, session_read overview/read/find output).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { LoadedSession, ReadEntry } from "./reader.ts";
import { HL_END, HL_START, extractTokens, makeSnippet, type SearchHit } from "./search.ts";

const MAX_TITLE = 120;

export const OUTLINE_LIMIT = 100;
export const FIND_LIMIT = 20;
export const READ_BUDGET = 30_000;

export function prettyPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatDate(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human size for a char count: 742ch, 3.4KB, 120KB. */
export function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}ch`;
  const kb = chars / 1024;
  return kb >= 100 ? `${Math.round(kb)}KB` : `${kb.toFixed(1)}KB`;
}

/** Resume command for a hit, for a fresh terminal. */
export function resumeCommand(hit: Pick<SearchHit, "cwd" | "path">): string {
  return `cd ${shellQuote(hit.cwd)} && pi --session ${shellQuote(hit.path)}`;
}

function plainSnippet(text: string): string {
  return text.replaceAll(HL_START, "«").replaceAll(HL_END, "»");
}

function clampTitle(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

function trimTitle(hit: SearchHit): string {
  return clampTitle(hit.name ?? hit.firstMessage ?? "(empty session)");
}

function sessionTitle(session: LoadedSession): string {
  const firstUser = session.entries.find((e) => e.kind === "user")?.preview;
  return clampTitle(session.name ?? firstUser ?? "(empty session)");
}

export interface FormatOptions {
  query: string;
  currentSessionPath?: string;
}

/** Render hits as compact text for the LLM (a few lines per session). */
export function formatHits(hits: SearchHit[], options: FormatOptions): string {
  const query = options.query.trim();
  if (hits.length === 0) {
    return query
      ? `No sessions match "${query}". Terms are AND'd and stemmed; use "quoted phrases" for exact matches, or retry with fewer or different terms.`
      : "No pi sessions found.";
  }

  const lines: string[] = [
    query
      ? `${hits.length} session${hits.length === 1 ? "" : "s"} matching "${query}" (best match first):`
      : `${hits.length} most recent session${hits.length === 1 ? "" : "s"}:`,
    "",
  ];

  hits.forEach((hit, index) => {
    const rank = String(index + 1).padStart(2, " ");
    const meta = [formatDate(hit.createdAt ?? hit.modifiedAt), `${hit.messageCount} msgs`];
    if (hit.hits > 0) meta.push(`${hit.hits} matching chunk${hit.hits === 1 ? "" : "s"}`);
    const current = hit.path === options.currentSessionPath ? " (current session)" : "";
    const missing = existsSync(hit.cwd) ? "" : " (directory missing)";
    lines.push(`${rank}. ${trimTitle(hit)} — ${meta.join(" · ")}${current}`);
    lines.push(`    ${prettyPath(hit.cwd)}${missing} — resume: ${resumeCommand(hit)}`);
    for (const snippet of hit.snippets) {
      const at = snippet.entryIndex ? ` #${snippet.entryIndex}` : "";
      lines.push(`    [${snippet.role}${at}] ${plainSnippet(snippet.text)}`);
    }
  });

  lines.push("");
  lines.push(
    'Inspect a result with session_read(path): outline by default, entries:"40-45" to read around a snippet\'s #index, query:"…" to search inside it (covers tool output too).',
  );

  return lines.join("\n").trimEnd();
}

// --- session_read output ------------------------------------------------------

function summarizeTools(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

function outlineLine(entry: ReadEntry, indexWidth: number, kindWidth: number): string {
  const tools = entry.toolNames.length > 0 ? `[${summarizeTools(entry.toolNames)}] ` : "";
  return ` #${String(entry.index).padStart(indexWidth)} ${entry.kind.padEnd(kindWidth)} ${formatSize(
    entry.text.length,
  ).padStart(6)}  ${tools}${entry.preview}`.trimEnd();
}

function sessionHeaderLines(session: LoadedSession): string[] {
  const missing = existsSync(session.cwd) ? "" : " (directory missing)";
  return [
    `Session: ${sessionTitle(session)}`,
    `File: ${prettyPath(session.path)} (${formatSize(session.fileSize)}, ${session.entries.length} entries, ${session.messageCount} messages)`,
    `Project: ${prettyPath(session.cwd)}${missing}`,
    `Created: ${formatDate(session.createdAt)}`,
  ];
}

export interface PageOptions {
  offset?: number;
  limit?: number;
}

/** Overview mode: metadata + paginated one-line-per-entry outline. */
export function formatOverview(session: LoadedSession, options: PageOptions = {}): string {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? OUTLINE_LIMIT);
  const total = session.entries.length;
  const page = session.entries.slice(offset, offset + limit);

  const lines = sessionHeaderLines(session);
  lines.push("");
  if (total === 0) {
    lines.push("No entries.");
    return lines.join("\n");
  }
  if (page.length === 0) {
    lines.push(`Offset ${offset} is past the end (${total} entries).`);
    return lines.join("\n");
  }

  lines.push(`Entries #${page[0]!.index}-#${page[page.length - 1]!.index} of ${total}:`);
  const indexWidth = String(page[page.length - 1]!.index).length;
  const kindWidth = Math.min(18, Math.max(...page.map((e) => e.kind.length)));
  for (const entry of page) lines.push(outlineLine(entry, indexWidth, kindWidth));

  const hints: string[] = [];
  if (offset + page.length < total) hints.push(`more entries: pass offset:${offset + page.length}`);
  hints.push('read full entries with entries:"40-45"', 'search inside with query:"…"');
  lines.push("");
  lines.push(`(${hints.join(" · ")})`);
  return lines.join("\n");
}

export interface ReadOptions {
  maxChars?: number;
  offsetChars?: number;
}

/** Read mode: full text of selected entries under a char budget. */
export function formatEntriesRead(
  session: LoadedSession,
  indices: number[],
  options: ReadOptions = {},
): string {
  const budget = Math.max(1000, options.maxChars ?? READ_BUDGET);
  const offsetChars = Math.max(0, options.offsetChars ?? 0);
  if (offsetChars > 0 && indices.length !== 1) {
    throw new Error("offsetChars only applies when reading a single entry.");
  }

  const lines: string[] = [
    `${sessionTitle(session)} — ${prettyPath(session.path)} — entries ${indices[0]}…${indices[indices.length - 1]} of ${session.entries.length}`,
  ];
  let used = 0;
  let stoppedAt: number | null = null;

  for (const index of indices) {
    const entry = session.entries[index - 1];
    if (!entry) continue;
    if (used >= budget) {
      stoppedAt = index;
      break;
    }
    const when = formatDateTime(entry.timestampMs);
    lines.push("");
    lines.push(`--- #${entry.index} ${entry.kind}${when ? ` · ${when}` : ""} · ${formatSize(entry.text.length)} ---`);

    const body = offsetChars > 0 ? entry.text.slice(offsetChars) : entry.text;
    const room = budget - used;
    if (body.length > room) {
      lines.push(body.slice(0, room));
      const nextOffset = offsetChars + room;
      lines.push(
        `[truncated: showing chars ${offsetChars}-${nextOffset} of ${entry.text.length} — continue with entries:"${entry.index}", offsetChars:${nextOffset}]`,
      );
      used = budget;
    } else {
      lines.push(body || "(empty)");
      used += body.length;
    }
  }

  if (stoppedAt !== null) {
    lines.push("");
    lines.push(
      `[size budget reached — continue with entries:"${stoppedAt}-${indices[indices.length - 1]}"]`,
    );
  }
  return lines.join("\n").trimEnd();
}

/** Find mode: entries whose full text contains every term (incl. tool output). */
export function formatSessionMatches(
  session: LoadedSession,
  query: string,
  options: PageOptions = {},
): string {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? FIND_LIMIT);
  const tokens = extractTokens(query);
  const needles = tokens.map((t) => t.toLowerCase());

  const matches =
    needles.length === 0
      ? []
      : session.entries.filter((entry) => {
          const haystack = entry.text.toLowerCase();
          return needles.every((needle) => haystack.includes(needle));
        });

  if (matches.length === 0) {
    return `No entries match "${query}" in ${sessionTitle(session)} (${session.entries.length} entries scanned, including tool output and thinking).`;
  }

  const page = matches.slice(offset, offset + limit);
  const lines = [
    `${matches.length} of ${session.entries.length} entries match "${query}" in ${sessionTitle(session)}:`,
    "",
  ];
  for (const entry of page) {
    lines.push(` #${entry.index} ${entry.kind} · ${formatSize(entry.text.length)}`);
    lines.push(`    ${plainSnippet(makeSnippet(entry.text, tokens))}`);
  }

  const hints: string[] = [];
  if (offset + page.length < matches.length) {
    hints.push(`more matches: pass offset:${offset + page.length}`);
  }
  hints.push('read a match in full with entries:"<index>"');
  lines.push("");
  lines.push(`(${hints.join(" · ")})`);
  return lines.join("\n");
}
