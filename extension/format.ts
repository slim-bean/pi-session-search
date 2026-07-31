/**
 * Shared formatting helpers + compact text rendering of search results for
 * the LLM (session_search tool).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { HL_END, HL_START, type SearchHit } from "./search.ts";

const MAX_TITLE = 120;

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

/** Resume command for a hit, for a fresh terminal. */
export function resumeCommand(hit: Pick<SearchHit, "cwd" | "path">): string {
  return `cd ${shellQuote(hit.cwd)} && pi --session ${shellQuote(hit.path)}`;
}

function plainSnippet(text: string): string {
  return text.replaceAll(HL_START, "«").replaceAll(HL_END, "»");
}

function trimTitle(hit: SearchHit): string {
  const raw = (hit.name ?? hit.firstMessage ?? "(empty session)").replace(/\s+/g, " ").trim();
  return raw.length > MAX_TITLE ? `${raw.slice(0, MAX_TITLE - 1)}…` : raw;
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
      lines.push(`    [${snippet.role}] ${plainSnippet(snippet.text)}`);
    }
  });

  return lines.join("\n").trimEnd();
}
