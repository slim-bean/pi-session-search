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
    async complete(_model: any, context: any, options: any) {
      calls++;
      assert(options.signal instanceof AbortSignal);
      assert.equal(options.maxTokens, 4096);
      assert.equal(context.tools, undefined, "summarizer has no tools");
      assert(context.systemPrompt.includes("UNTRUSTED"));
      const input = context.messages[0].content;
      assert(!input.includes("SECRET_THINKING"));
      assert(!input.includes("SECRET_TOOL"));
      const spans = JSON.parse(input);
      return { content: [{ type: "text", text: JSON.stringify({ overview: "Topic overview", topics: [{
        title: "Retrieval alternatives", summary: "Assistant suggested embeddings; user has not accepted it.", keywords: ["semantic", "retrieval"], entries: [spans[0].index],
      }] }) }], stopReason: "stop", usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    },
  },
};
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
  assert.equal(plan.details.remaining, 1);
  assert.equal(plan.details.model, "fake/model");
  assert.equal(calls, 0, "default summary action is plan");
  configuredAuth = false;
  await assert.rejects(call("session_summarize", { path: history, action: "generate" }), /authentication/);
  assert.equal(calls, 0);
  configuredAuth = true;
  const generated = await call("session_summarize", { path: history, action: "generate", maxSections: 1 });
  assert.equal(generated.details.complete, true);
  assert.equal(generated.usage.totalTokens, 20, "nested usage returned to pi");
  assert.equal(calls, 1);
  assert.equal((await call("session_read", { path: history, view: "summary" })).details.status, "ready");
  assert.equal((await call("session_search", { query: "semantic", roles: ["generated"] })).details.total, 1);
  await call("session_summarize", { path: history, action: "generate" });
  assert.equal(calls, 1, "fresh summary reuses cached work");
  await assert.rejects(call("session_summarize", { path: history, model: "bad" }), /provider\/model/);
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
