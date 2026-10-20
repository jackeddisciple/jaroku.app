// Two evals lined up: what changed between them, and what makes them not like for like.
//
//   npm run test:eval-compare

import type { EvalResults, ExampleCell, ProviderMetrics } from "../types.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
g["localStorage"] = { getItem: () => null, setItem() {}, removeItem() {} };
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { compareEvals } = await import("./evalCompare.ts");

const leg = (over: Partial<ProviderMetrics> = {}): ProviderMetrics => ({
  provider: "anthropic", model: "claude-haiku-4-5", total: 3, succeeded: 3, failed: 0, cancelled: 0, pending: 0, successRate: 1,
  comparisonCostUsd: 0.003, costPerRunUsd: 0.001, spentUsd: 0.003, tokens: 30, latencyP50Ms: 900, latencyP95Ms: 1000,
  costUnknown: false, costIncomplete: false, qualityScore: 0.8, scored: 3, unscored: 0, checked: 3, matched: 3, ...over,
});
const cell = (over: Partial<ExampleCell> = {}): ExampleCell => ({
  jobId: Math.random().toString(36), provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r",
  costUsd: 0.001, costComplete: true, latencyMs: 900, attempt: 0, error: null, output: "decline", matches: true,
  score: 0.8, scoreError: null, perCriterion: null, rationale: null, ...over,
});
const evalOf = (over: Partial<EvalResults>): EvalResults => ({
  evalId: "e", datasetId: "d1", datasetName: "Screening cases", agentId: "liven", agentVersion: 3, status: "completed",
  startedAt: "2026-10-16T10:00:00.000Z", endedAt: null, providers: [leg()], checkMode: "word",
  totals: { trueSpendUsd: 0.003, judgeCostUsd: 0, agentSpendUsd: 0.003, budgetUsd: 1 }, rows: [], ...over,
});

console.log("\nwhat changed between two evals of one dataset");
{
  const before = evalOf({
    evalId: "old",
    rows: [
      { exampleId: "x1", input: "Role: QA", expected: "decline", cells: [cell()] },
      { exampleId: "x2", input: "Role: SRE", expected: "advance", cells: [cell({ status: "failed", matches: null, score: null })] },
      { exampleId: "x3", input: "Role: PM", expected: "advance", cells: [cell({ score: 0.9 })] },
    ],
  });
  const after = evalOf({
    evalId: "new", agentVersion: 4, startedAt: "2026-10-17T10:00:00.000Z",
    providers: [leg({ succeeded: 3, matched: 2, qualityScore: 0.6 }), leg({ model: "claude-sonnet-5" })],
    rows: [
      { exampleId: "x1", input: "Role: QA", expected: "decline", cells: [cell({ matches: false, output: "advance" }), cell({ model: "claude-sonnet-5" })] },
      { exampleId: "x2", input: "Role: SRE", expected: "advance", cells: [cell()] },
      { exampleId: "x3", input: "Role: PM", expected: "advance", cells: [cell({ score: 0.4 })] },
    ],
  });
  const diff = compareEvals(before, after);
  check(diff.caveats.some((c) => /v3 → v4/.test(c)), "it says the agent changed between them", diff.caveats.join(" | "));
  const haiku = diff.models.find((m) => m.model === "claude-haiku-4-5");
  check(haiku?.before?.matched === 3 && haiku.after?.matched === 2, "each model has its figures then and now");
  check(diff.models.some((m) => m.model === "claude-sonnet-5" && m.before === null), "a model only the newer eval compared is new, not diffed against nothing");
  const whats = diff.changes.map((c) => `${c.index}:${c.what}`);
  check(whats.includes("1:matched → did not match"), "a case that stopped matching is listed", whats.join(" | "));
  check(whats.includes("2:failed → succeeded"), "so is one that now runs", whats.join(" | "));
  check(whats.includes("3:score 90 → 40"), "and one whose score fell", whats.join(" | "));
  check(diff.changes[0]?.better === false && diff.changes.at(-1)?.better === true, "regressions first", whats.join(" | "));
}

console.log("\nthe comparison, rendered");
{
  const { createElement } = await import("react");
  const { markup } = await import("./testRender.ts");
  const { EvalCompare } = await import("../components/EvalCompare.tsx");
  const before = evalOf({ evalId: "old", rows: [{ exampleId: "x1", input: "Role: QA", expected: "decline", cells: [cell()] }] });
  const after = evalOf({ evalId: "new", rows: [{ exampleId: "x1", input: "Role: QA", expected: "decline", cells: [cell({ matches: false })] }] });
  const words = markup(createElement(EvalCompare, { before, after, onClose: () => {} })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(words.includes("What changed") && words.includes("matched → did not match") && words.includes("case 1"), "it lists the case that changed", words);
  const same = markup(createElement(EvalCompare, { before, after: before, onClose: () => {} })).replace(/<[^>]+>/g, " ");
  check(same.includes("No case changed its outcome"), "and says so when nothing did");
  // WHICH EVAL, not only when — two from the same afternoon both read "4d ago".
  check(/the eval .* on Screening cases/.test(words), "it names the dataset the earlier eval ran on", words.slice(0, 160));
  const gone = markup(createElement(EvalCompare, { before: { ...before, datasetId: "d-gone", datasetName: null }, after, onClose: () => {} }))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(gone.includes("on a deleted dataset") && gone.includes("a deleted dataset and Screening cases"),
    "and calls a deleted one that, in the header and the caveat", gone.slice(0, 260));

  // THE PICKED EVAL, even when it is the later one: it was announced as the eval already on screen.
  const later = { ...after, datasetId: "d-gone", datasetName: null };
  const picked = markup(createElement(EvalCompare, { before, after: later, against: later, onClose: () => {} })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(picked.includes("on a deleted dataset") && !/the eval [^·]*on Screening cases/.test(picked),
    "the header names the eval that was picked, not whichever is older", picked.slice(0, 160));

  // NARROW: the six columns were clipped — Per run cut in half, p50 off the edge.
  const { CompareCards } = await import("../components/EvalCompare.tsx");
  const cards = markup(createElement(CompareCards, { models: compareEvals(before, after).models })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check(["Quality", "Ran OK", "Matches", "Per run", "p50"].every((l) => cards.includes(l)) && cards.includes("claude-haiku-4-5"),
    "as cards, every figure of every model is there", cards.slice(0, 200));

  // THE STRIP AND THE PICKER name each past eval's dataset, so two from one afternoon differ.
  const { evalDatasetLabel } = await import("../components/EvalsPanel.tsx");
  const ds = [{ id: "d1", name: "Screening cases" }];
  check(evalDatasetLabel({ dataset_id: "d1", dataset_name: "Screening cases" }, ds) === "Screening cases", "a named eval reads its dataset");
  check(evalDatasetLabel({ dataset_id: "d1", dataset_name: null }, ds) === "Screening cases", "an eval from before names were kept reads the dataset's name now");
  check(evalDatasetLabel({ dataset_id: "gone", dataset_name: null, dataset_gone: true }, ds) === "a deleted dataset", "and one whose dataset is gone says so");
  check(evalDatasetLabel({ dataset_id: "gone", dataset_name: "Test set 2", dataset_gone: true }, ds) === "Test set 2 · deleted", "naming it when the name was kept");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
