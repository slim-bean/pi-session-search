/** LLM-facing tools, deliberately separate from the synchronous live picker. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultSessionsRoot, type SessionIndex } from "./indexer.ts";
import { entriesAround, loadSessionFile, parseEntryRanges, resolveSessionPath } from "./reader.ts";
import { fingerprint } from "./session-file.ts";
import { searchProjects, searchSessions, type SearchOptions } from "./search.ts";
import { readSummary } from "./summary-store.ts";
import { generateSummary, loadConversation, planSummary, SECTION_CHARS } from "./summarizer.ts";
import {
  formatEntriesRead, formatOverview, formatProjectPage, formatSearchPage, formatSessionMatches,
  formatSummary, formatSummaryPlan, formatSummaryProgress, formatSyncWarning, READ_BUDGET,
} from "./format.ts";

const maxChars = Type.Optional(Type.Integer({ minimum: 2000, maximum: 40_000, description: "Output character budget (default 16000 search, 20000 read). Pagination/continuation hints preserve access to omitted content." }));
const match = Type.Optional(StringEnum(["all", "any"] as const, { description: "Require all terms (default) or any term within one entry." }));
const offset = Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset; keep the same query/filters when paging." }));

function modelFor(ctx: ExtensionContext, name?: string) {
  if (!name) {
    if (!ctx.model) throw new Error("No active model. Select one or specify provider/model.");
    return ctx.model;
  }
  const slash = name.indexOf("/");
  if (slash < 1) throw new Error("model must be provider/model-id.");
  const model = ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
  if (!model) throw new Error(`Model not found: ${name}`);
  return model;
}

export function registerSessionTools(pi: ExtensionAPI, getIndex: () => SessionIndex, shutdown: AbortSignal): void {
  const generating = new Set<string>();
  pi.registerTool({
    name: "session_search", label: "Session Search",
    description: "Search or browse past pi sessions using a local keyword index; no model calls. " +
      "query terms are AND'd within one entry by default; match:any ORs them. Quoted phrases require adjacent tokens but still use Porter stemming (not byte-exact). " +
      "anyOf supplies OR'd alternative queries, combined with query using AND. Filter scope independently of terms. " +
      "Empty query browses sessions; group:projects discovers project directories/counts. Current session is excluded by default. " +
      "Returns counted, paginated evidence excerpts with original entry #indices, source dates, and summary availability. " +
      "Tool output/thinking aren't indexed. No keyword matches does not prove the discussion never happened.",
    promptSnippet: "Search/browse past conversations with project/date filters, alternative keywords, and paginated evidence",
    promptGuidelines: [
      "Use session_search for past discussions. Scope by project/date when known, try anyOf alternatives, or browse group:projects with an empty query when terminology is unknown. Broaden beyond the current project if needed.",
      "Verify session_search excerpts and generated summaries with session_read before treating a proposal or assistant claim as an established decision. No matches is not proof of absence.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 2000, description: "Terms/quoted phrases. Empty = browse. Operators in text are literal; use match/anyOf instead of writing OR." })),
      anyOf: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12, description: 'Alternative queries, e.g. ["embeddings", "reranking", "\"semantic search\""]; each is AND terms, alternatives OR together. query, if present, must also match the same entry.' })),
      match,
      project: Type.Optional(Type.String({ description: 'Exact session working directory (not a topic filter). "current" uses current cwd; ~/ and relative paths accepted. Omit for all projects.' })),
      projectScope: Type.Optional(StringEnum(["exact", "tree"] as const, { description: "exact (default) or project and its child directories; no wildcard matching." })),
      since: Type.Optional(Type.String({ description: "Inclusive lower date bound: YYYY-MM-DD (UTC), ISO timestamp with timezone, today/yesterday, or 7d/2w/24h." })),
      until: Type.Optional(Type.String({ description: "Inclusive upper bound; date-only values include that entire UTC day. Same syntax as since." })),
      dateField: Type.Optional(StringEnum(["activity", "created", "message"] as const, { description: "activity (default): last user/assistant text timestamp; created: session header timestamp; message: timestamp of matching entry (metadata/generated summaries excluded). Not filesystem mtime." })),
      roles: Type.Optional(Type.Array(StringEnum(["user", "assistant", "summary", "custom", "meta", "generated"] as const), { minItems: 1, description: "Limit searchable entries. summary = pi compaction/branch summary; generated = cached topic summary; meta = name/path. Omit for all." })),
      excludeCurrent: Type.Optional(Type.Boolean({ description: "Exclude the active session (default true). Set false to search it too." })),
      group: Type.Optional(StringEnum(["sessions", "projects"] as const, { description: "sessions (default): evidence excerpts; projects: directory counts for corpus discovery." })),
      sort: Type.Optional(StringEnum(["relevance", "recent", "oldest"] as const, { description: "Default relevance for searches, recent activity for empty queries. Projects always sort by session count." })),
      offset,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max sessions/projects (default 10); total count and next offset are returned." })),
      snippets: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Excerpts per session (default 3); 0 for compact listings." })),
      includeResume: Type.Optional(Type.Boolean({ description: "Include shell resume commands (default false). Paths are always returned." })),
      maxChars,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const combined = AbortSignal.any([shutdown, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const index = getIndex();
      const sync = await index.sync(defaultSessionsRoot());
      const warning = formatSyncWarning(sync.skipped);
      const outputBudget = (params.maxChars ?? 16_000) - warning.length;
      combined.throwIfAborted();
      if (params.projectScope && !params.project) throw new Error("projectScope requires project.");
      const options: SearchOptions = {
        ...params,
        project: params.project === "current" ? ctx.cwd : params.project ? resolveSessionPath(params.project, ctx.cwd) : undefined,
        excludePath: params.excludeCurrent === false ? undefined : ctx.sessionManager.getSessionFile(),
      };
      if (params.group === "projects") {
        const page = searchProjects(index, options);
        const formatted = formatProjectPage(page, outputBudget);
        return { content: [{ type: "text", text: warning + formatted.text }], details: {
          total: page.total, nextOffset: formatted.nextOffset, projects: page.projects.slice(0, formatted.shown),
        } };
      }
      const page = searchSessions(index, options);
      const formatted = formatSearchPage(page, { ...params, maxChars: outputBudget, currentSessionPath: ctx.sessionManager.getSessionFile() });
      return { content: [{ type: "text", text: warning + formatted.text }], details: {
        total: page.total, nextOffset: formatted.nextOffset, hits: page.hits.slice(0, formatted.shown),
      } };
    },
  });

  pi.registerTool({
    name: "session_read", label: "Session Read",
    description: "Read one session using its path from session_search. Default view:conversation returns only user/assistant TEXT (no thinking, tools/results, or images). " +
      "view:full includes all entries and content; view:summary reads cached generated topic summaries without model calls. " +
      "With no selection, returns a paginated outline. entries:'40-45,52' reads original #indices. around:42 returns that entry plus context visible messages on each side (default 2). " +
      "query searches the selected view using case-insensitive substrings, no stemming; match:all/any controls term combination. " +
      "Filtered views never renumber entries. All branches are included in file order. Output is budgeted with continuation hints.",
    promptSnippet: "Read conversation text, context around a hit, full forensic entries, or cached topic summaries",
    promptGuidelines: [
      'Use session_read(path, around:<entry>, context:2) to verify a search hit. Use view:"full" only when tools/thinking matter; view:"summary" is a navigation aid, not evidence.',
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Session JSONL path from session_search." }),
      view: Type.Optional(StringEnum(["conversation", "full", "summary"] as const, { description: "conversation (default): user/assistant text; full: all content; summary: cached topic outline, no generation." })),
      roles: Type.Optional(Type.Array(StringEnum(["user", "assistant"] as const), { minItems: 1, description: "Further restrict conversation/full views by message role." })),
      entries: Type.Optional(Type.String({ description: 'Original entry indices: "12", "40-45,52", "100-". Mutually exclusive with query/around.' })),
      around: Type.Optional(Type.Integer({ minimum: 1, description: "Original entry index to read with surrounding visible messages." })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Visible messages before/after around (default 2), not raw entry count." })),
      query: Type.Optional(Type.String({ description: 'Find literal substrings in the selected view. Quotes group phrases. Unlike global search, no stemming.' })),
      match,
      offset,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Outline entries (default 50), matches (20), or summary overview/topic items (20) per page." })),
      maxChars,
      offsetChars: Type.Optional(Type.Integer({ minimum: 0, description: "Continue inside a single entries selection, in UTF-16 characters of the same view. Use the offset returned by a truncated read." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      AbortSignal.any([shutdown, ...(signal ? [signal] : [])]).throwIfAborted();
      const path = resolveSessionPath(params.path, ctx.cwd);
      const view = params.view ?? "conversation";
      if ([Boolean(params.entries), Boolean(params.query?.trim()), params.around !== undefined].filter(Boolean).length > 1) throw new Error("Pass only one of entries, query, or around.");
      if (params.context !== undefined && params.around === undefined) throw new Error("context requires around.");
      if (params.offsetChars && !params.entries) throw new Error("offsetChars requires a single entries selection.");
      if (view === "summary") {
        if (params.entries || params.query || params.around !== undefined || params.roles || params.offsetChars) throw new Error("Summary view supports only path, offset, limit, maxChars.");
        const record = readSummary(getIndex().db, path, fingerprint(loadConversation(path)));
        return { content: [{ type: "text", text: formatSummary(record, path, { offset: params.offset, limit: params.limit, maxChars: params.maxChars }) }], details: { path, mode: "summary", status: record.status } };
      }
      const session = loadSessionFile(path);
      const options = { ...params, view, maxChars: params.maxChars ?? READ_BUDGET };
      let text: string;
      let mode: string;
      if (params.entries || params.around !== undefined) {
        const indices = params.entries ? parseEntryRanges(params.entries, session.entries.length)
          : entriesAround(session, params.around!, params.context ?? 2, options);
        text = formatEntriesRead(session, indices, options); mode = "read";
      } else if (params.query?.trim()) {
        text = formatSessionMatches(session, params.query.trim(), options); mode = "find";
      } else { text = formatOverview(session, options); mode = "overview"; }
      return { content: [{ type: "text", text }], details: { path, mode, view, entryCount: session.entries.length } };
    },
  });

  pi.registerTool({
    name: "session_summarize", label: "Session Summarize",
    description: "Plan or explicitly generate a cached, search-oriented topic outline of ONE indexed session. " +
      "action:plan (default) is local/no-cost; reports uncached work for a chosen model. action:generate sends user/assistant text to that model's provider and incurs usage. " +
      "Only use generate when the user requests summary indexing, never automatically during history searches. " +
      "No tools, thinking, images, or compaction text is sent. All conversation text is processed in bounded sections, never sampled. " +
      "Successful sections are cached by source/model/version; repeated calls resume. Only complete, fresh summaries enter search. " +
      "Read published summaries via session_read(view:summary). Source sessions are never modified.",
    promptSnippet: "Plan or explicitly generate resumable, cached topic summaries (generation makes paid model calls)",
    promptGuidelines: ["Use session_summarize action:plan before generating. Use action:generate only when the user explicitly requests creating/updating summary indexes; ordinary session_search/session_read never require it."],
    parameters: Type.Object({
      path: Type.String({ description: "One session JSONL path from session_search." }),
      action: Type.Optional(StringEnum(["plan", "generate"] as const, { description: "plan (default): no model calls. generate: paid, explicit, resumable indexing." })),
      model: Type.Optional(Type.String({ description: "provider/model-id (default active model). Uses pi's model registry/auth; never changes the active model." })),
      maxSections: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum new section calls for this invocation (default 4). Cached sections are free; call again to continue." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = AbortSignal.any([shutdown, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const index = getIndex();
      await index.sync(defaultSessionsRoot());
      combined.throwIfAborted();
      const path = resolveSessionPath(params.path, ctx.cwd);
      const model = modelFor(ctx, params.model);
      const modelName = `${model.provider}/${model.id}`;
      // Conservative character-based ceiling even for non-English/code-heavy text.
      const sectionChars = Math.min(SECTION_CHARS, model.contextWindow - 8000);
      if (sectionChars < 1000) throw new Error("Summary generation requires a model with at least a 9000-token context window.");
      const plan = planSummary(index, path, modelName, sectionChars);
      const maxSections = params.maxSections ?? 4;
      if (params.action !== "generate") return {
        content: [{ type: "text", text: formatSummaryPlan(plan, maxSections) }],
        details: { path, model: modelName, sections: plan.sections.length, cached: plan.cached, remaining: plan.remaining, inputChars: plan.inputChars },
      };
      if (generating.has(path)) throw new Error("Summary generation for this session is already running. Retry after it finishes.");
      if (plan.remaining && !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No authentication configured for ${modelName}.`);
      generating.add(path);
      try {
        onUpdate?.({ content: [{ type: "text", text: formatSummaryPlan(plan, maxSections) }], details: { path, model: modelName } });
        const progress = await generateSummary(index, plan, async (systemPrompt, input, callSignal) => {
          const response = await ctx.modelRegistry.complete(model, {
            systemPrompt, messages: [{ role: "user", content: input, timestamp: Date.now() }],
          }, {
            signal: AbortSignal.any([combined, ...(callSignal ? [callSignal] : []), AbortSignal.timeout(120_000)]),
            maxTokens: Math.min(4096, model.maxTokens), reasoningEffort: "low", sessionId: randomUUID(),
          });
          if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
            return { text: "", usage: response.usage, error: response.errorMessage ?? `Summary model stopped: ${response.stopReason}` };
          }
          return { text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), usage: response.usage };
        }, { signal: combined, maxSections, onProgress: (progress) => onUpdate?.({
          content: [{ type: "text", text: formatSummaryProgress(progress) }], details: { path, ...progress },
        }) });
        return { content: [{ type: "text", text: formatSummaryProgress(progress) }], details: { path, ...progress }, usage: progress.usage };
      } finally { generating.delete(path); }
    },
  });
}
