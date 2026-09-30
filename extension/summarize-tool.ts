/** session_summarize: plan, calibrate, and generate topic summaries for one or many sessions. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultSessionsRoot, type SessionIndex } from "./indexer.ts";
import { resolveSessionPath } from "./reader.ts";
import { searchSessions, type SearchOptions } from "./search.ts";
import { addUsage, emptyUsage, MAX_CONCURRENCY, planSummary, runSummaries, type RunResult, type SectionMemo, type SummaryPlan } from "./summarizer.ts";
import { resolveSummaryModel, summaryCompleter, SUMMARY_REASONING_LEVELS, type SummaryModel } from "./summary-model.ts";
import { callStats, estimateWork, sampleSections } from "./summary-estimate.ts";
import { cachedSection, readSummary } from "./summary-store.ts";
import { formatCalibration, formatRunResult, formatSummaryPlan, type CalibrationRow, type PlanModelView } from "./format.ts";
import { match, maxChars } from "./schemas.ts";

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_SAMPLES = 6;
const MAX_PATHS = 5000;

const scopeSchema = Type.Object({
  all: Type.Optional(Type.Boolean({ description: "Required to target every indexed session when no other scope filter is given." })),
  query: Type.Optional(Type.String({ maxLength: 2000, description: "Only sessions with an entry matching these terms (session_search semantics)." })),
  anyOf: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 })),
  match,
  project: Type.Optional(Type.String({ description: 'Exact session cwd; "current", absolute, ~/ or relative.' })),
  projectScope: Type.Optional(StringEnum(["exact", "tree"] as const)),
  since: Type.Optional(Type.String()),
  until: Type.Optional(Type.String()),
  dateField: Type.Optional(StringEnum(["activity", "created", "message"] as const)),
});

interface Targets { paths: string[]; description: string }

function resolveTargets(index: SessionIndex, params: any, ctx: ExtensionContext): Targets {
  const forms = [params.path !== undefined, params.paths !== undefined, params.scope !== undefined].filter(Boolean).length;
  if (forms !== 1) throw new Error("Pass exactly one of path, paths, or scope.");
  if (params.path !== undefined) {
    const path = resolveSessionPath(params.path, ctx.cwd);
    return { paths: [path], description: `1 session: ${path}` };
  }
  if (params.paths !== undefined) {
    const paths = [...new Set<string>(params.paths.map((p: string) => resolveSessionPath(p, ctx.cwd)))];
    return { paths, description: `${paths.length} listed sessions` };
  }
  const { all, ...filters } = params.scope;
  const hasFilter = Object.values(filters).some((v) => v !== undefined && !(Array.isArray(v) && !v.length));
  if (!hasFilter && all !== true) throw new Error("scope needs at least one filter, or all:true to target every indexed session.");
  if (filters.projectScope && !filters.project) throw new Error("projectScope requires project.");
  const current = ctx.sessionManager.getSessionFile();
  const options: SearchOptions = {
    ...filters,
    project: filters.project === "current" ? ctx.cwd : filters.project ? resolveSessionPath(filters.project, ctx.cwd) : undefined,
    excludePath: params.excludeCurrent === false ? undefined : current,
    snippets: 0, limit: MAX_PATHS + 1, sort: "oldest", count: false,
  };
  const paths = searchSessions(index, options).hits.map((hit) => hit.path);
  if (paths.length > MAX_PATHS) throw new Error(`Scope matches more than ${MAX_PATHS} sessions; narrow it.`);
  const parts = [filters.project ? `project=${options.project} (${filters.projectScope ?? "exact"})` : "all projects"];
  if (filters.query || filters.anyOf) parts.push(`matching ${JSON.stringify(filters.query ?? "")}${filters.anyOf ? ` AND anyOf ${JSON.stringify(filters.anyOf)}` : ""}`);
  if (filters.since || filters.until) parts.push(`${filters.dateField ?? "activity"} ${filters.since ?? "…"} to ${filters.until ?? "now"}`);
  if (options.excludePath) parts.push("current session excluded");
  return { paths, description: `${paths.length} sessions (${parts.join("; ")})` };
}

function buildPlans(index: SessionIndex, paths: string[], model: SummaryModel, memo: SectionMemo): SummaryPlan[] {
  return paths.map((path) => planSummary(index, path, model.key, model.sectionChars, memo));
}

function planView(index: SessionIndex, plans: SummaryPlan[], model: SummaryModel, concurrency: number): PlanModelView {
  const uncached = plans.map((plan) => plan.sections.filter((s) => !cachedSection(index.db, plan.path, s.hash, model.key)));
  const remaining = uncached.flat();
  const sections = plans.reduce((n, p) => n + p.sections.length, 0);
  return {
    key: model.key, sections, cached: sections - remaining.length, remaining: remaining.length,
    completeSessions: uncached.filter((u) => !u.length).length,
    publishedSessions: plans.filter((p) => { const r = readSummary(index.db, p.path, p.sourceHash); return r.status === "ready" && r.model === model.key; }).length,
    largestSession: Math.max(0, ...uncached.map((u) => u.length)),
    estimate: estimateWork(remaining, model.model, model.maxTokens, callStats(index.db, model.key), concurrency),
  };
}

export function registerSummarizeTool(pi: ExtensionAPI, getIndex: () => SessionIndex, shutdown: AbortSignal): void {
  const generating = new Set<string>();
  pi.registerTool({
    name: "session_summarize", label: "Session Summarize",
    description: "Plan, calibrate, or generate cached search-oriented topic summaries for one session (path), a list (paths), or a filtered scope " +
      "(scope uses session_search filters; all:true targets every session). action:plan (default) is local/no-cost and estimates cost: calibrated from logged calls when available, otherwise a rough range. " +
      "action:calibrate runs a small deterministic size-spread sample through one or more models (paid), logs tokens/cost/latency/failures, caches the sections, and returns projections plus a side-by-side comparison; nothing is published. " +
      "action:generate (paid) summarizes uncached sections in parallel and publishes complete sessions to search, bounded by maxSections (calls) and maxCost (USD). " +
      "Only user/assistant text is sent: no tools, thinking, images, or compaction text; never sampled. Runs are resumable: cached sections are free. " +
      "Read published summaries via session_read(view:summary). Source sessions are never modified.",
    promptSnippet: "Plan/calibrate/generate cached topic summaries for one or many sessions (calibrate/generate make paid model calls)",
    promptGuidelines: [
      "Use session_summarize action:plan before paid work. Use action:calibrate or action:generate only when the user explicitly requests summary calibration/indexing, never automatically during history searches.",
      "For batch session_summarize generation, set maxSections and maxCost from the plan and the user's budget; repeat the same call to resume.",
    ],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["plan", "calibrate", "generate"] as const, { description: "plan (default, free) | calibrate (paid sample) | generate (paid, publishes)." })),
      path: Type.Optional(Type.String({ description: "One session JSONL path." })),
      paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_PATHS, description: "Explicit session paths." })),
      scope: Type.Optional(scopeSchema),
      excludeCurrent: Type.Optional(Type.Boolean({ description: "Exclude the active session from scope (default true); it keeps changing." })),
      model: Type.Optional(Type.String({ description: "provider/model-id (default active model). Never changes the active model." })),
      models: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 6, description: "plan/calibrate: compare several provider/model-ids." })),
      reasoning: Type.Optional(StringEnum(SUMMARY_REASONING_LEVELS, { description: "Summarizer reasoning (default low), clamped to model support. Part of the cache key." })),
      maxSections: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PATHS, description: "generate: max new model calls this invocation (default 4)." })),
      maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Approximate USD ceiling on reported cost for this invocation (may overshoot by in-flight calls)." })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: `Parallel model calls (default ${DEFAULT_CONCURRENCY}).` })),
      samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: `calibrate: sections per model (default ${DEFAULT_SAMPLES}).` })),
      maxChars,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = AbortSignal.any([shutdown, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const index = getIndex();
      await index.sync(defaultSessionsRoot());
      combined.throwIfAborted();
      const action = params.action ?? "plan";
      if (params.model && params.models) throw new Error("Pass model or models, not both.");
      if (action === "generate" && (params.models?.length ?? 0) > 1) throw new Error("generate uses one model; compare with plan/calibrate first.");
      const targets = resolveTargets(index, params, ctx);
      const names = params.models ?? [params.model];
      const models = [...new Map(names.map((name) => resolveSummaryModel(ctx, name, params.reasoning)).map((m) => [m.key, m])).values()];
      const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
      const maxSections = params.maxSections ?? 4;
      const memo: SectionMemo = new Map();
      const plansFor = new Map(models.map((m) => [m.key, buildPlans(index, targets.paths, m, memo)]));
      const budget = params.maxChars ?? 16_000;

      if (action === "plan") {
        const views = models.map((m) => planView(index, plansFor.get(m.key)!, m, concurrency));
        return {
          content: [{ type: "text", text: formatSummaryPlan({ scope: targets.description, sessions: targets.paths.length, models: views, maxSections, maxCost: params.maxCost, concurrency }, budget) }],
          details: { action, sessions: targets.paths.length, models: views.map(({ key, sections, cached, remaining, estimate }) => ({ key, sections, cached, remaining, estimate })) },
        };
      }

      for (const m of models) {
        const plans = plansFor.get(m.key)!;
        const needsWork = plans.some((p) => p.remaining > 0);
        if (needsWork && !ctx.modelRegistry.hasConfiguredAuth(m.model)) throw new Error(`No authentication configured for ${m.name}.`);
      }
      const busy = targets.paths.filter((p) => generating.has(p));
      if (busy.length && busy.length === targets.paths.length) throw new Error("Summary generation for these sessions is already running. Retry after it finishes.");
      const locked = targets.paths.filter((p) => !generating.has(p));
      const lockedSet = new Set(locked);
      locked.forEach((p) => generating.add(p));
      const usage: Usage = emptyUsage();
      try {
        if (action === "generate") {
          const model = models[0]!;
          const plans = plansFor.get(model.key)!.filter((p) => lockedSet.has(p.path));
          const result = await runSummaries(index, plans, summaryCompleter(ctx.modelRegistry, model, combined), {
            key: model.key, purpose: "generate", publish: true, maxCalls: maxSections, maxCost: params.maxCost, concurrency, signal: combined,
            onProgress: (progress) => onUpdate?.({ content: [{ type: "text", text: formatRunResult(progress, { running: true }) }], details: { action } }),
          });
          const after = planView(index, plans, model, concurrency);
          const text = formatRunResult(result, { busySkipped: busy.length, remaining: after, concurrency });
          return { content: [{ type: "text", text }], details: { action, ...result }, usage: result.usage };
        }

        // calibrate
        const samples = params.samples ?? DEFAULT_SAMPLES;
        const rows: CalibrationRow[] = [];
        let spent = 0;
        for (const model of models) {
          const plans = plansFor.get(model.key)!.filter((p) => lockedSet.has(p.path));
          const sample = sampleSections(plans, samples);
          const wanted = new Set(sample.map(({ plan, section }) => `${plan.path}\0${section.hash}`));
          let result: RunResult;
          if (params.maxCost !== undefined && spent >= params.maxCost) {
            result = { model: model.key, sessions: 0, sections: sample.length, cached: 0, generated: 0, remaining: sample.length, calls: 0, failed: [], published: 0, completeSessions: 0, usage: emptyUsage(), stopped: `Skipped: the $${params.maxCost} cost ceiling was reached.` };
          } else {
            result = await runSummaries(index, plans, summaryCompleter(ctx.modelRegistry, model, combined), {
              key: model.key, purpose: "calibrate", publish: false, maxCalls: sample.length,
              maxCost: params.maxCost === undefined ? undefined : params.maxCost - spent, concurrency, signal: combined,
              select: (plan, section) => wanted.has(`${plan.path}\0${section.hash}`),
              onProgress: (progress) => onUpdate?.({ content: [{ type: "text", text: `Calibrating ${model.key}: ${progress.generated + progress.failed.length}/${progress.sections - progress.cached} calls · $${progress.usage.cost.total.toFixed(4)}` }], details: { action } }),
            });
          }
          spent += result.usage.cost.total;
          addUsage(usage, result.usage);
          rows.push({ model, result, sample, plan: planView(index, plans, model, concurrency) });
          if (combined.aborted) break;
        }
        const text = formatCalibration({ scope: targets.description, rows, db: index.db, busySkipped: busy.length, concurrency }, budget);
        return { content: [{ type: "text", text }], details: { action, models: rows.map((r) => ({ key: r.model.key, ...r.result, estimate: r.plan.estimate })) }, usage };
      } finally { locked.forEach((p) => generating.delete(p)); }
    },
  });
}
