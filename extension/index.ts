/**
 * pi-session-search: centralized full-text search over all pi sessions.
 *
 * `session_search` tool               - lets the LLM search past sessions
 * /session-search [query]            - live search panel over every session
 * /session-search --rebuild [query]  - drop and rebuild the index first
 *
 * The panel searches on every keystroke (last word matched as a prefix).
 * Enter opens the selected session in the current pi (pi rebinds cwd, tools,
 * and trust to the session's original directory). Tab copies a
 * `cd <dir> && pi --session <file>` command for a new terminal.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Text,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDate, formatHits, prettyPath, resumeCommand } from "./format.ts";
import { SessionIndex, defaultSessionsRoot } from "./indexer.ts";
import { HL_END, HL_START, recentSessions, search, type SearchHit } from "./search.ts";

const STATUS_KEY = "session-search";
const RESULT_LIMIT = 20;
const MAX_VISIBLE = 5;
const MIN_QUERY_LENGTH = 2;
const TOOL_DEFAULT_LIMIT = 10;
const TOOL_MAX_LIMIT = 50;

type PickAction = { type: "open" | "copy"; hit: SearchHit } | null;

interface MiniTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
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

/** Scrollable results list. Navigation is driven by the parent panel. */
export class ResultsList {
  private hits: SearchHit[] = [];
  private selected = 0;
  private scroll = 0;
  private readonly theme: MiniTheme;
  private readonly currentSessionPath: string | undefined;

  constructor(theme: MiniTheme, currentSessionPath: string | undefined) {
    this.theme = theme;
    this.currentSessionPath = currentSessionPath;
  }

  setHits(hits: SearchHit[]): void {
    this.hits = hits;
    this.selected = 0;
    this.scroll = 0;
  }

  getSelected(): SearchHit | undefined {
    return this.hits[this.selected];
  }

  moveUp(): void {
    if (this.selected > 0) this.selected--;
  }

  moveDown(): void {
    if (this.selected < this.hits.length - 1) this.selected++;
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (this.hits.length === 0) {
      return [truncateToWidth(theme.fg("dim", "  no matches"), width)];
    }
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
      const hitsPlain = hit.hits > 0 ? ` · ${hit.hits} hit${hit.hits === 1 ? "" : "s"}` : "";
      const metaPlain = `  ${formatDate(hit.createdAt ?? hit.modifiedAt)} · ${hit.messageCount} msgs${hitsPlain}`;
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

export interface SearchPanelOptions {
  theme: MiniTheme;
  tui?: Pick<TUI, "requestRender">;
  initialQuery?: string;
  currentSessionPath?: string;
  /** Returns hits for a query ("" = recent sessions). */
  runSearch: (query: string) => SearchHit[];
  done: (result: PickAction) => void;
}

/**
 * Live search panel: an input on top, results below, re-queried on every
 * keystroke. Implements Focusable so the terminal/IME cursor tracks the input.
 */
export class SearchPanel extends Container implements Focusable {
  private readonly input: Input;
  private readonly list: ResultsList;
  private readonly countText: Text;
  private readonly options: SearchPanelOptions;
  private lastQuery: string;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(options: SearchPanelOptions) {
    super();
    this.options = options;
    const theme = options.theme;

    this.input = new Input();
    this.input.setValue(options.initialQuery ?? "");
    this.input.onSubmit = () => {
      const hit = this.list.getSelected();
      if (hit) options.done({ type: "open", hit });
    };
    this.input.onEscape = () => options.done(null);

    this.list = new ResultsList(theme, options.currentSessionPath);
    this.countText = new Text("", 1, 0);

    this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
    this.addChild(this.countText);
    this.addChild(this.input);
    this.addChild(new Text("", 0, 0));
    this.addChild(this.list);
    this.addChild(
      new Text(theme.fg("dim", "↑↓ navigate · enter open here · tab copy resume command · esc cancel"), 1, 0),
    );
    this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

    this.lastQuery = this.input.getValue();
    this.refresh();
  }

  getQuery(): string {
    return this.input.getValue();
  }

  private refresh(): void {
    const theme = this.options.theme;
    const query = this.input.getValue();
    const hits = this.options.runSearch(query);
    this.list.setHits(hits);
    const label = query.trim()
      ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
      : "recent sessions · type to search";
    this.countText.setText(
      theme.fg("accent", theme.bold("Session search")) + theme.fg("muted", `  ·  ${label}`),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.list.moveUp();
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.list.moveDown();
    } else if (matchesKey(data, "tab")) {
      const hit = this.list.getSelected();
      if (hit) this.options.done({ type: "copy", hit });
    } else {
      this.input.handleInput(data);
      const query = this.input.getValue();
      if (query !== this.lastQuery) {
        this.lastQuery = query;
        this.refresh();
      }
    }
    this.options.tui?.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
    this.refresh(); // rebuild pre-baked theme strings (theme may have changed)
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

  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Full-text search over all of the user's past pi sessions across every project. " +
      "Matches user messages, assistant replies, compaction summaries, session names, and " +
      "project paths (tool output and thinking are not indexed). Terms are AND'd and " +
      'porter-stemmed; "quoted phrases" match exactly. An empty query lists the most recent ' +
      "sessions. Each result includes the project directory, matching snippets, and a " +
      "`cd <dir> && pi --session <file>` resume command.",
    promptSnippet:
      "Search the user's past pi sessions across all projects (full-text over messages and summaries)",
    promptGuidelines: [
      "Use session_search when the user refers to a past pi conversation, a decision made in another session, or asks what they worked on before.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Search terms (AND\'d, stemmed) and "quoted phrases" (exact). Empty for the most recent sessions.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: TOOL_MAX_LIMIT,
          description: `Max sessions to return (default ${TOOL_DEFAULT_LIMIT}).`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const idx = getIndex();
      await idx.sync(defaultSessionsRoot());

      const query = (params.query ?? "").trim();
      const limit = params.limit ?? TOOL_DEFAULT_LIMIT;
      const hits = query ? search(idx, query, limit) : recentSessions(idx, limit);
      const currentSessionPath = ctx.sessionManager.getSessionFile();

      return {
        content: [{ type: "text", text: formatHits(hits, { query, currentSessionPath }) }],
        details: {
          query,
          hits: hits.map((hit) => ({
            path: hit.path,
            cwd: hit.cwd,
            name: hit.name,
            date: formatDate(hit.createdAt ?? hit.modifiedAt),
            messageCount: hit.messageCount,
            hits: hit.hits,
          })),
        },
      };
    },
  });

  pi.registerCommand("session-search", {
    description: "Search all pi sessions across every project (--rebuild to reindex)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/session-search needs interactive mode; use the session_search tool instead", "error");
        return;
      }

      let query = (args ?? "").trim();
      let rebuild = false;
      if (query.startsWith("--rebuild")) {
        rebuild = true;
        query = query.slice("--rebuild".length).trim();
      }

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

      const currentSession = ctx.sessionManager.getSessionFile();
      const runSearch = (input: string): SearchHit[] => {
        try {
          const trimmed = input.trim();
          if (trimmed.length < MIN_QUERY_LENGTH) return recentSessions(idx, RESULT_LIMIT);
          return search(idx, trimmed, RESULT_LIMIT, { prefix: true });
        } catch {
          return []; // transient FTS syntax edge while typing
        }
      };

      const action = await ctx.ui.custom<PickAction>(
        (tui, theme, _keybindings, done) =>
          new SearchPanel({
            theme,
            tui,
            initialQuery: query,
            currentSessionPath: currentSession,
            runSearch,
            done,
          }),
      );

      if (!action) return;

      if (action.type === "copy") {
        const command = resumeCommand(action.hit);
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
