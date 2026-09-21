# Retrieval evaluation

`npm test` checks deterministic retrieval, filtering, coverage, provenance,
budgets, and provider integration using synthetic data. It does **not** prove
that an agent finds more accurate answers than vector retrieval.

## Compare three configurations

1. **Baseline:** v0.2 keyword search + full-content reader.
2. **Scoped lexical tools:** v0.3, no generated summaries.
3. **Scoped tools + summaries:** v0.3, summaries pre-generated explicitly.

Use an isolated session corpus/index per configuration (`PI_CODING_AGENT_DIR`).
Don't run old and new extension versions against the same database. Pin the
frontier model, prompts, query budget, and corpus snapshot. Exclude the search
session and previous evaluation answers from the corpus. Repeat runs to expose
agent variability. Charge summary generation separately and amortize it over a
stated number of searches; don't hide its up-front cost.

## Build a small, checked question set

For each question, record expected session files and entry indices, whether a
supporting discussion actually exists, and what an acceptable answer must
preserve. Use original source text as ground truth, not generated summaries.
Include:

- Known keyword/identifier, with and without a project hint.
- Paraphrase with no literal query wording in the source.
- A brief side discussion in a long session.
- A discussion about a project held in a different working directory.
- A recent exchange in a session created months earlier.
- A proposal that was rejected, or an assistant suggestion never accepted.
- A fact available only in tool output (`view:full` is required).
- A branched/forked conversation with conflicting outcomes.
- A question whose best evidence is beyond the old 16K index cutoff.
- A negative question with no support in the corpus.

The synthetic `test/search.ts`, `test/reader.ts`, and `test/summaries.ts`
fixtures cover several of these mechanically. Add independently worded questions
and checked source references before running the actual frontier-model eval.

## Record per run

- Question and configuration/model/version.
- Retrieved and finally cited source entries; correct evidence found or missed.
- Final answer correctness, attribution, and distinction between proposal,
  decision, claimed implementation, and verified implementation.
- False positives and unsupported certainty on negative questions.
- Tool calls, returned characters/bytes, model tokens/cost, and elapsed time.
- Summary model/version, cache state, and one-time generation cost.

Score evidence recall and answer quality separately. A fast plausible answer
without the right evidence is a failure; an honest qualified negative is not
proof of exhaustive absence. Review failures before adding more retrieval
infrastructure. If lexical tools + summaries repeatedly miss relevant evidence,
add a simple vector/hybrid candidate generator as another **controlled eval
configuration**, rather than assuming it is better or worse.

## Real-corpus performance smoke

`node test/smoke.ts [query]` builds a temporary index, probes incremental sync,
prints a few hits, and measures both common prefix searches and scoped
alternatives. It makes no model calls and doesn't modify the real index.
A live session may change during the second sync; that isn't a no-op failure.
