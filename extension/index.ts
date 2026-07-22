/**
 * pi-session-search: centralized full-text search over all pi sessions.
 *
 * /search <query>            - search every session across all projects
 * /search --rebuild <query>  - drop and rebuild the index first
 *
 * Enter opens the selected session in the current pi (pi rebinds cwd, tools,
 * and trust to the session's original directory). `c` copies a
 * `cd <dir> && pi --session <file>` command for a new terminal.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { SessionIndex, defaultSessionsRoot } from "./indexer.ts";
import { HL_END, HL_START, search, type SearchHit } from "./search.ts";

const STATUS_KEY = "session-search";
const RESULT_LIMIT = 20;
const MAX_VISIBLE = 5;

type PickAction = { type: "open" | "copy"; hit: SearchHit } | null;

interface MiniTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function prettyPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatDate(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderSnippet(snippet: string, theme: MiniTheme): string {
  const clean = snippet.replace(/\s+/g, " ").trim();
  const parts = clean.split(new RegExp(`(${HL_START}[^]*?${HL_END})`, "g"));
  return parts
    .map((part) =>
      part.startsWith(HL_START)
        ? theme.bold(theme.fg("accent", part.slice(1, -1)))
        : theme.fg("dim", part),
    )
    .join("");
}

function copyToClipboard(text: string): boolean {
  const commands: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [cmd, args] of commands) {
    const result = spawnSync(cmd, args, { input: text });
    if (result.status === 0) return true;
  }
  return false;
}

export class ResultsPicker {
  private selected = 0;
  private scroll = 0;

  private readonly hits: SearchHit[];
  private readonly theme: MiniTheme;
  private readonly done: (result: PickAction) => void;
  private readonly currentSessionPath: string | undefined;

  constructor(
    hits: SearchHit[],
    theme: MiniTheme,
    done: (result: PickAction) => void,
    currentSessionPath: string | undefined,
  ) {
    this.hits = hits;
    this.theme = theme;
    this.done = done;
    this.currentSessionPath = currentSessionPath;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p") || data === "k") {
      if (this.selected > 0) this.selected--;
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n") || data === "j") {
      if (this.selected < this.hits.length - 1) this.selected++;
    } else if (matchesKey(data, "enter")) {
      this.done({ type: "open", hit: this.hits[this.selected]! });
    } else if (data === "c") {
      this.done({ type: "copy", hit: this.hits[this.selected]! });
    } else if (matchesKey(data, "escape")) {
      this.done(null);
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + MAX_VISIBLE) this.scroll = this.selected - MAX_VISIBLE + 1;

    const lines: string[] = [];
    const end = Math.min(this.scroll + MAX_VISIBLE, this.hits.length);

    if (this.scroll > 0) {
      lines.push(truncateToWidth(theme.fg("dim", `   ↑ ${this.scroll} more`), width));
    }

    for (let i = this.scroll; i < end; i++) {
      const hit = this.hits[i]!;
      const isSelected = i === this.selected;
      const prefix = isSelected ? theme.fg("accent", "❯ ") : "  ";
      const rawTitle = (hit.name ?? hit.firstMessage ?? "(empty session)").replace(/\s+/g, " ").trim();
      const isCurrent = hit.path === this.currentSessionPath;
      const currentPlain = isCurrent ? " (current)" : "";
      const metaPlain = `  ${formatDate(hit.createdAt ?? hit.modifiedAt)} · ${hit.messageCount} msgs · ${hit.hits} hit${hit.hits === 1 ? "" : "s"}`;
      const avail = Math.max(20, width - 2 - currentPlain.length - metaPlain.length);
      const title = rawTitle.length > avail ? rawTitle.slice(0, avail - 1) + "…" : rawTitle;
      const current = isCurrent ? theme.fg("warning", currentPlain) : "";
      const meta = theme.fg("dim", metaPlain);
      lines.push(truncateToWidth(prefix + theme.bold(isSelected ? theme.fg("accent", title) : title) + current + meta, width));

      const missing = existsSync(hit.cwd) ? "" : theme.fg("error", "  (directory missing)");
      lines.push(truncateToWidth("    " + theme.fg(isSelected ? "text" : "muted", prettyPath(hit.cwd)) + missing, width));

      const snippetCount = isSelected ? 2 : 1;
      for (const snippet of hit.snippets.slice(0, snippetCount)) {
        lines.push(truncateToWidth("    " + renderSnippet(snippet.text, theme), width));
      }
      lines.push("");
    }

    if (end < this.hits.length) {
      lines.push(truncateToWidth(theme.fg("dim", `   ↓ ${this.hits.length - end} more`), width));
    }
    return lines;
  }

  invalidate(): void {
    // stateless render: nothing cached
  }
}

export default function (pi: ExtensionAPI) {
  let index: SessionIndex | undefined;

  const getIndex = (): SessionIndex => {
    index ??= new SessionIndex();
    return index;
  };

  pi.on("session_shutdown", async () => {
    index?.close();
    index = undefined;
  });

  pi.registerCommand("search", {
    description: "Search all pi sessions across every project (--rebuild to reindex)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/search requires interactive mode", "error");
        return;
      }

      let query = (args ?? "").trim();
      let rebuild = false;
      if (query.startsWith("--rebuild")) {
        rebuild = true;
        query = query.slice("--rebuild".length).trim();
      }
      if (!query) {
        query = ((await ctx.ui.input("Search sessions:")) ?? "").trim();
      }
      if (!query) return;

      const idx = getIndex();
      if (rebuild) idx.reset();

      ctx.ui.setStatus(STATUS_KEY, "indexing sessions…");
      try {
        await idx.sync(defaultSessionsRoot(), (progress) => {
          ctx.ui.setStatus(STATUS_KEY, `indexing sessions… ${progress.scanned}/${progress.total}`);
        });
      } catch (error: any) {
        ctx.ui.notify(`Index sync failed: ${error?.message ?? error}`, "error");
        return;
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }

      let hits: SearchHit[];
      try {
        hits = search(idx, query, RESULT_LIMIT);
      } catch (error: any) {
        ctx.ui.notify(`Search failed: ${error?.message ?? error}`, "error");
        return;
      }
      if (hits.length === 0) {
        ctx.ui.notify(`No sessions matching "${query}"`, "info");
        return;
      }

      const currentSession = ctx.sessionManager.getSessionFile();
      const action = await ctx.ui.custom<PickAction>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold("Session search")) +
              theme.fg("muted", `  ${query}  ·  ${hits.length} result${hits.length === 1 ? "" : "s"}`),
            1,
            0,
          ),
        );
        const picker = new ResultsPicker(hits, theme, done, currentSession);
        container.addChild(picker);
        container.addChild(
          new Text(theme.fg("dim", "↑↓ navigate · enter open here · c copy resume command · esc cancel"), 1, 0),
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            picker.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!action) return;

      if (action.type === "copy") {
        const command = `cd ${shellQuote(action.hit.cwd)} && pi --session ${shellQuote(action.hit.path)}`;
        if (copyToClipboard(command)) {
          ctx.ui.notify(`Copied: ${command}`, "info");
        } else {
          ctx.ui.notify(`Clipboard unavailable. Run: ${command}`, "warning");
        }
        return;
      }

      // action.type === "open"
      if (action.hit.path === currentSession) {
        ctx.ui.notify("That is the current session", "info");
        return;
      }
      const targetCwd = prettyPath(action.hit.cwd);
      try {
        const result = await ctx.switchSession(action.hit.path, {
          withSession: async (newCtx) => {
            newCtx.ui.notify(`Resumed session in ${targetCwd}`, "info");
          },
        });
        if (result.cancelled) {
          ctx.ui.notify("Session switch was cancelled", "warning");
        }
      } catch (error: any) {
        ctx.ui.notify(`Could not open session: ${error?.message ?? error}`, "error");
      }
    },
  });
}
