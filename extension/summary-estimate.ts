/** Cost/time projections from logged calls (calibrated) or explicit rough bounds. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "node:sqlite";
import { SUMMARY_PROMPT, type SummaryPlan, type SummarySection } from "./summarizer.ts";
import { SUMMARY_VERSION } from "./summary-store.ts";

/** Rough, uncalibrated bounds. Measured: ~3.7 chars/token (OpenAI o200k) to ~2.5 (newer Claude). */
export const ROUGH_CHARS_PER_TOKEN: [number, number] = [4, 2.4];
export const ROUGH_OUTPUT_TOKENS: [number, number] = [1000, 4096];

export interface CallStats {
  calls: number; ok: number; failureRate: number;
  tokensPerChar: number; meanOutputTokens: number; meanDurationMs: number; meanCost: number;
}

export function callStats(db: DatabaseSync, key: string): CallStats | undefined {
  const row = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok,
      SUM(CASE WHEN input_tokens + cache_read_tokens + cache_write_tokens > 0 THEN input_chars END) AS chars,
      SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS inputTokens,
      AVG(CASE WHEN input_tokens > 0 THEN output_tokens END) AS output,
      AVG(duration_ms) AS duration, AVG(cost) AS cost
    FROM summary_calls WHERE model = ? AND version = ?`).get(key, SUMMARY_VERSION) as any;
  if (!row?.calls || !row.chars) return undefined;
  return {
    calls: row.calls, ok: row.ok, failureRate: (row.calls - row.ok) / row.calls,
    tokensPerChar: row.inputTokens / row.chars, meanOutputTokens: row.output ?? 0,
    meanDurationMs: row.duration ?? 0, meanCost: row.cost ?? 0,
  };
}

export interface Estimate {
  calibrated: boolean; calls: number; inputChars: number;
  inputTokens: [number, number]; outputTokens: [number, number];
  /** Undefined when the registry has no price for this model. */
  cost?: [number, number];
  wallMs?: number; stats?: CallStats;
}

/** Project the cost of summarizing `sections` (uncached work only) with one model. */
export function estimateWork(sections: Pick<SummarySection, "input">[], model: Model<Api>, maxTokens: number, stats: CallStats | undefined, concurrency: number): Estimate {
  const calls = sections.length;
  const inputChars = sections.reduce((n, s) => n + s.input.length + SUMMARY_PROMPT.length, 0);
  let inputTokens: [number, number];
  let outputTokens: [number, number];
  let retry = 1;
  if (stats) {
    const input = inputChars * stats.tokensPerChar;
    const output = calls * stats.meanOutputTokens;
    inputTokens = [input, input]; outputTokens = [output, output];
    // Failed attempts are billed and then retried on the next run.
    retry = 1 / (1 - Math.min(stats.failureRate, 0.9));
  } else {
    inputTokens = [inputChars / ROUGH_CHARS_PER_TOKEN[0], inputChars / ROUGH_CHARS_PER_TOKEN[1]];
    outputTokens = [calls * ROUGH_OUTPUT_TOKENS[0], calls * Math.min(ROUGH_OUTPUT_TOKENS[1], maxTokens)];
  }
  const price = model.cost;
  const priced = Boolean(price && (price.input || price.output));
  const cost = priced ? [0, 1].map((i) => retry * (inputTokens[i]! * price.input + outputTokens[i]! * price.output) / 1e6) as [number, number] : undefined;
  return {
    calibrated: Boolean(stats), calls, inputChars, inputTokens, outputTokens, cost, stats,
    wallMs: stats ? retry * calls * stats.meanDurationMs / Math.max(1, concurrency) : undefined,
  };
}

/**
 * Deterministic calibration sample spread across the section-size distribution, so
 * the sample mean approximates the scope. Same scope + section size → same sample,
 * which makes model comparisons like-for-like.
 */
export function sampleSections(plans: SummaryPlan[], count: number): { plan: SummaryPlan; section: SummarySection }[] {
  const all = plans.flatMap((plan) => plan.sections.map((section) => ({ plan, section })))
    .sort((a, b) => a.section.input.length - b.section.input.length || a.section.hash.localeCompare(b.section.hash));
  if (all.length <= count) return all;
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) picked.add(Math.min(all.length - 1, Math.floor((i + 0.5) * all.length / count)));
  return [...picked].map((i) => all[i]!);
}
