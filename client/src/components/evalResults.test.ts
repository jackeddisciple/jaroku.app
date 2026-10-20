// The Results view of the Evals tab, rendered: what it says about the eval it is showing.
//
// A structural test, through `testRender`: the stores seeded, the component rendered to markup, and
// the markup read for what a person would read. Each section is a sentence the panel used to leave
// out, or got wrong.
//
//   npm run test:eval-results

import { createElement } from "react";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const kept = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => void kept.set(k, v),
  removeItem: (k: string) => void kept.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { markup, seed } = await import("../lib/testRender.ts");
const { useBuildStore } = await import("../store/buildStore.ts");
const { ResultsHeader } = await import("./EvalsPanel.tsx");
type Results = import("../types.ts").EvalResults;

/** Tags gone and whitespace folded, so a check reads the words a person reads. */
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const results = (over: Partial<Results> = {}): Results => ({
  evalId: "e1",
  datasetId: "d1",
  datasetName: "Screening cases",
  agentId: "liven",
  agentVersion: 3,
  status: "aborted_over_budget",
  stopReason: "stopped after $0.0048 of a $0.0010 budget",
  targets: [{ provider: "anthropic", model: "claude-sonnet-5" }, { provider: "anthropic", model: "claude-haiku-4-5" }],
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: null,
  providers: [],
  totals: { trueSpendUsd: 0.0048, judgeCostUsd: 0, agentSpendUsd: 0.0048, budgetUsd: 0.001 },
  rows: [],
  ...over,
});

seed(useBuildStore, { agents: [{ agent_id: "liven", name: "Liven" }] } as never);

console.log("\nthe header says whose eval this is, and how it ended");
{
  const words = text(markup(createElement(ResultsHeader, { results: results(), live: null })));
  check(words.includes("Liven"), "it names the agent", words);
  check(words.includes("Screening cases"), "and the dataset", words);
  check(words.includes("v3"), "and the agent version it ran against", words);
  check(words.includes("over budget"), "it says the eval stopped over budget, even as the only eval", words);
  check(words.includes("stopped after $0.0048 of a $0.0010 budget"), "and why, in the server's words", words);
  check(words.indexOf("claude-sonnet-5") < words.indexOf("claude-haiku-4-5"), "the models are in the order they were chosen", words);
}

console.log("\na running eval says it is running, and gives no stop reason");
{
  const live = { evalId: "e1", total: 12, done: 2, running: 2, queued: 8, failed: 0 };
  const words = text(markup(createElement(ResultsHeader, { results: results({ status: "running", stopReason: null }), live })));
  check(words.includes("running"), "it reads running", words);
  check(!words.includes("stopped after"), "and has no reason to stop", words);
}

console.log("\na cell says what the agent answered, beside what was expected");
{
  const { CellDetail } = await import("./EvalDrillDown.tsx");
  const cell = {
    jobId: "j1", provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r1", costUsd: 0.001,
    costComplete: true, latencyMs: 900, attempt: 0, error: null, output: "decline — no QA experience",
    score: null, scoreError: null, perCriterion: null, rationale: null,
  };
  const words = text(markup(createElement(CellDetail, { cell, expected: "decline", criteria: [], onStep: () => {} })));
  check(words.includes("Answer") && words.includes("decline — no QA experience"), "it shows the answer", words);
  check(words.includes("Expected") && words.includes("decline"), "and the expected output beside it", words);
}

console.log("\na cell that did not succeed says which of five things happened");
{
  const { cellLook } = await import("./EvalDrillDown.tsx");
  const words = ["queued", "running", "cancelled", "timed_out", "failed"].map((s) => cellLook(s)?.label);
  check(new Set(words).size === 5, `five words, not one (${words.join(", ")})`);
  check(!/err/.test(cellLook("queued")!.tone) && !/err/.test(cellLook("cancelled")!.tone) && !/err/.test(cellLook("running")!.tone),
    "waiting, running and cancelled are not red");
  check(/err/.test(cellLook("failed")!.tone) && /err/.test(cellLook("timed_out")!.tone), "failing is");
  check(cellLook("cancelled")!.struck === true, "and a cancelled cell is struck through");
  check(cellLook("succeeded") === null, "a succeeded cell shows its score instead");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
