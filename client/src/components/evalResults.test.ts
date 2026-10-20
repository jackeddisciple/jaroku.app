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
const text = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

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

console.log("\na case keeps its line breaks, and one response has nothing to step to");
{
  const { ExampleDrillDown, CellDetail } = await import("./EvalDrillDown.tsx");
  const cell = {
    jobId: "j1", provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r1", costUsd: 0.001,
    costComplete: true, latencyMs: 900, attempt: 0, error: null, output: "decline",
    score: null, scoreError: null, perCriterion: null, rationale: null,
  };
  const html = markup(createElement(ExampleDrillDown, {
    results: results({ rows: [{ exampleId: "x1", input: "Role: QA\n---\nCandidate: tests things", expected: "decline", cells: [cell] }] }),
  }));
  check(/whitespace-pre-wrap[^>]*>Role: QA\n---\nCandidate/.test(html), "the case's newlines reach the page and are kept", html.slice(0, 300));
  const one = markup(createElement(CellDetail, { cell, expected: null, criteria: [], onStep: () => {}, responses: 1 }));
  const tag = (label: string): string => (one.match(/<button[^>]*>/g) ?? []).find((b) => b.includes(label)) ?? "";
  check(/\sdisabled=""/.test(tag("Previous response")) && /\sdisabled=""/.test(tag("Next response")),
    "Prev and Next are disabled with one response", `${tag("Previous response")} ${tag("Next response")}`);
  const two = markup(createElement(CellDetail, { cell, expected: null, criteria: [], onStep: () => {}, responses: 2 }));
  const prev = (two.match(/<button[^>]*>/g) ?? []).find((b) => b.includes("Previous response")) ?? "";
  check(prev !== "" && !/\sdisabled=""/.test(prev), "and enabled with two", prev);
}

console.log("\nthe table compares only what can be compared");
{
  const { ComparisonTable } = await import("./EvalDashboard.tsx");
  const { fmtBudget } = await import("../lib/format.ts");
  const leg = (over: Partial<import("../types.ts").ProviderMetrics>): import("../types.ts").ProviderMetrics => ({
    provider: "anthropic", model: "m", total: 6, succeeded: 0, failed: 6, cancelled: 0, pending: 0, successRate: 0,
    comparisonCostUsd: 0, costPerRunUsd: null, spentUsd: 0.008, tokens: 0, latencyP50Ms: null, latencyP95Ms: null,
    costUnknown: false, costIncomplete: false, qualityScore: null, scored: 0, unscored: 0, ...over,
  });
  const sonnet = leg({ model: "claude-sonnet-5" });
  const haiku = leg({ model: "claude-haiku-4-5", total: 15, succeeded: 2, failed: 0, cancelled: 13, successRate: 1, comparisonCostUsd: 0.004, costPerRunUsd: 0.002, latencyP50Ms: 900 });
  const html = markup(createElement(ComparisonTable, { results: results({ providers: [sonnet, haiku] }) }));
  const words = text(html);
  check(!/\$0\.00\b/.test(words.split("claude-haiku-4-5")[0] ?? ""), "a model that went 0 of 6 shows no $0.00 cost", words);
  check(words.includes("Ran OK") && !words.includes("Passed"), "the column says what it counts — ran OK, not passed", words);
  check(words.includes("2/2") && words.includes("100%") && words.includes("13 cancelled"), "two of two that ran, with the thirteen cancelled said apart", words);
  check(words.includes("0/6") && words.includes("0%"), "and the percentage shows when nothing failed too", words);
  check(!/title="(cheapest per run|fastest)"/.test(html), "no lead mark where only one model has the figure", html.match(/title="[^"]*"/g)?.join(" ") ?? "");
  check(words.includes("of $0.001 budget"), "the budget reads as typed", words);
  check(fmtBudget(0.2) === "$0.20" && fmtBudget(0.05) === "$0.05" && fmtBudget(1.5) === "$1.50" && fmtBudget(0.001) === "$0.001",
    `a budget is $0.20, not $0.2000 (${fmtBudget(0.2)}, ${fmtBudget(0.001)})`);
}

console.log("\nwith the judge off, the panel says so and offers the switch");
{
  const { JudgeLine } = await import("./EvalsPanel.tsx");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { useSessionStore } = await import("../store/sessionStore.ts");
  const base = { enabled: false, source: null, ownKey: false, platformOptIn: false, keyPresent: true };
  const asRole = (role: string) => seed(useSessionStore, {
    status: "ready", workspaceId: "ws-a",
    workspaces: [{ id: "ws-a", slug: "a", name: "Alpha", kind: "team", role, plan: { id: "free", label: "Free" } }],
  } as never);
  asRole("owner");
  seed(useEvalStore, { judge: base } as never);
  let words = text(markup(createElement(JudgeLine)));
  check(words.includes("the judge is off") && words.includes("Judge with my Anthropic key"), "an owner is offered the switch", words);
  seed(useEvalStore, { judge: { ...base, keyPresent: false } } as never);
  words = text(markup(createElement(JudgeLine)));
  check(words.includes("Add an Anthropic key in Secrets"), "with no key, it leads to Secrets instead", words);
  asRole("member");
  seed(useEvalStore, { judge: base } as never);
  words = text(markup(createElement(JudgeLine)));
  check(!words.includes("Judge with my Anthropic key") && words.includes("An admin can turn on judging"), "a member is told who can", words);
  asRole("owner");
  seed(useEvalStore, { judge: { ...base, enabled: true, source: "own-key", ownKey: true } } as never);
  words = text(markup(createElement(JudgeLine)));
  check(words.includes("judged on this workspace's Anthropic key") && words.includes("Turn off"), "once on, it says whose key and can be turned off", words);
  seed(useEvalStore, { judge: { ...base, enabled: true, source: "platform" } } as never);
  check(text(markup(createElement(JudgeLine))) === "", "and with the platform's judge it says nothing");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
