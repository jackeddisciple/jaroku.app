// What the Results half says about an eval: the verdict, the case facets, the criteria, the time.
//
//   npm run test:eval-view

import type { EvalResults, ExampleCell, ExampleRow, ProviderMetrics } from "../types.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const { verdict, leaders, facetCounts, rowIs, rowDisagrees, cellFailed, criterionTable, criterionLabel, evalDuration } =
  await import("./evalView.ts");

const leg = (over: Partial<ProviderMetrics> = {}): ProviderMetrics => ({
  provider: "anthropic", model: "claude-haiku-4-5", total: 6, succeeded: 6, failed: 0, cancelled: 0, pending: 0, successRate: 1,
  comparisonCostUsd: 0.0114, costPerRunUsd: 0.0019, spentUsd: 0.0116, tokens: 9000, latencyP50Ms: 1200, latencyP95Ms: 1500,
  costUnknown: false, costIncomplete: false, qualityScore: 0.69, scored: 6, unscored: 0, ...over,
});
const cell = (over: Partial<ExampleCell> = {}): ExampleCell => ({
  jobId: Math.random().toString(36), provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r",
  costUsd: 0.002, costComplete: true, latencyMs: 1200, attempt: 0, error: null, output: "4 words.", matches: null,
  score: 0.7, scoreError: null, perCriterion: null, rationale: null, ...over,
});
const row = (cells: ExampleCell[], exampleId = Math.random().toString(36)): ExampleRow => ({ exampleId, input: "How many words?", expected: null, cells });
const names: Record<string, string> = { "claude-haiku-4-5": "Haiku 4.5", "claude-sonnet-5": "Sonnet 5", "claude-opus-5": "Opus 5" };
const name = (m: string): string => names[m] ?? m;
const haiku = leg();
const sonnet = leg({ model: "claude-sonnet-5", qualityScore: 0.74, costPerRunUsd: 0.0044, comparisonCostUsd: 0.0264, latencyP50Ms: 1900 });

console.log("\nthe verdict says who leads, on what and by how much");
{
  const v = verdict([haiku, sonnet], name);
  check(v === "Sonnet 5 leads quality (74 vs 69); Haiku 4.5 is 2.3× cheaper per run and fastest.", "two models, each leading on something", String(v));
  const one = leg({ model: "claude-opus-5", qualityScore: 0.71, costPerRunUsd: 0.011, latencyP50Ms: 2600 });
  const three = verdict([haiku, sonnet, one], name) ?? "";
  check(three.startsWith("Sonnet 5 leads quality (74 vs Opus 5 at 71)"), "with three, the runner-up is named", three);
  check(verdict([haiku], name) === null, "one model is not a comparison, so there is no verdict");
  const both = verdict([haiku, leg({ model: "claude-sonnet-5", qualityScore: 0.86, costPerRunUsd: 0.0009, latencyP50Ms: 800 })], name);
  check(both === "Sonnet 5 leads quality (86 vs 69), and is 2.1× cheaper per run and fastest.", "one model leading everything is one clause", String(both));
}

console.log("\n...and makes no claim it cannot make honestly");
{
  const tie = verdict([haiku, leg({ model: "claude-sonnet-5", qualityScore: 0.694, costPerRunUsd: 0.0019, latencyP50Ms: 1250 })], name);
  check(tie === "Haiku 4.5 and Sonnet 5 tie on quality at 69.", "a tie is a tie, and near-equal cost and speed say nothing", String(tie));
  const unpriced = verdict([haiku, leg({ model: "claude-sonnet-5", costUnknown: true, costPerRunUsd: null })], name) ?? "";
  check(!/cheaper/.test(unpriced), "an unpriced model could be the cheap one, so cost is not claimed", unpriced);
  const floor = verdict([haiku, leg({ model: "claude-sonnet-5", costIncomplete: true, costPerRunUsd: 0.0044 })], name) ?? "";
  check(!/cheaper/.test(floor), "nor when a cost is only a floor", floor);
  const judgeOff = verdict([leg({ qualityScore: null }), leg({ model: "claude-sonnet-5", qualityScore: null, costPerRunUsd: 0.0044, latencyP50Ms: 1900 })], name);
  check(judgeOff === "Haiku 4.5 is 2.3× cheaper per run and fastest.", "with the judge off there is no quality claim, and the rest stands", String(judgeOff));
  const broken = verdict([haiku, leg({ model: "claude-sonnet-5", succeeded: 0, failed: 6, qualityScore: null, costPerRunUsd: null, latencyP50Ms: null })], name);
  check(broken === null, "a model that answered nothing is in no comparison", String(broken));
  check(leaders([haiku, sonnet]).best === "claude-sonnet-5" && leaders([haiku, sonnet]).cheapest === "claude-haiku-4-5", "the table's lead marks agree with the sentence");
}

console.log("\nthe cases can be narrowed to the ones that matter");
{
  const sonnetCell = (over: Partial<ExampleCell> = {}) => cell({ model: "claude-sonnet-5", ...over });
  const agree = row([cell({ score: 0.75 }), sonnetCell({ score: 0.8 })], "agree");
  const scoreGap = row([cell({ score: 0.4 }), sonnetCell({ score: 0.9 })], "gap");
  const oneFailed = row([cell({ status: "failed", score: null, error: "boom" }), sonnetCell()], "failed");
  const matchSplit = row([cell({ matches: true, score: null }), sonnetCell({ matches: false, score: null })], "split");
  const unscored = row([cell({ score: null }), sonnetCell({ score: 0.7 })], "unscored");
  const waiting = row([cell({ status: "queued", score: null }), sonnetCell({ status: "running", score: null })], "waiting");
  const rows = [agree, scoreGap, oneFailed, matchSplit, unscored, waiting];

  check(!rowDisagrees(agree), "two scores inside the judge's noise agree");
  check(rowDisagrees(scoreGap) && rowDisagrees(oneFailed) && rowDisagrees(matchSplit), "a score gap, a failure beside a success and a split match all disagree");
  check(!rowDisagrees(waiting), "work that has not run cannot disagree");
  check(cellFailed({ status: "timed_out" }) && !cellFailed({ status: "cancelled" }) && !cellFailed({ status: "queued" }), "a timeout is a failure; a cancelled or waiting cell is not");

  const counts = facetCounts(rows, new Set(["gap"]));
  check(counts.all === 6 && counts.failed === 1 && counts.disagree === 3 && counts.unscored === 2 && counts.changed === 1,
    "each facet counts its cases", JSON.stringify(counts));
  check(facetCounts(rows).changed === 0 && !rowIs(scoreGap, "changed"), "with nothing compared, nothing has changed");
}

console.log("\nthe criteria are read by their names, per model");
{
  const rubric = [
    { id: "correctness", label: "Correctness", description: "Does it answer the question?", weight: 0.5 },
    { id: "grounding", label: "Grounding", description: "Is every claim supported?", weight: 0.3 },
  ];
  const results = {
    rubric,
    providers: [haiku, sonnet],
    rows: [
      row([cell({ perCriterion: { correctness: 3, grounding: 4 } }), cell({ model: "claude-sonnet-5", perCriterion: { correctness: 4, grounding: 4, tone: 2 } })]),
      row([cell({ perCriterion: { correctness: 2, grounding: 3 } }), cell({ model: "claude-sonnet-5", perCriterion: null, score: null })]),
    ],
  } as unknown as EvalResults;
  const table = criterionTable(results);
  check(table.map((r) => r.label).join(",") === "Correctness,Grounding,tone", "in the rubric's order, under its labels, with an unnamed id kept", table.map((r) => r.label).join(","));
  const correctness = table[0]!;
  check(correctness.scores[0]!.avg === 2.5 && correctness.scores[0]!.n === 2, "each model's average is over its own scored answers", JSON.stringify(correctness.scores[0]));
  check(correctness.scores[1]!.avg === 4 && correctness.scores[1]!.n === 1, "and an unscored answer is left out, not counted as zero", JSON.stringify(correctness.scores[1]));
  check(table[2]!.scores[0]!.avg === null, "a model with no score on a criterion has none, not 0");
  check(criterionLabel(results, "grounding") === "Grounding" && criterionLabel(results, "tone") === "tone", "a label where the rubric has one, the id where it does not");
  check(criterionTable({ ...results, rows: [row([cell()])] }).length === 0, "and nothing to break down when nothing was scored");
}

console.log("\nan eval says how long it took");
{
  check(evalDuration({ startedAt: "2026-10-29T04:33:57.000Z", endedAt: "2026-10-29T04:34:17.400Z" }) === "20.4s", "start to finish");
  check(evalDuration({ startedAt: "2026-10-29T04:33:57.000Z", endedAt: null }) === null, "and nothing while it runs");
}

console.log("\nthe two eval views share one width hook");
{
  const { readFileSync } = await import("node:fs");
  for (const file of ["EvalDashboard.tsx", "EvalCompare.tsx"]) {
    const source = readFileSync(`src/components/${file}`, "utf8");
    check(source.includes("useNarrowerThan") && !source.includes("new ResizeObserver"), `${file} measures itself through useNarrowerThan`);
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
