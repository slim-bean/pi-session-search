import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultSessionsRoot, type SessionIndex } from "./indexer.ts";
import { planSummary, runSummaries } from "./summarizer.ts";
import { resolveSummaryModel, summaryCompleter } from "./summary-model.ts";
import { readSummary, SUMMARY_VERSION } from "./summary-store.ts";

/** Trusted process-local integration; not a model tool or permission boundary. */
export interface SummaryMaintenanceRequest {
  protocol: 1; operation: "status" | "run"; context: ExtensionContext;
  path: string; sourceHash: string; model?: string; maxCost?: number;
  signal?: AbortSignal; onUsage?: (usage: any) => void; onProgress?: (text: string) => void;
  result?: Promise<unknown>;
}
export function registerSummaryMaintenance(pi: ExtensionAPI, getIndex: () => SessionIndex) {
  let active: AbortController | undefined;
  let pending: Promise<unknown> | undefined;
  pi.events.on("pi-session-search:maintenance:v1", (data) => {
    const request = data as SummaryMaintenanceRequest;
    if (request.operation === "run" && active) { request.result = Promise.reject(new Error("Summary maintenance already running in this runtime")); return; }
    const own = request.operation === "run" ? new AbortController() : undefined;
    if (own) active = own;
    request.result = (async () => {
      if (request.protocol !== 1 || !["status", "run"].includes(request.operation)) throw new Error("Unsupported summary maintenance request");
      const model = resolveSummaryModel(request.context, request.model);
      const key = `${SUMMARY_VERSION}:${model.key}`;
      const index = getIndex();
      await index.sync(defaultSessionsRoot());
      request.signal?.throwIfAborted(); own?.signal.throwIfAborted();
      const plan = planSummary(index, request.path, model.key, model.sectionChars);
      if (plan.sourceHash !== request.sourceHash) throw new Error("Session source changed before summary maintenance");
      const record = readSummary(index.db, plan.path, plan.sourceHash);
      if (request.operation === "status") return { key, complete: record.status === "ready" && record.model === model.key, remaining: plan.remaining };
      if (plan.remaining && !request.context.modelRegistry.hasConfiguredAuth(model.model)) throw new Error(`No configured auth for ${model.name}`);
      const signal = AbortSignal.any([own!.signal, ...(request.signal ? [request.signal] : [])]);
      try {
        const result = await runSummaries(index, [plan], async (system, input, callSignal) => {
          const response = await summaryCompleter(request.context.modelRegistry, model, signal)(system, input, callSignal);
          // Account even if cancellation prevents publication of a paid response.
          if (response.usage) request.onUsage?.(response.usage);
          return response;
        }, {
          key: model.key, purpose: "generate", publish: true, maxCalls: 1, maxCost: request.maxCost,
          concurrency: 1, signal,
          onProgress: (r) => request.onProgress?.(`summary: ${r.cached + r.generated}/${r.sections} sections`),
        });
        signal.throwIfAborted();
        if (result.failed.length) throw new Error(result.failed[0]!.error);
        const after = readSummary(index.db, plan.path, plan.sourceHash);
        return { key, complete: after.status === "ready" && after.model === model.key, remaining: result.remaining,
          detail: { sections: result.sections, cached: result.cached, generated: result.generated } };
      } finally { /* outer finally also covers preflight errors */ }
    })().finally(() => { if (active === own) active = undefined; });
    if (request.operation === "run") pending = request.result;
  });
  const cancel = () => active?.abort(new Error("Foreground activity interrupted summary maintenance"));
  pi.on("input", cancel);
  pi.on("agent_start", cancel);
  return { async stop() { cancel(); await pending?.catch(() => {}); pending = undefined; } };
}
