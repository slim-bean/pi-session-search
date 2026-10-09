/**
 * Provider-neutral summarizer model calls. Reasoning goes through pi's simple API so
 * every provider maps it correctly. (Provider-specific `complete()` options silently
 * dropped `reasoningEffort` for Anthropic; managed-effort Claude models then thought at
 * effort "high" inside the answer's token ceiling.)
 */
import { randomUUID } from "node:crypto";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SECTION_CHARS, type CompleteSummary } from "./summarizer.ts";
import { modelDeadline } from "./model-deadline.ts";

export const SUMMARY_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type SummaryReasoning = typeof SUMMARY_REASONING_LEVELS[number];
export const DEFAULT_SUMMARY_REASONING: SummaryReasoning = "low";
/** Ceiling for thinking (adaptive/OpenAI) plus the JSON answer. Only generated tokens are billed. */
export const SUMMARY_MAX_TOKENS = 8192;
export const SUMMARY_CALL_TIMEOUT_MS = 600_000;

export interface SummaryModel {
  model: Model<Api>;
  /** provider/model-id */
  name: string;
  /** Effective level after clamping to what the model supports. */
  reasoning: ModelThinkingLevel;
  /** Cache and calibration key; different reasoning levels are different generators. */
  key: string;
  maxTokens: number;
  sectionChars: number;
}

export function resolveSummaryModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, name?: string, requested: SummaryReasoning = DEFAULT_SUMMARY_REASONING): SummaryModel {
  let model: Model<Api> | undefined;
  if (!name) {
    model = ctx.model;
    if (!model) throw new Error("No active model. Select one or specify provider/model.");
  } else {
    const slash = name.indexOf("/");
    if (slash < 1) throw new Error("model must be provider/model-id.");
    model = ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
    if (!model) throw new Error(`Model not found: ${name}`);
  }
  const reasoning = clampThinkingLevel(model, requested);
  const maxTokens = Math.min(SUMMARY_MAX_TOKENS, model.maxTokens);
  // Conservative: assume as few as 2 characters per token (dense code/JSON/non-English).
  const sectionChars = Math.min(SECTION_CHARS, (model.contextWindow - maxTokens - 1000) * 2);
  if (sectionChars < 1000) throw new Error(`${model.provider}/${model.id} has too small a context window for summary generation.`);
  const modelName = `${model.provider}/${model.id}`;
  return { model, name: modelName, reasoning, key: `${modelName}@${reasoning}`, maxTokens, sectionChars };
}

export function summaryCompleter(registry: ExtensionContext["modelRegistry"], summaryModel: SummaryModel, signal?: AbortSignal,
  onModelEvent?: (event: any) => void, onCompletedUsage?: (usage: any) => void, timeoutMs = SUMMARY_CALL_TIMEOUT_MS): CompleteSummary {
  return async (systemPrompt, input, callSignal) => {
    const tracingAbort = new AbortController();
    const signals = [signal, callSignal, tracingAbort.signal].filter((s): s is AbortSignal => Boolean(s));
    const call = modelDeadline(signals, timeoutMs);
    const messages = [{ role: "user" as const, content: input, timestamp: Date.now() }];
    onModelEvent?.({ type: "start", provider: summaryModel.model.provider, model: summaryModel.model.id, systemPrompt, messages,
      reasoning: summaryModel.reasoning === "off" ? undefined : summaryModel.reasoning, maxTokens: summaryModel.maxTokens, timeoutMs });
    const stream = registry.streamSimple(summaryModel.model, { systemPrompt, messages }, {
      signal: call.signal,
      maxTokens: summaryModel.maxTokens,
      reasoning: summaryModel.reasoning === "off" ? undefined : summaryModel.reasoning,
      sessionId: randomUUID(),
    });
    try {
      if (onModelEvent && Symbol.asyncIterator in stream) {
        for await (const event of stream) {
          if (event.type === "text_delta" || event.type === "thinking_delta") onModelEvent({ type: "delta",
            channel: event.type === "text_delta" ? "text" : "thinking", delta: event.delta });
        }
      }
    } catch (error) {
      tracingAbort.abort(error);
      const final = await stream.result().catch(() => undefined);
      if (final) onCompletedUsage?.(final.usage);
      throw new Error(call.diagnostics().abortReason ?? String(error));
    }
    const response = await stream.result().catch(error => { throw new Error(call.diagnostics().abortReason ?? String(error)); });
    onCompletedUsage?.(response.usage);
    const diagnostics = call.diagnostics(response.stopReason, response.errorMessage);
    onModelEvent?.({ type: "end", message: response, ...diagnostics });
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (call.signal.aborted || response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
      return { text, usage: response.usage, stopReason: call.signal.aborted ? "aborted" : response.stopReason,
        error: diagnostics.abortReason ?? response.errorMessage ?? `Summary model stopped: ${response.stopReason}` };
    }
    return { text, usage: response.usage, stopReason: response.stopReason };
  };
}
