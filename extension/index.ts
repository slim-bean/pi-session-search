/** Extension entrypoint: shared index, agent tools, and the live /session-search picker. */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionIndex, defaultSessionsRoot } from "./indexer.ts";
import { SearchPanel, type PickAction } from "./panel.ts";
import { formatSyncWarning, prettyPath, resumeCommand } from "./format.ts";
import { recentSessions, search, type SearchHit } from "./search.ts";
import { registerSessionTools } from "./tools.ts";
import { registerSummaryMaintenance } from "./maintenance.ts";
export { SearchPanel, ResultsList } from "./panel.ts";

function copyToClipboard(text: string): boolean {
  const commands: [string, string[]][] = process.platform === "darwin" ? [["pbcopy", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  return commands.some(([command, args]) => spawnSync(command, args, { input: text }).status === 0);
}

export default function (pi: ExtensionAPI) {
  let index: SessionIndex | undefined;
  const shutdown = new AbortController();
  const getIndex = () => index ??= new SessionIndex();
  registerSessionTools(pi, getIndex, shutdown.signal);
  const maintenance = registerSummaryMaintenance(pi, getIndex);
  pi.events.on("pi-session-maintenance:capabilities:v1", (data) => {
    const request = data as { capabilities?: Record<string, unknown> };
    (request.capabilities ??= {}).summary = { protocol: 1, channel: "pi-session-search:maintenance:v1" };
  });
  pi.on("session_shutdown", async () => {
    shutdown.abort();
    await maintenance.stop();
    await index?.dispose();
    index = undefined;
  });
  pi.registerCommand("session-search", {
    description: "Search all pi sessions across every project (--rebuild to reindex; preserves generated summaries)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/session-search needs interactive mode; use session_search instead", "error"); return;
      }
      let query = (args ?? "").trim();
      const rebuild = /^--rebuild(?:\s|$)/.test(query);
      if (rebuild) query = query.slice("--rebuild".length).trim();
      const idx = getIndex();
      if (rebuild) idx.reset();
      ctx.ui.setStatus("session-search", "indexing sessions…");
      try {
        const sync = await idx.sync(defaultSessionsRoot(), (p) => ctx.ui.setStatus("session-search", `indexing ${p.scanned}/${p.total}`));
        if (sync.skipped) ctx.ui.notify(formatSyncWarning(sync.skipped).trim(), "warning");
      } catch (error: any) {
        ctx.ui.notify(`Index sync failed: ${error?.message ?? error}`, "error"); return;
      } finally { ctx.ui.setStatus("session-search", undefined); }
      const current = ctx.sessionManager.getSessionFile();
      const runSearch = (input: string): SearchHit[] => {
        const trimmed = input.trim();
        return trimmed.length < 2 ? recentSessions(idx, 20) : search(idx, trimmed, 20, { prefix: true });
      };
      const action = await ctx.ui.custom<PickAction>((tui, theme, _keys, done) => new SearchPanel({
        theme, tui, initialQuery: query, currentSessionPath: current, runSearch, done,
      }));
      if (!action) return;
      if (action.type === "copy") {
        const command = resumeCommand(action.hit);
        ctx.ui.notify(copyToClipboard(command) ? "Copied resume command" : `Clipboard unavailable. Run: ${command}`, "info"); return;
      }
      if (action.hit.path === current) { ctx.ui.notify("That is the current session", "info"); return; }
      const cwd = prettyPath(action.hit.cwd);
      try {
        const result = await ctx.switchSession(action.hit.path, {
          withSession: async (newCtx) => { newCtx.ui.notify(`Resumed session in ${cwd}`, "info"); },
        });
        if (result.cancelled) ctx.ui.notify("Session switch was cancelled", "warning");
      } catch (error: any) { ctx.ui.notify(`Could not open session: ${error?.message ?? error}`, "error"); }
    },
  });
}
