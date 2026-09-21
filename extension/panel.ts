/** Synchronous live session picker. Agent-facing tools live in tools.ts. */
import { existsSync } from "node:fs";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Text, matchesKey, truncateToWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { formatDate, prettyPath } from "./format.ts";
import { HL_END, HL_START, type SearchHit } from "./search.ts";

const MAX_VISIBLE = 5;
export type PickAction = { type: "open" | "copy"; hit: SearchHit } | null;
interface MiniTheme { fg(color: string, text: string): string; bold(text: string): string }
function renderSnippet(text: string, theme: MiniTheme): string {
  return text.replace(/\s+/g, " ").trim().split(new RegExp(`(${HL_START}[^]*?${HL_END})`, "g"))
    .map((part) => part.startsWith(HL_START) ? theme.bold(theme.fg("accent", part.slice(1, -1))) : theme.fg("dim", part)).join("");
}

export class ResultsList {
  private hits: SearchHit[] = [];
  private selected = 0;
  private scroll = 0;
  private readonly theme: MiniTheme;
  private readonly currentSessionPath: string | undefined;
  constructor(theme: MiniTheme, currentSessionPath?: string) { this.theme = theme; this.currentSessionPath = currentSessionPath; }
  setHits(hits: SearchHit[]): void { this.hits = hits; this.selected = 0; this.scroll = 0; }
  getSelected(): SearchHit | undefined { return this.hits[this.selected]; }
  moveUp(): void { if (this.selected > 0) this.selected--; }
  moveDown(): void { if (this.selected < this.hits.length - 1) this.selected++; }
  render(width: number): string[] {
    const theme = this.theme;
    if (!this.hits.length) return [truncateToWidth(theme.fg("dim", "  no matches"), width)];
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + MAX_VISIBLE) this.scroll = this.selected - MAX_VISIBLE + 1;
    const lines: string[] = [];
    const end = Math.min(this.scroll + MAX_VISIBLE, this.hits.length);
    if (this.scroll) lines.push(truncateToWidth(theme.fg("dim", `   ↑ ${this.scroll} more`), width));
    for (let i = this.scroll; i < end; i++) {
      const hit = this.hits[i]!;
      const selected = i === this.selected;
      const prefix = selected ? theme.fg("accent", "❯ ") : "  ";
      const raw = (hit.name ?? hit.firstMessage ?? "(empty session)").replace(/\s+/g, " ").trim();
      const current = hit.path === this.currentSessionPath ? " (current)" : "";
      const meta = `  ${formatDate(hit.activityAt ?? hit.createdAt ?? hit.modifiedAt)} · ${hit.messageCount} msgs${hit.hits ? ` · ${hit.hits} hits` : ""}`;
      const title = truncateToWidth(raw, Math.max(20, width - 2 - current.length - meta.length));
      lines.push(truncateToWidth(prefix + theme.bold(selected ? theme.fg("accent", title) : title) + theme.fg("warning", current) + theme.fg("dim", meta), width));
      lines.push(truncateToWidth("    " + theme.fg(selected ? "text" : "muted", prettyPath(hit.cwd)) + (existsSync(hit.cwd) ? "" : theme.fg("error", "  (directory missing)")), width));
      for (const snippet of hit.snippets.slice(0, selected ? 2 : 1)) lines.push(truncateToWidth("    " + renderSnippet(snippet.text, theme), width));
      lines.push("");
    }
    if (end < this.hits.length) lines.push(truncateToWidth(theme.fg("dim", `   ↓ ${this.hits.length - end} more`), width));
    return lines;
  }
  invalidate(): void {}
}

export interface SearchPanelOptions {
  theme: MiniTheme; tui?: Pick<TUI, "requestRender">; initialQuery?: string; currentSessionPath?: string;
  runSearch: (query: string) => SearchHit[]; done: (result: PickAction) => void;
}
export class SearchPanel extends Container implements Focusable {
  private readonly input: Input;
  private readonly list: ResultsList;
  private readonly countText: Text;
  private readonly options: SearchPanelOptions;
  private lastQuery: string;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  constructor(options: SearchPanelOptions) {
    super();
    this.options = options;
    const theme = options.theme;
    this.input = new Input();
    this.input.setValue(options.initialQuery ?? "");
    this.input.onSubmit = () => { const hit = this.list.getSelected(); if (hit) options.done({ type: "open", hit }); };
    this.input.onEscape = () => options.done(null);
    this.list = new ResultsList(theme, options.currentSessionPath);
    this.countText = new Text("", 1, 0);
    this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
    this.addChild(this.countText); this.addChild(this.input); this.addChild(new Text("", 0, 0)); this.addChild(this.list);
    this.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter open here · tab copy resume command · esc cancel"), 1, 0));
    this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
    this.lastQuery = this.input.getValue(); this.refresh();
  }
  getQuery(): string { return this.input.getValue(); }
  private refresh(): void {
    const query = this.input.getValue();
    const hits = this.options.runSearch(query);
    this.list.setHits(hits);
    const label = query.trim() ? `${hits.length} results (top matches)` : "recent sessions · type to search";
    this.countText.setText(this.options.theme.fg("accent", this.options.theme.bold("Session search")) + this.options.theme.fg("muted", `  · ${label}`));
  }
  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) this.list.moveUp();
    else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) this.list.moveDown();
    else if (matchesKey(data, "tab")) { const hit = this.list.getSelected(); if (hit) this.options.done({ type: "copy", hit }); }
    else {
      this.input.handleInput(data);
      const query = this.input.getValue();
      if (query !== this.lastQuery) { this.lastQuery = query; this.refresh(); }
    }
    this.options.tui?.requestRender();
  }
  override invalidate(): void { super.invalidate(); this.refresh(); }
}
