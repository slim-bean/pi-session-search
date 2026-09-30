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

export const SUMMARY_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type SummaryReasoning = typeof SUMMARY_REASONING_LEVELS[number];
export const DEFAULT_SUMMARY_REASONING: SummaryReasoning = "low";
/** Ceiling for thinking (adaptive/OpenAI) plus the JSON answer. Only generated tokens are billed. */
export const SUMMARY_MAX_TOKENS = 8192;
export const SUMMARY_CALL_TIMEOUT_MS = 180_000;

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

export function summaryCompleter(registry: ExtensionContext["modelRegistry"], summaryModel: SummaryModel, signal?: AbortSignal): CompleteSummary {
  return async (systemPrompt, input, callSignal) => {
    const signals = [signal, callSignal].filter((s): s is AbortSignal => Boolean(s));
    const response = await registry.streamSimple(summaryModel.model, {
      systemPrompt, messages: [{ role: "user", content: input, timestamp: Date.now() }],
    }, {
      signal: AbortSignal.any([...signals, AbortSignal.timeout(SUMMARY_CALL_TIMEOUT_MS)]),
      maxTokens: summaryModel.maxTokens,
      reasoning: summaryModel.reasoning === "off" ? undefined : summaryModel.reasoning,
      sessionId: randomUUID(),
    }).result();
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
      return { text, usage: response.usage, stopReason: response.stopReason, error: response.errorMessage ?? `Summary model stopped: ${response.stopReason}` };
    }
    return { text, usage: response.usage, stopReason: response.stopReason };
  };
}
