/** Exercise the real registered tool surface with a fake pi model registry (no network/billing). */
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { SessionIndex } from "../extension/indexer.ts";
import { registerSessionTools } from "../extension/tools.ts";
import { fixture, message } from "./fixtures.ts";

const f = fixture();
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = f.dir;
const index = new SessionIndex(join(f.dir, "index.db"));
const tools = new Map<string, any>();
const shutdown = new AbortController();
registerSessionTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any, () => index, shutdown.signal);
const model = { provider: "fake", id: "model", contextWindow: 32000, maxTokens: 4096 };
let calls = 0;
let configuredAuth = true;
const ctx: any = {
  cwd: "/work/search", model,
  sessionManager: { getSessionFile: () => current },
  modelRegistry: {
    find(provider: string, id: string) { return provider === "fake" ? { ...model, id } : undefined; },
    hasConfiguredAuth() { return configuredAuth; },
    streamSimple(_model: any, context: any, options: any) { return { result: () => respond(context, options) }; },
    complete() { throw new Error("summarizer must use provider-neutral streamSimple"); },
  },
};
let failNext = false;
async function respond(context: any, options: any) {
      calls++;
      assert(options.signal instanceof AbortSignal);
      assert.equal(options.maxTokens, 4096, "min(summary ceiling, model maxTokens)");
      assert.equal(options.reasoning, undefined, "non-reasoning model gets no reasoning option");
      if (failNext) { failNext = false; return { content: [], stopReason: "error", errorMessage: "provider exploded", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } }; }
      assert.equal(context.tools, undefined, "summarizer has no tools");
      assert(context.systemPrompt.includes("UNTRUSTED"));
      const input = context.messages[0].content;
      assert(!input.includes("SECRET_THINKING"));
      assert(!input.includes("SECRET_TOOL"));
      const spans = JSON.parse(input);
      return { content: [{ type: "text", text: JSON.stringify({ overview: "Topic overview", topics: [{
        title: "Retrieval alternatives", summary: "Assistant suggested embeddings; user has not accepted it.", keywords: ["semantic", "retrieval"], entries: [spans[0].index],
      }] }) }], stopReason: "stop", usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const history = f.write("history", ctx.cwd, [
  message("user", "Can we improve retrieval?"),
  { type: "message", message: { role: "assistant", content: [
    { type: "thinking", thinking: "SECRET_THINKING" }, { type: "text", text: "Maybe embeddings." },
    { type: "toolCall", name: "bash", arguments: { command: "SECRET_TOOL" } },
  ] } },
  message("toolResult", "SECRET_TOOL", undefined, { toolName: "bash" }),
]);
const current = f.write("current", ctx.cwd, [message("user", "Embeddings again")]);
const call = (name: string, params: any, signal = new AbortController().signal) => tools.get(name).execute("call", params, signal, undefined, ctx);
try {
  assert.deepEqual([...tools.keys()], ["session_search", "session_read", "session_summarize"]);
  const found = await call("session_search", { query: "embeddings", project: "current" });
  assert.equal(found.details.total, 1);
  assert.equal(found.details.hits[0].path, history);
  assert(!found.content[0].text.includes("resume:"));
  assert.equal((await call("session_search", { query: "embeddings", excludeCurrent: false })).details.total, 2);
  const projects = await call("session_search", { group: "projects" });
  assert.equal(projects.details.projects[0].cwd, ctx.cwd);
  const conversation = (await call("session_read", { path: history, entries: "1-3" })).content[0].text;
  assert(conversation.includes("Maybe embeddings"));
  assert(!conversation.includes("SECRET_"));
  assert((await call("session_read", { path: history, entries: "1-3", view: "full" })).content[0].text.includes("SECRET_TOOL"));
  assert(!(await call("session_read", { path: history, query: "SECRET_TOOL" })).content[0].text.includes("#3"));
  assert((await call("session_read", { path: history, query: "SECRET_TOOL", view: "full" })).content[0].text.includes("#3"));
  assert((await call("session_read", { path: history, around: 2 })).content[0].text.includes("#1 user"));
  for (const params of [
    { entries: "1", query: "x" }, { entries: "1", around: 2 }, { query: "x", around: 2 }, { context: 2 },
    { offsetChars: 1 }, { view: "summary", entries: "1" }, { entries: "1-2", offsetChars: 10 },
  ]) await assert.rejects(call("session_read", { path: history, ...params }));
  assert.equal((await call("session_read", { path: history, view: "summary" })).details.status, "missing");
  assert.equal(calls, 0, "ordinary search and all read modes never invoke models");
  const plan = await call("session_summarize", { path: history });
  assert.equal(plan.details.models[0].remaining, 1);
  assert.equal(plan.details.models[0].key, "fake/model@off", "cache key includes effective reasoning");
  assert.match(plan.content[0].text, /ROUGH, uncalibrated/);
  assert.equal(calls, 0, "default summary action is plan");
  configuredAuth = false;
  await assert.rejects(call("session_summarize", { path: history, action: "generate" }), /authentication/);
  assert.equal(calls, 0);
  configuredAuth = true;
  const generated = await call("session_summarize", { path: history, action: "generate", maxSections: 1 });
  assert.equal(generated.details.published, 1);
  assert.equal(generated.usage.totalTokens, 20, "nested usage returned to pi");
  assert.equal(calls, 1);
  assert.equal((await call("session_read", { path: history, view: "summary" })).details.status, "ready");
  assert.equal((await call("session_search", { query: "semantic", roles: ["generated"] })).details.total, 1);
  await call("session_summarize", { path: history, action: "generate" });
  assert.equal(calls, 1, "fresh summary reuses cached work");
  await assert.rejects(call("session_summarize", { path: history, model: "bad" }), /provider\/model/);
  for (const params of [{}, { path: history, paths: [history] }, { scope: {} }, { scope: { projectScope: "tree" } },
    { path: history, model: "fake/a", models: ["fake/b"] }, { path: history, action: "generate", models: ["fake/a", "fake/b"] }]) {
    await assert.rejects(call("session_summarize", params), undefined, JSON.stringify(params));
  }
  assert.equal(calls, 1, "invalid scope/model combinations make no calls");

  // Scope: session_search filters; current session excluded by default.
  const extra = f.write("extra", "/work/other", [message("user", "Unrelated planning about gardens."), message("assistant", "Tomatoes need sun.")]);
  const all = await call("session_summarize", { scope: { all: true } });
  assert.equal(all.details.sessions, 2, "all:true minus the current session");
  assert.equal((await call("session_summarize", { scope: { all: true }, excludeCurrent: false })).details.sessions, 3);
  assert.equal((await call("session_summarize", { scope: { project: "current" } })).details.sessions, 1);
  assert.equal((await call("session_summarize", { scope: { query: "tomatoes" } })).details.sessions, 1);
  assert.equal((await call("session_summarize", { paths: [history, extra, history] })).details.sessions, 2, "paths deduplicated");

  // Calibrate compares models on the same sample; caches but never publishes.
  const calibrated = await call("session_summarize", { action: "calibrate", scope: { all: true }, models: ["fake/model", "fake/other"], samples: 5 });
  assert.equal(calls, 4, "1 earlier + one new sample section (extra) for fake/model, which already cached history; two for fake/other");
  const calText = calibrated.content[0].text;
  assert.match(calText, /fake\/model@off/); assert.match(calText, /fake\/other@off/);
  assert.match(calText, /Sample 1:/); assert.match(calText, /Retrieval alternatives/);
  assert.match(calText, /Measured over \d+ logged calls/);
  assert.equal((await call("session_read", { path: extra, view: "summary" })).details.status, "partial", "calibration is not published");
  const replan = await call("session_summarize", { scope: { all: true }, models: ["fake/model", "fake/other"] });
  assert(replan.details.models.every((m: any) => m.remaining === 0 && m.estimate.calibrated));

  // Batch generate publishes the whole scope from cached calibration sections (free).
  const batch = await call("session_summarize", { action: "generate", scope: { all: true }, model: "fake/other", maxSections: 10 });
  assert.equal(calls, 4); assert.equal(batch.details.published, 2);
  assert.match(batch.content[0].text, /generation complete/);
  const third = f.write("third", "/work/other", [message("user", "More garden talk."), message("assistant", "Water deeply.")]);
  failNext = true;
  const failing = await call("session_summarize", { action: "generate", paths: [third], model: "fake/third" });
  assert.equal(failing.details.failed.length, 1); assert.equal(failing.usage.cost.total, 0.5, "failed attempts still report usage");
  assert.match(failing.content[0].text, /provider exploded/);
  assert.equal((await call("session_summarize", { action: "generate", paths: [third], model: "fake/third" })).details.published, 1, "rerun retries failures");
  await assert.rejects(call("session_summarize", { path: history, model: "unknown/model" }), /not found/);

  writeFileSync(history, "temporarily malformed header");
  const stale = await call("session_search", { query: "embeddings", maxChars: 2000 });
  assert(stale.content[0].text.startsWith("Warning:"));
  assert(stale.content[0].text.length <= 2000, "sync warnings respect output budget too");

  const aborted = AbortSignal.abort();
  await assert.rejects(call("session_search", {}, aborted));
  await assert.rejects(call("session_read", { path: history }, aborted));
  shutdown.abort();
  await assert.rejects(call("session_summarize", { path: history }, new AbortController().signal));
  console.log("tool tests passed (registered surface, defaults, safety, no implicit generation, provider adapter)");
} finally {
  index.close(); f.cleanup();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
}
