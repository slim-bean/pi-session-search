/** Batch engine, budgets, call accounting, estimates, calibration sampling, and the model adapter. No network. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionIndex } from "../extension/indexer.ts";
import { planSummary, runSummaries, SUMMARY_PROMPT, type CompleteSummary } from "../extension/summarizer.ts";
import { callStats, estimateWork, ROUGH_CHARS_PER_TOKEN, sampleSections } from "../extension/summary-estimate.ts";
import { resolveSummaryModel, summaryCompleter, SUMMARY_MAX_TOKENS } from "../extension/summary-model.ts";
import { readSummary } from "../extension/summary-store.ts";
import { searchSessions } from "../extension/search.ts";
import { fixture, message } from "./fixtures.ts";

const f = fixture();
const index = new SessionIndex(join(f.dir, "index.db"));
const usage = (cost: number) => ({ input: 1000, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const ok = (input: string) => JSON.stringify({ overview: "Overview", topics: [{ title: "Batch topic", summary: "Summary.", keywords: ["batchword"], entries: [JSON.parse(input)[0].index] }] });
try {
  const paths = Array.from({ length: 6 }, (_, i) => f.write(`s${i}`, "/work/batch", [
    message("user", `Question ${i} ` + "detail ".repeat(200 * (i + 1))),
    message("assistant", `Answer ${i} ` + "reply ".repeat(300 * (i + 1))),
  ]));
  await index.sync(f.root);
  const key = "fake/m@off";
  const plans = paths.map((p) => planSummary(index, p, key, 3000));
  const total = plans.reduce((n, p) => n + p.sections.length, 0);
  assert(total > 12, "fixture spans multiple sections per session");

  // Concurrency is bounded and actually used; sessions publish as they complete.
  let active = 0, peak = 0;
  const slow: CompleteSummary = async (_s, input) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; return { text: ok(input), usage: usage(0.01), stopReason: "stop" };
  };
  const capped = await runSummaries(index, plans, slow, { key, purpose: "generate", publish: true, maxCalls: 5, concurrency: 3 });
  assert.equal(capped.calls, 5); assert.equal(capped.generated, 5); assert(peak <= 3 && peak >= 2, `peak concurrency ${peak}`);
  assert.match(capped.stopped ?? "", /5-call limit/);
  assert.equal(capped.remaining, total - 5);

  // Cost ceiling: first call alone to learn cost, then stop before exceeding.
  const budgeted = await runSummaries(index, plans, slow, { key, purpose: "generate", publish: true, maxCalls: 1000, maxCost: 0.035, concurrency: 4 });
  assert(budgeted.usage.cost.total <= 0.035 + 1e-9, `spent ${budgeted.usage.cost.total}`);
  assert.equal(budgeted.generated, 3); assert.match(budgeted.stopped ?? "", /cost ceiling/);

  const rest = await runSummaries(index, plans, slow, { key, purpose: "generate", publish: true, maxCalls: 1000, concurrency: 8 });
  assert.equal(rest.remaining, 0); assert.equal(rest.stopped, undefined);
  assert.equal(rest.completeSessions, 6);
  assert.equal(capped.published + budgeted.published + rest.published, 6, "each session published exactly once");
  assert(paths.every((p, i) => readSummary(index.db, p, plans[i]!.sourceHash).status === "ready"));
  assert.equal(searchSessions(index, { query: "batchword", roles: ["generated"] }).total, 6);

  // Call accounting feeds calibrated estimates.
  const stats = callStats(index.db, key)!;
  assert.equal(stats.calls, total); assert.equal(stats.failureRate, 0); assert.equal(stats.meanOutputTokens, 300);
  const loggedChars = (index.db.prepare("SELECT SUM(input_chars) AS n FROM summary_calls WHERE model = ?").get(key) as any).n;
  assert.equal(loggedChars, plans.reduce((n, p) => n + p.sections.reduce((m, s) => m + s.input.length + SUMMARY_PROMPT.length, 0), 0));
  const model: any = { provider: "fake", id: "m", cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8192 };
  const sections = plans.flatMap((p) => p.sections);
  const calibrated = estimateWork(sections, model, 8192, stats, 4);
  assert(calibrated.calibrated);
  assert(Math.abs(calibrated.inputTokens[0] - 1000 * total) < 1e-6, "input tokens scale by the measured tokens/char");
  assert.equal(calibrated.outputTokens[0], 300 * total);
  assert(Math.abs(calibrated.cost![0] - (1000 * total * 2 + 300 * total * 10) / 1e6) < 1e-9);
  assert(calibrated.wallMs! > 0);
  const rough = estimateWork(sections, model, 8192, undefined, 4);
  assert(!rough.calibrated && rough.cost![0] < rough.cost![1]);
  assert.equal(rough.inputTokens[0], rough.inputChars / ROUGH_CHARS_PER_TOKEN[0]);
  assert.equal(estimateWork(sections, { ...model, cost: { input: 0, output: 0 } }, 8192, stats, 4).cost, undefined, "no price → unknown, not $0");
  assert.equal(estimateWork(sections, model, 8192, { ...stats, failureRate: 0.5 }, 4).cost![0], calibrated.cost![0] * 2, "failures inflate cost");

  // Consecutive failures stop the run; isolated failures don't.
  const otherKey = "fake/flaky@off";
  let n = 0;
  const flaky = await runSummaries(index, plans, async (_s, input) => (++n % 2 ? { text: "nope", usage: usage(0) } : { text: ok(input), usage: usage(0) }),
    { key: otherKey, purpose: "generate", publish: false, maxCalls: 10, concurrency: 1 });
  assert.equal(flaky.failed.length, 5); assert.equal(flaky.generated, 5); assert.equal(flaky.stopped, "Reached the 10-call limit for this invocation.");
  const broken = await runSummaries(index, plans, async () => ({ text: "", usage: usage(0), error: "HTTP 500" }),
    { key: "fake/broken@off", purpose: "generate", publish: true, maxCalls: 100, concurrency: 2 });
  assert.match(broken.stopped ?? "", /consecutive failures/); assert(broken.calls <= 6);
  assert.equal(callStats(index.db, "fake/broken@off")!.failureRate, 1);

  // Calibration: deterministic size-spread sample, cached but not published.
  const sample = sampleSections(plans, 4);
  assert.equal(sample.length, 4);
  assert.deepEqual(sample.map((s) => s.section.hash), sampleSections(plans, 4).map((s) => s.section.hash), "deterministic");
  const sizes = sample.map((s) => s.section.input.length);
  assert(sizes[0]! <= sizes[3]!, "ordered by size across the distribution");
  const wanted = new Set(sample.map((s) => `${s.plan.path}\0${s.section.hash}`));
  const cal = await runSummaries(index, plans, slow, { key: "fake/cal@low", purpose: "calibrate", publish: false, maxCalls: 4, concurrency: 2, select: (p, s) => wanted.has(`${p.path}\0${s.hash}`) });
  assert.equal(cal.generated, 4); assert.equal(cal.sections, 4); assert.equal(cal.published, 0);
  assert.equal((index.db.prepare("SELECT COUNT(*) AS n FROM summary_calls WHERE purpose = 'calibrate'").get() as any).n, 4);
  assert(paths.every((p, i) => readSummary(index.db, p, plans[i]!.sourceHash).model === key), "calibration never replaces published summaries");
  assert.equal(sampleSections(plans, 1000).length, total, "small scopes sample everything");

  // Model adapter: provider-neutral reasoning through streamSimple (the Anthropic effort bug).
  const managed: any = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128000,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" }, cost: { input: 4, output: 20 } };
  const plain: any = { provider: "openai", id: "gpt-x", reasoning: false, contextWindow: 128000, maxTokens: 4096 };
  const calls: any[] = [];
  const registry: any = {
    find: (p: string, id: string) => [managed, plain].find((m) => m.provider === p && m.id === id),
    streamSimple(m: any, context: any, options: any) {
      calls.push({ m, context, options });
      return { result: async () => ({ content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "{}" }], stopReason: options.maxTokens < 10 ? "length" : "stop", usage: usage(0) }) };
    },
  };
  const ctx: any = { model: managed, modelRegistry: registry };
  const opus = resolveSummaryModel(ctx);
  assert.equal(opus.reasoning, "low"); assert.equal(opus.key, "anthropic/claude-opus-5-5@low");
  assert.equal(resolveSummaryModel(ctx, undefined, "off").reasoning, "low", "unsupported 'off' clamps instead of silently falling back to high effort");
  assert.equal(resolveSummaryModel(ctx, undefined, "high").key, "anthropic/claude-opus-5-5@high");
  assert.equal(opus.maxTokens, SUMMARY_MAX_TOKENS); assert.equal(opus.sectionChars, 24000);
  const gpt = resolveSummaryModel(ctx, "openai/gpt-x", "medium");
  assert.equal(gpt.reasoning, "off"); assert.equal(gpt.key, "openai/gpt-x@off"); assert.equal(gpt.maxTokens, 4096);
  assert.throws(() => resolveSummaryModel(ctx, "openai/none"), /not found/);
  assert.throws(() => resolveSummaryModel({ modelRegistry: registry } as any), /No active model/);

  const reply = await summaryCompleter(registry, opus)("SYS", "INPUT");
  assert.equal(reply.text, "{}", "thinking blocks never reach the parser");
  assert.equal(calls[0].options.reasoning, "low"); assert.equal(calls[0].options.maxTokens, SUMMARY_MAX_TOKENS);
  assert.equal(calls[0].context.systemPrompt, "SYS"); assert.equal(calls[0].context.tools, undefined);
  assert(calls[0].options.signal instanceof AbortSignal);
  await summaryCompleter(registry, gpt)("SYS", "INPUT");
  assert.equal(calls[1].options.reasoning, undefined, "off → no reasoning option");
  const truncated = await summaryCompleter(registry, { ...gpt, maxTokens: 5 })("SYS", "INPUT");
  assert.match(truncated.error ?? "", /length/); assert.equal(truncated.stopReason, "length");
  console.log("batch tests passed (concurrency, call/cost ceilings, failures, accounting, estimates, calibration, model adapter)");
} finally { index.close(); f.cleanup(); }
