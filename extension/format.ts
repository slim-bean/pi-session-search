/** All LLM-facing output. Compact evidence, explicit scope, bounded reads, actionable pagination. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { visibleEntries, type LoadedSession, type ReadEntry, type ViewOptions } from "./reader.ts";
import { HL_END, HL_START, extractTokens, makeSnippet, type SearchHit, type SearchPage, type ProjectPage, type SearchOptions } from "./search.ts";
import type { DatabaseSync } from "node:sqlite";
import { cachedSection, type SummaryRecord } from "./summary-store.ts";
import type { RunResult, SummaryPlan, SummarySection } from "./summarizer.ts";
import type { CallStats, Estimate } from "./summary-estimate.ts";
import type { SummaryModel } from "./summary-model.ts";

export const OUTLINE_LIMIT = 50;
export const FIND_LIMIT = 20;
export const READ_BUDGET = 20_000;
export function prettyPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
}
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
export function formatDate(ms: number | null): string { return ms === null ? "" : new Date(ms).toISOString().slice(0, 10); }
export function formatDateTime(ms: number | null): string { return ms === null ? "" : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"; }
export function formatSize(chars: number): string { return chars < 1000 ? `${chars}ch` : `${(chars / 1000).toFixed(1)}k ch`; }
export function resumeCommand(hit: Pick<SearchHit, "cwd" | "path">): string { return `cd ${shellQuote(hit.cwd)} && pi --session ${shellQuote(hit.path)}`; }
function plainSnippet(text: string): string { return text.replaceAll(HL_START, "«").replaceAll(HL_END, "»"); }
function clamp(raw: string, size = 120): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > size ? clean.slice(0, size - 1) + "…" : clean;
}
function sessionTitle(session: LoadedSession): string { return clamp(session.name ?? session.entries.find((e) => e.kind === "user")?.preview ?? "(empty session)"); }

export function describeScope(options: SearchOptions): string {
  const parts = [options.project ? `project=${options.project} (${options.projectScope ?? "exact"})` : "all projects"];
  if (options.excludePath) parts.push("current session excluded");
  if (options.query) parts.push(`query=${JSON.stringify(options.query)} (${options.match ?? "all"} terms)`);
  if (options.anyOf?.length) parts.push(`AND anyOf=${JSON.stringify(options.anyOf)}`);
  if (options.roles?.length) parts.push(`roles=${options.roles.join(",")}`);
  if (options.since || options.until) parts.push(`${options.dateField ?? "activity"} dates: ${options.since ?? "beginning"} … ${options.until ?? "now/unbounded"} (date-only: UTC)`);
  if (options.dateField === "message" && (options.since || options.until)) parts.push("metadata/generated summaries have no entry timestamp and are excluded");
  return "Scope: " + parts.join("; ");
}

export function formatSyncWarning(skipped: number): string {
  return skipped ? `Warning: ${skipped} unreadable/malformed session files could not be refreshed; some results may reflect older indexed text. Verify source evidence.\n\n` : "";
}

export interface FormatOptions { query: string; currentSessionPath?: string; includeResume?: boolean; maxChars?: number }
export interface FormattedPage { text: string; shown: number; nextOffset?: number }

function formatHit(hit: SearchHit, rank: number, options: Omit<FormatOptions, "query">): string {
  const current = hit.path === options.currentSessionPath ? " (current session)" : "";
  const missing = existsSync(hit.cwd) ? "" : " (directory missing)";
  const lines = [
    `${rank}. ${clamp(hit.name ?? hit.firstMessage ?? "(empty session)")}${current}`,
    `   ${prettyPath(hit.cwd)}${missing} · created ${formatDate(hit.createdAt)} · active ${formatDate(hit.activityAt ?? hit.modifiedAt)} · ${hit.messageCount} msgs${hit.hits ? ` · ${hit.hits} matching entries` : ""}`,
    `   path: ${hit.path}`,
  ];
  if (hit.metadataOnly) lines.push("   Match is in session name/path metadata only, not conversation text.");
  for (const snippet of hit.snippets) {
    const source = snippet.sourceRefs ? `generated summary → source #${snippet.sourceRefs.join(",#")}`
      : `${snippet.role}${snippet.entryIndex ? ` #${snippet.entryIndex}` : ""}`;
    lines.push(`   [${source}${snippet.timestampMs !== undefined && snippet.timestampMs !== null ? ` · ${formatDate(snippet.timestampMs)}` : ""}] ${plainSnippet(snippet.text)}`);
  }
  if (hit.summaryStatus) lines.push(`   summary: ${hit.summaryStatus}${!hit.hits && hit.summaryPreview ? ` — ${clamp(hit.summaryPreview, 240)}` : ""}`);
  if (options.includeResume) lines.push(`   resume: ${resumeCommand(hit)}`);
  return lines.join("\n");
}

function clipBlock(text: string, size: number): string {
  // Metadata can contain arbitrary source strings too. Keep room for the body
  // under the UTF-8/line ceilings even with unusually large paths or queries.
  size = Math.min(size, 10_000);
  const lines = text.split("\n", 201);
  const limited = lines.length > 200 ? lines.slice(0, 200).join("\n") : text;
  return limited.length > size || limited !== text
    ? limited.slice(0, Math.max(0, size - 30)) + "\n[display metadata shortened]" : text;
}

function pagedBlocks(header: string, blocks: string[], total: number, offset: number, maxChars: number, footer: string): FormattedPage {
  header = clipBlock(header, Math.floor(maxChars / 2));
  footer = clipBlock(footer, Math.floor(maxChars / 4));
  const chosen: string[] = [];
  let size = header.length + footer.length + 250;
  let bytes = Buffer.byteLength(header + footer) + 1000;
  let lineCount = (header + footer).split("\n").length + 10;
  for (const block of blocks) {
    const blockLines = block.split("\n").length + 2;
    if (size + block.length + 2 > maxChars || bytes + Buffer.byteLength(block) + 2 > 45_000 || lineCount + blockLines > 1800) break;
    chosen.push(block); size += block.length + 2; bytes += Buffer.byteLength(block) + 2; lineCount += blockLines;
  }
  const nextOffset = total > offset + chosen.length ? offset + chosen.length : undefined;
  const range = chosen.length ? `${offset + 1}–${offset + chosen.length}` : "0";
  const tail = nextOffset !== undefined ? `\nMore: offset:${nextOffset} (same query/filters).` : "";
  const tooSmall = !chosen.length && blocks.length ? "\nmaxChars is too small for one result; increase it or request fewer/shorter snippets." : "";
  return { text: `${header}\nShowing ${range} of ${total}.\n\n${chosen.join("\n\n")}${tail}${tooSmall}\n\n${footer}`.trimEnd(), shown: chosen.length, nextOffset };
}

export function formatSearchPage(page: SearchPage, options: Omit<FormatOptions, "query"> = {}): FormattedPage {
  const hasQuery = Boolean(page.options.query?.trim() || page.options.anyOf?.length);
  const header = `${hasQuery ? "Lexical search" : "Session listing"} (${page.options.sort ?? (hasQuery ? "relevance" : "recent")}):\n${describeScope(page.options)}`;
  const footer = 'Read evidence with session_read(path, around:<entry>, context:2); default view is conversation text. view:"full" includes tools/thinking; view:"summary" reads cached topic summaries. Generated summaries are navigation aids, not source evidence.';
  if (!page.total) return { text: `${clipBlock(header, (options.maxChars ?? 16_000) - 500)}\n${hasQuery ? "No keyword matches in this scope. This does NOT establish that the topic was never discussed. Try alternatives, fewer terms, broader filters, or browse projects/sessions." : "No pi sessions found in this scope."}`, shown: 0 };
  return pagedBlocks(header, page.hits.map((hit, i) => formatHit(hit, page.offset + i + 1, options)),
    page.total, page.offset, options.maxChars ?? 16_000, footer);
}

/** Kept for standalone callers; new tool uses the counted/paginated page. */
export function formatHits(hits: SearchHit[], options: FormatOptions): string {
  return formatSearchPage({ hits, total: hits.length, offset: 0, options: { query: options.query } }, options).text;
}

export function formatProjectPage(page: ProjectPage, maxChars = 16_000): FormattedPage {
  return pagedBlocks(`Projects (most matching sessions first):\n${describeScope(page.options)}`,
    page.projects.map((p) => `${p.cwd}\n  ${p.sessions} sessions · ${p.messages} msgs · ${formatDate(p.createdAt)} … ${formatDate(p.activityAt)}`),
    page.total, page.offset, maxChars, 'Narrow with session_search(project:"<exact cwd>"); projectScope:"tree" includes child directories.');
}

export interface PageOptions extends ViewOptions { offset?: number; limit?: number; maxChars?: number; match?: "all" | "any" }
export interface ReadOptions extends ViewOptions { maxChars?: number; offsetChars?: number }
function viewDescription(options: ViewOptions): string {
  return `View: ${options.view ?? "full"}${options.roles?.length ? `; roles=${options.roles.join(",")}` : ""}. Original #indices; all branches in file order (adjacency does not imply ancestry).`;
}
function sessionHeader(session: LoadedSession, options: ViewOptions): string {
  return `Session: ${sessionTitle(session)}\nFile: ${prettyPath(session.path)} (${session.fileSize} bytes, ${session.entries.length} entries, ${session.messageCount} messages)\nProject: ${prettyPath(session.cwd)}\nCreated: ${formatDate(session.createdAt)}\n${viewDescription(options)}`;
}
function outlineLine(entry: ReadEntry): string {
  const counts = new Map<string, number>();
  for (const name of entry.toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const tools = [...counts].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(", ");
  return ` #${entry.index} ${entry.kind} · ${formatSize(entry.text.length)}${tools ? ` [${tools}]` : ""} · ${entry.preview}`;
}

export function formatOverview(session: LoadedSession, options: PageOptions = {}): string {
  const entries = visibleEntries(session, options);
  const offset = Math.max(0, options.offset ?? 0);
  const page = entries.slice(offset, offset + (options.limit ?? OUTLINE_LIMIT));
  const heading = page.length ? `\nEntries #${page[0]!.index}-#${page.at(-1)!.index} of ${session.entries.length} (${entries.length} visible):` : "\nNo entries at this offset (possibly past the end or filtered out).";
  return pagedBlocks(sessionHeader(session, options) + heading, page.map(outlineLine), entries.length, offset,
    options.maxChars ?? READ_BUDGET, 'Read with entries:"40-45", around:42, or search with query:"…". Offset counts visible entries, not #indices.').text;
}

export function formatEntriesRead(session: LoadedSession, indices: number[], options: ReadOptions = {}): string {
  const budget = Math.max(1000, options.maxChars ?? READ_BUDGET);
  const offset = Math.max(0, options.offsetChars ?? 0);
  if (offset && indices.length !== 1) throw new Error("offsetChars only applies when reading a single entry.");
  const byIndex = new Map(visibleEntries(session, options).map((entry) => [entry.index, entry]));
  const selected = indices.map((i) => byIndex.get(i)).filter((e): e is ReadEntry => Boolean(e));
  const lines = [clipBlock(sessionHeader(session, options), Math.floor(budget / 2))];
  let used = lines[0]!.length;
  if (!selected.length) return lines[0] + '\nNo selected entries are visible. Use view:"full" to inspect hidden entries.';
  for (const [position, entry] of selected.entries()) {
    const header = `\n--- #${entry.index} ${entry.kind} · ${formatDateTime(entry.timestampMs)} · ${entry.text.length}ch · id=${entry.id || "?"} parent=${entry.parentId ?? "none"} ---\n`;
    const body = entry.text.slice(offset);
    // Reserve space for complete, non-ambiguous continuation instructions.
    let room = budget - used - header.length - 380;
    const byteRoom = 45_000 - Buffer.byteLength(lines.join("\n") + header) - 1200;
    if (Buffer.byteLength(body.slice(0, Math.max(0, room))) > byteRoom) {
      let lo = 0, hi = Math.min(body.length, Math.max(0, room));
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(body.slice(0, mid)) <= byteRoom) lo = mid; else hi = mid - 1;
      }
      room = lo;
    }
    const lineRoom = Math.max(0, 1800 - (lines.join("\n") + header).split("\n").length - 6);
    if (lineRoom === 0) room = 0;
    let newline = -1;
    for (let n = 0; n <= lineRoom; n++) {
      newline = body.indexOf("\n", newline + 1);
      if (newline < 0 || newline >= room) break;
      if (n === lineRoom) room = newline;
    }
    if (room < 1) {
      lines.push(`\n[size budget reached — continue with entries:"${entry.index}-${indices.at(-1)}" and the same view/roles]`);
      break;
    }
    lines.push(header);
    used += header.length + 1;
    if (body.length > room) {
      lines.push(body.slice(0, room));
      lines.push(`[truncated: showing chars ${offset}-${offset + room} of ${entry.text.length} — continue with entries:"${entry.index}", offsetChars:${offset + room} and the same view/roles]`);
      if (position + 1 < selected.length) lines.push(`[then read remaining entries:"${selected[position + 1]!.index}-${indices.at(-1)}" with offsetChars:0]`);
      break;
    }
    lines.push(body || "(empty)");
    used += body.length + 1;
    if (offset >= entry.text.length) lines.push("[offsetChars is at/past the end of this entry]");
  }
  return lines.join("\n");
}

export function formatSessionMatches(session: LoadedSession, query: string, options: PageOptions = {}): string {
  const entries = visibleEntries(session, options);
  const tokens = extractTokens(query);
  const needles = tokens.map((t) => t.toLowerCase());
  const matches = needles.length ? entries.filter((entry) => {
    const haystack = entry.text.toLowerCase();
    return options.match === "any" ? needles.some((n) => haystack.includes(n)) : needles.every((n) => haystack.includes(n));
  }) : [];
  const header = `${sessionHeader(session, options)}\n${matches.length} of ${entries.length} visible entries match ${JSON.stringify(query)} (case-insensitive substring, ${options.match ?? "all"} terms; no stemming).`;
  if (!matches.length) return clipBlock(header, (options.maxChars ?? READ_BUDGET) - 100) + "\nNo entries match in this view. Try alternatives or a broader view.";
  const offset = Math.max(0, options.offset ?? 0);
  return pagedBlocks(header, matches.slice(offset, offset + (options.limit ?? FIND_LIMIT)).map((entry) =>
    ` #${entry.index} ${entry.kind} · ${formatDateTime(entry.timestampMs)}\n    ${plainSnippet(makeSnippet(entry.text, tokens))}`),
  matches.length, offset, options.maxChars ?? READ_BUDGET, 'Read a match with around:<index>, context:2 or entries:"<index>".').text;
}

function tokens(n: number): string { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`; }
function dollars(n: number): string { return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`; }
function range(pair: [number, number], unit: (n: number) => string): string { return Math.abs(pair[1] - pair[0]) < 1e-9 ? unit(pair[0]) : `${unit(pair[0])}–${unit(pair[1])}`; }
function fit(text: string, maxChars: number): string { return text.length > maxChars ? text.slice(0, maxChars - 40) + "\n[output shortened for budget]" : text; }
function duration(ms: number): string { return ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`; }

export function formatEstimate(estimate: Estimate, concurrency: number): string {
  if (!estimate.calls) return "Nothing to generate: every section is cached.";
  const cost = estimate.cost ? `cost ${range(estimate.cost, dollars)}` : "cost unknown (no registry price)";
  if (estimate.calibrated) {
    const s = estimate.stats!;
    return `Estimate (calibrated from ${s.calls} logged calls, ${(s.failureRate * 100).toFixed(0)}% failed, ~${Math.round(s.meanOutputTokens)} output tokens/call): ` +
      `input ${tokens(estimate.inputTokens[0])}, output ${tokens(estimate.outputTokens[0])} tokens, ${cost}` +
      (estimate.wallMs ? `, ~${duration(estimate.wallMs)} at concurrency ${concurrency}` : "") + ". Failure retries included.";
  }
  return `Estimate (ROUGH, uncalibrated): input ${range(estimate.inputTokens, tokens)}, output ${range(estimate.outputTokens, tokens)} tokens, ${cost}. ` +
    "Output tokens dominate the uncertainty; action:\"calibrate\" measures them on a small sample.";
}

export function formatStats(s: CallStats): string {
  return `Measured over ${s.calls} logged calls: ${(s.failureRate * 100).toFixed(0)}% failed, ${(1 / s.tokensPerChar).toFixed(2)} input chars/token, ` +
    `~${Math.round(s.meanOutputTokens)} output tokens/call, ~${dollars(s.meanCost)}/call, ~${duration(s.meanDurationMs)}/call.`;
}

export interface PlanModelView {
  key: string; sections: number; cached: number; remaining: number;
  completeSessions: number; publishedSessions: number; largestSession: number; estimate: Estimate;
}
export function formatSummaryPlan(view: { scope: string; sessions: number; models: PlanModelView[]; maxSections: number; maxCost?: number; concurrency: number }, maxChars = 16_000): string {
  const blocks = view.models.map((m) =>
    `Model ${m.key}: ${m.sections} sections; ${m.cached} cached; ${m.remaining} need generation (${tokens(m.estimate.inputChars)} input chars incl. instructions).\n` +
    `  Sessions complete: ${m.completeSessions}/${view.sessions}; published with this model: ${m.publishedSessions}. Largest uncached session: ${m.largestSession} sections.\n` +
    `  ${formatEstimate(m.estimate, view.concurrency)}`);
  const head = `Summary plan (no model calls yet)\nScope: ${view.scope}`;
  const remaining = Math.max(0, ...view.models.map((m) => m.remaining));
  const foot = `Generation sends historical user/assistant text to the named provider and incurs usage. No sampling, tools, thinking, or images.\n` +
    `Model keys include the reasoning level; each key has its own cache.\n` +
    (remaining > view.maxSections ? `maxSections:${view.maxSections} covers ${view.maxSections} of ${remaining} calls per invocation; raise it (with maxCost) or repeat to resume.\n` : "") +
    `Only if requested: session_summarize(action:"calibrate" | "generate", same scope, model, maxSections, maxCost${view.maxCost ? `:${view.maxCost}` : ""}, concurrency:${view.concurrency}).`;
  return fit([head, ...blocks, foot].join("\n\n"), maxChars);
}

function failureLines(result: RunResult, limit = 8): string {
  if (!result.failed.length) return "";
  const lines = result.failed.slice(0, limit).map((f) => `- ${prettyPath(f.path)} #${f.startIndex}–#${f.endIndex}: ${clamp(f.error, 240)}`);
  return `Failures (${result.failed.length}${result.failed.length > limit ? `, first ${limit}` : ""}; billed attempts are not cached, rerun to retry):\n${lines.join("\n")}\n`;
}

export function formatRunResult(result: RunResult, options: { running?: boolean; busySkipped?: number; remaining?: PlanModelView; concurrency?: number } = {}): string {
  const status = options.running ? "running" : result.stopped ? "stopped" : result.remaining ? "incomplete" : "complete";
  return `Summary generation ${status} · ${result.model}\n` +
    `${result.sessions} sessions · ${result.sections} sections: ${result.generated} generated, ${result.cached} previously cached, ${result.failed.length} failures, ${result.remaining} remaining.\n` +
    `Calls: ${result.calls}. Usage: ${tokens(result.usage.input + result.usage.cacheRead + result.usage.cacheWrite)} input + ${tokens(result.usage.output)} output tokens; reported cost ${dollars(result.usage.cost.total)}.\n` +
    (options.running ? "" : `Published ${result.published} sessions this run; ${result.completeSessions}/${result.sessions} sessions complete.\n`) +
    (result.stopped ? `Stopped: ${clamp(result.stopped, 400)}\n` : "") +
    (options.busySkipped ? `${options.busySkipped} sessions skipped: another generation is running for them.\n` : "") +
    failureLines(result) +
    (options.remaining && options.remaining.remaining ? `Remaining work: ${formatEstimate(options.remaining.estimate, options.concurrency ?? 1)}\n` : "") +
    (options.running ? "" : result.remaining
      ? "Repeat the same call to resume; cached sections are free. Incomplete sessions are not published to search."
      : 'Published sessions are available in session_search and session_read(view:"summary"). Verify claims against source entries.');
}

export interface CalibrationRow { model: SummaryModel; result: RunResult; sample: { plan: SummaryPlan; section: SummarySection }[]; plan: PlanModelView }

export function formatCalibration(view: { scope: string; rows: CalibrationRow[]; db: DatabaseSync; busySkipped?: number; concurrency: number }, maxChars = 16_000): string {
  const head = `Summary calibration · scope: ${view.scope}\n` +
    `Sample: ${view.rows[0]?.sample.length ?? 0} sections per model, spread across the section-size distribution (same sections for every model with the same section budget). ` +
    "Sections are cached for later generation; nothing is published.";
  const models = view.rows.map(({ model, result, plan }) => {
    const done = result.generated + result.failed.length;
    return `${model.key} (reasoning ${model.reasoning}, max ${model.maxTokens} output tokens): ${result.generated} ok, ${result.failed.length} failed, ${result.cached} already cached; ` +
      `${done ? `this run ${tokens(result.usage.output / done)} output tokens/call, ${dollars(result.usage.cost.total)} total` : "no new calls"}.` +
      (result.stopped ? ` Stopped: ${clamp(result.stopped, 200)}` : "") +
      (plan.estimate.stats ? `\n  ${formatStats(plan.estimate.stats)}` : "") +
      `\n  Full scope (${plan.remaining} uncached sections): ${formatEstimate(plan.estimate, view.concurrency)}` +
      (result.failed.length ? `\n  ${failureLines(result, 3).trim().replace(/\n/g, "\n  ")}` : "");
  });
  const first = view.rows[0]?.sample ?? [];
  const comparisons = first.map(({ plan, section }, i) => {
    const lines = [`Sample ${i + 1}: ${prettyPath(plan.path)} #${section.startIndex}–#${section.endIndex} (${formatSize(section.input.length)})`];
    for (const row of view.rows) {
      const match = row.sample.find((s) => s.plan.path === plan.path && s.section.startIndex === section.startIndex);
      const cached = match ? cachedSection(view.db, plan.path, match.section.hash, row.model.key) : undefined;
      const failure = row.result.failed.find((f) => f.path === plan.path && f.startIndex === section.startIndex);
      lines.push(cached
        ? `  [${row.model.key}] ${clamp(cached.summary.overview, 300)}\n    topics (${cached.summary.topics.length}): ${cached.summary.topics.map((t) => clamp(t.title, 70)).join(" | ")}`
        : `  [${row.model.key}] ${failure ? `failed: ${clamp(failure.error, 160)}` : "not generated"}`);
    }
    return lines.join("\n");
  });
  const foot = "Compare coverage/precision of topics above; overviews and titles are clamped. Estimates use all logged calls for each model key and current registry prices." +
    (view.busySkipped ? ` ${view.busySkipped} sessions skipped (generation already running).` : "");
  let text = [head, ...models].join("\n\n");
  let shown = 0;
  for (const block of comparisons) {
    if (text.length + block.length + foot.length + 200 > maxChars) break;
    text += "\n\n" + block; shown++;
  }
  if (shown < comparisons.length) text += `\n\n[${comparisons.length - shown} sample comparisons omitted for the output budget; raise maxChars (max 40000).]`;
  return fit(text + "\n\n" + foot, maxChars);
}

export function formatSummary(record: SummaryRecord, path: string, options: PageOptions = {}): string {
  const header = `Generated summary: ${record.status}\nFile: ${prettyPath(path)}\n${record.model ? `Model: ${record.model} · version ${record.version} · published ${formatDateTime(record.generatedAt ?? null)}\n` : ""}Navigation aid only. Verify claims in original entries. Covers user/assistant text across all branches; excludes tools, thinking, images, and compaction summaries.`;
  if (record.status !== "ready") return `${header}\n${record.status === "stale" ? "Source changed or summary version is outdated. Stale summaries are excluded from search; old entry references are not shown." : "No complete summary is available."}\nUse session_summarize(action:"plan", path) to inspect work remaining; generating summaries requires an explicit request.`;
  const offset = options.offset ?? 0;
  // Page individual overviews/topics, not whole sections: even a maximal model
  // response must remain readable without requiring a larger output budget.
  const items = record.sections.flatMap((section, i) => [
    `Section ${i + 1} overview · source #${section.startIndex}–#${section.endIndex}\n${clamp(section.summary.overview, 1200)}\n` +
      `Coverage: ${section.spans.map((span) => `#${span.index}[${span.startChar}:${span.endChar}]`).join(" ")}`,
    ...section.summary.topics.map((topic) => `Section ${i + 1} topic: ${clamp(topic.title, 160)} [#${topic.entries.join(",#")}]\n${clamp(topic.summary, 1800)}\nTerms: ${topic.keywords.map((term) => clamp(term, 100)).join(", ")}`),
  ]);
  return pagedBlocks(header, items.slice(offset, offset + (options.limit ?? 20)), items.length,
    offset, options.maxChars ?? READ_BUDGET, "Offset/limit count overview/topic items. No source text was sampled. Coverage offsets are UTF-16 characters in conversation-only text; a source entry can span multiple sections.").text;
}
