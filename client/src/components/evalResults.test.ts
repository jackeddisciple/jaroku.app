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
  const { unscoredLook } = await import("./EvalDrillDown.tsx");
  // With the judge off every ran cell is unscored, and "—" beside "cancelled" read as nothing having run.
  check(unscoredLook({ matches: null }).label === "ran", "and with no score, that it ran — not a dash");
  check(unscoredLook({ matches: true }).label === "match" && /ok/.test(unscoredLook({ matches: true }).tone)
    && unscoredLook({ matches: false }).label === "no match" && /err/.test(unscoredLook({ matches: false }).tone),
    "or, when answers are checked, whether it matched");
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

console.log("\nan eval's trace leads back to the eval, and the cell is still open there");
{
  const { TraceHeader } = await import("./TraceHeader.tsx");
  const { useTraceStore } = await import("../store/traceStore.ts");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { useUiStore } = await import("../store/uiStore.ts");
  const { openEvalResults } = await import("../lib/evalNav.ts");
  const run = { id: "run-1", agent_id: "liven", status: "completed", started_at: new Date().toISOString() } as never;
  seed(useTraceStore, {
    evalByRun: { "run-1": { eval_id: "e1", judged: false, agent_id: "liven", dataset_name: "Screening cases", score: null, criteria: [], scale_max: 4, rationale: null, error: null } },
  } as never);
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const words = text(markup(createElement(TooltipProvider, null, createElement(TraceHeader, { run }))));
  check(words.includes("eval · Screening cases"), "the trace says its run is an eval's, and on which dataset", words);
  useEvalStore.getState().setOpenCell("e1", "job-7");
  useEvalStore.getState().setMode("liven", "dataset");
  openEvalResults("liven", "e1");
  const st = useEvalStore.getState();
  check(useUiStore.getState().rightTab === "evals", "the way back opens the Evals tab");
  check(st.modeByAgent["liven"] === "results" && st.selectedEvalByAgent["liven"] === "e1", "on that eval's Results");
  check(st.openCellByEval["e1"] === "job-7", "with the cell that was open still open");
}

console.log("\nanswers checked against expected are counted, and each cell says how it did");
{
  const { ComparisonTable } = await import("./EvalDashboard.tsx");
  const { CellDetail } = await import("./EvalDrillDown.tsx");
  const { resultsToCsv } = await import("../lib/evalExport.ts");
  const { parseCsv } = await import("../lib/csv.ts");
  const p = {
    provider: "anthropic", model: "claude-haiku-4-5", total: 2, succeeded: 2, failed: 0, cancelled: 0, pending: 0, successRate: 1,
    comparisonCostUsd: 0.002, costPerRunUsd: 0.001, spentUsd: 0.002, tokens: 10, latencyP50Ms: 900, latencyP95Ms: 900,
    costUnknown: false, costIncomplete: false, qualityScore: null, scored: 0, unscored: 2, checked: 2, matched: 1,
  };
  const words = text(markup(createElement(ComparisonTable, { results: results({ providers: [p], checkMode: "word" }) })));
  check(words.includes("Matches") && words.includes("1/2") && words.includes("50%"), "the table has a Matches column when answers were checked", words);
  const plain = text(markup(createElement(ComparisonTable, { results: results({ providers: [{ ...p, checked: 0, matched: 0 }] }) })));
  check(!plain.includes("Matches"), "and none when they were not", plain);
  const cell = {
    jobId: "j1", provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r1", costUsd: 0.001,
    costComplete: true, latencyMs: 900, attempt: 0, error: null, output: "Advance", matches: false,
    score: null, scoreError: null, perCriterion: null, rationale: null,
  };
  check(text(markup(createElement(CellDetail, { cell, expected: "decline", criteria: [], onStep: () => {} }))).includes("does not match"), "a cell says it did not match");
  const csv = parseCsv(resultsToCsv(results({ rows: [{ exampleId: "x1", input: "a", expected: "decline", cells: [cell] }] }))).rows;
  check(csv[1]![csv[0]!.indexOf("matches_expected")] === "no", "and the export says so too");
}

console.log("\na finished eval can retry its unfinished cells, or run again");
{
  const { EvalActions } = await import("./EvalsPanel.tsx");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const cell = (status: string) => ({
    jobId: `j-${status}-${Math.random()}`, provider: "anthropic", model: "claude-haiku-4-5", status, runId: null, costUsd: null,
    costComplete: true, latencyMs: null, attempt: 0, error: null, score: null, scoreError: null, perCriterion: null, rationale: null,
  });
  seed(useEvalStore, {
    datasetsByAgent: { liven: [{ id: "d1", agent_id: "liven", name: "Screening cases", created_at: "", updated_at: "" }] },
    progressByEval: {},
  } as never);
  const stopped = results({
    rows: [{ exampleId: "x1", input: "a", expected: null, cells: [cell("succeeded"), cell("succeeded"), ...Array.from({ length: 13 }, () => cell("cancelled"))] }],
    totals: { trueSpendUsd: 0.0048, judgeCostUsd: 0, agentSpendUsd: 0.0048, budgetUsd: 0.001 },
  });
  const words = text(markup(createElement(EvalActions, { results: stopped })));
  check(words.includes("Retry 13 cells"), "it offers to retry the thirteen cancelled cells", words);
  check(words.includes("Run again"), "and to run the eval again", words);
  const done = results({ status: "completed", stopReason: null, rows: [{ exampleId: "x1", input: "a", expected: null, cells: [cell("succeeded")] }] });
  check(!text(markup(createElement(EvalActions, { results: done }))).includes("Retry"), "a complete eval has nothing to retry");
  const running = results({ status: "running" });
  check(text(markup(createElement(EvalActions, { results: running }))) === "", "and a running one offers neither");
}

console.log("\nan eval's run is tagged in Runs");
{
  const { RunsPanel } = await import("./RunsPanel.tsx");
  const { useTraceStore } = await import("../store/traceStore.ts");
  const { useBuildStore } = await import("../store/buildStore.ts");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const now = new Date().toISOString();
  seed(useBuildStore, { activeAgentId: "liven", agents: [{ agent_id: "liven", name: "Liven" }] } as never);
  seed(useTraceStore, {
    runs: {
      a: { id: "a", agent_id: "liven", provider: "anthropic", model: "m", status: "completed", started_at: now, ended_at: now, eval_id: "e1" },
      b: { id: "b", agent_id: "liven", provider: "anthropic", model: "m", status: "completed", started_at: now, ended_at: now, eval_id: null },
    },
  } as never);
  const html = markup(createElement(TooltipProvider, null, createElement(RunsPanel)));
  const tags = (html.match(/title="One run of an eval/g) ?? []).length;
  check(tags === 1, `the eval's run carries an eval tag, and the agent's own does not (${tags})`);
}

console.log("\nan eval in the Activity feed says when it stopped, and opens on its results");
{
  const { FeedDetail, navigationHint, openFeedRow } = await import("./ActivityFeed.tsx");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { useUiStore } = await import("../store/uiStore.ts");
  const row = (outcome: string) => ({
    id: "eval:e9", at: new Date().toISOString(), kind: "eval", agent_id: "liven", actor_user_id: null,
    object: "Screening cases", outcome, num: null, target_type: "eval", target_id: "e9",
  });
  const words = (outcome: string) => markup(createElement(FeedDetail, { row: row(outcome) } as never)).replace(/<[^>]+>/g, " ");
  check(/stopped/.test(words("stopped")) && !/stopped/.test(words("ok")), "an eval cancelled or over budget says it stopped, a finished one does not");
  check(navigationHint("eval") === "Open the eval's results", "its row says where it goes");
  let closed = false;
  openFeedRow(row("ok"), () => false, () => { closed = true; });
  const evals = useEvalStore.getState() as unknown as { selectedEvalByAgent: Record<string, string>; modeByAgent: Record<string, string> };
  check(evals.selectedEvalByAgent["liven"] === "e9" && evals.modeByAgent["liven"] === "results", "and opens that eval on Results",
    JSON.stringify({ e: evals.selectedEvalByAgent, m: evals.modeByAgent }));
  check(useUiStore.getState().rightTab === "evals" && closed, "in the Evals panel, with the overlay closed");
}

console.log("\na dataset with one eval still offers the agent's evals on every dataset");
{
  // The scope switch is the way to a deleted dataset's evals; it waited for this dataset to have two.
  const { EvalsPanel } = await import("./EvalsPanel.tsx");
  const { useEvalStore } = await import("../store/evalStore.ts");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const { evalListKey } = await import("../store/evalStore.ts");
  seed(useBuildStore, { activeAgentId: "liven", agents: [{ agent_id: "liven", name: "Liven" }] } as never);
  seed(useEvalStore, {
    datasetsByAgent: { liven: [{ id: "d1", agent_id: "liven", name: "Screening cases", created_at: "", updated_at: "" }] },
    selectedDatasetByAgent: { liven: "d1" },
    modeByAgent: { liven: "results" },
    evalLists: { [evalListKey("liven", "d1")]: { evals: [{
      id: "e1", dataset_id: "d1", agent_id: "liven", rubric_id: "r", status: "cancelled", targets: [], budget_usd: 0.2,
      judge_cost_usd: 0, started_at: new Date().toISOString(), ended_at: null, error: null, dataset_name: "Screening cases", dataset_gone: false,
    }], complete: true, window: 50 } },
  } as never);
  const html = markup(createElement(TooltipProvider, null, createElement(EvalsPanel)));
  check(/aria-pressed="false"[^>]*>This dataset</.test(html) || text(html).includes("This dataset"),
    "the switch to every dataset is there with only one eval", text(html).slice(0, 200));
}

console.log("\nthe rail says that pressing the tab already showing hides the panel");
{
  const { railTip } = await import("../lib/railTip.ts");
  check(railTip("Evals", true) === "Evals · Press again to hide the panel", "the Evals mark, with Evals open, says a second press hides the panel");
  check(railTip("Evals", false) === "Evals", "and with another tab open it is only its name");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
