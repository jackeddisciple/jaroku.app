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
const { TooltipProvider: Tips } = await import("./ui/tooltip.tsx");
type Results = import("../types.ts").EvalResults;
/** Inside the tooltip provider the app always renders in — the header's facts carry tooltips. */
const tipped = (el: ReturnType<typeof createElement>) => createElement(Tips, null, el);

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
  const words = text(markup(tipped(createElement(ResultsHeader, { results: results(), live: null }))));
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
  const words = text(markup(tipped(createElement(ResultsHeader, { results: results({ status: "running", stopReason: null }), live }))));
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

console.log("\nthe cases can be narrowed as the trace's steps are, and a criterion is read by its name");
{
  const { ExampleDrillDown, CellDetail, CriterionBreakdown } = await import("./EvalDrillDown.tsx");
  const { useEvalStore } = await import("../store/evalStore.ts");
  type Cell = import("../types.ts").ExampleCell;
  const mk = (over: Partial<Cell> = {}): Cell => ({
    jobId: Math.random().toString(36), provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r",
    costUsd: 0.001, costComplete: true, latencyMs: 900, attempt: 0, error: null, output: "4 words.", matches: null,
    score: 0.75, scoreError: null, perCriterion: { correctness: 3, grounding: 4 }, rationale: null, ...over,
  });
  const leg = (model: string) => ({
    provider: "anthropic", model, total: 3, succeeded: 3, failed: 0, cancelled: 0, pending: 0, successRate: 1, comparisonCostUsd: 0.003,
    costPerRunUsd: 0.001, spentUsd: 0.003, tokens: 30, latencyP50Ms: 900, latencyP95Ms: 1000, costUnknown: false, costIncomplete: false,
    qualityScore: 0.7, scored: 3, unscored: 0,
  });
  const rubric = [
    { id: "correctness", label: "Correctness", description: "Does it answer the question?", weight: 3 },
    { id: "grounding", label: "Grounding", description: "Is every claim supported?", weight: 1 },
  ];
  const rows = [
    { exampleId: "a", input: "Count the words", expected: null, cells: [mk(), mk({ model: "claude-sonnet-5", score: 0.8 })] },
    { exampleId: "b", input: "What time is it", expected: null, cells: [mk({ status: "failed", score: null, perCriterion: null, error: "boom" }), mk({ model: "claude-sonnet-5" })] },
    { exampleId: "c", input: "Sydney evening?", expected: null, cells: [
      mk({ score: 0.25, perCriterion: { correctness: 1, grounding: 2 } }),
      mk({ model: "claude-sonnet-5", score: 1, perCriterion: { correctness: 4, grounding: 4 } }),
    ] },
  ];
  const r = results({ evalId: "eF", rows, rubric, providers: [leg("claude-haiku-4-5"), leg("claude-sonnet-5")] });
  let html = markup(createElement(ExampleDrillDown, { results: r }));
  // shadcn's ToggleGroup: a radiogroup, each facet's count a badge in the colour of what it counts.
  check(/<div[^>]*role="radiogroup"[^>]*aria-label="Show cases"/.test(html), "the cases have the trace's filter over them");
  check(/>Failed<span data-slot="badge"[^>]*bg-err\/10 text-err[^>]*>1<\/span>/.test(html), "Failed counts its one case, in red");
  check(/>Disagree<span data-slot="badge"[^>]*>2<\/span>/.test(html), "and the two where the models answered differently");
  check(/>Cases<\/span><span class="text-tiny tabular-nums text-faint">3</.test(html), "the header counts every case");
  check(!/>Changed</.test(html), "with nothing compared, there is no Changed");
  seed(useEvalStore, { caseFacetByEval: { eF: "failed" } } as never);
  html = markup(createElement(ExampleDrillDown, { results: r }));
  const words = text(html);
  check(words.includes("What time is it") && !words.includes("Count the words"), "under Failed only the failed case is listed", words.slice(0, 200));
  check(/select-none pt-0\.5">2<\/span>/.test(html), "and it keeps its own number");

  const detail = markup(createElement(CellDetail, {
    cell: mk(), expected: null, criteria: ["correctness", "grounding"], onStep: () => {},
    labelOf: (id: string) => (id === "correctness" ? "Correctness" : "Grounding"),
  }));
  check(text(detail).includes("Correctness") && />3<span class="text-faint">\/4<\/span>/.test(detail) && !/>correctness</.test(detail),
    "a cell's criterion is read by its name, out of the four steps it is scored on");

  const breakdown = text(markup(createElement(CriterionBreakdown, { results: r })));
  check(breakdown.includes("By criterion") && breakdown.includes("Correctness 75%") && breakdown.includes("Grounding 25%"),
    "the breakdown names each criterion with its share of the score", breakdown);
  check(breakdown.includes("2.0") && breakdown.includes("3.3") && breakdown.includes("4.0"), "and each model's average on it, over what was scored", breakdown);
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
  check(words.indexOf("Spent") < words.indexOf("Models") && words.includes("Judge") && words.includes("not scored"),
    "the eval's own figures lead the table, and judging that never ran is not scored rather than $0.00", words.slice(0, 220));
  check(!/text-run(?![a-z])/.test(html), "nothing on a stopped eval's table is amber — amber is for what is running");
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
  const actions = markup(createElement(EvalActions, { results: stopped }));
  const words = text(actions);
  // The count beside the mark, and the whole sentence in its tooltip.
  check(words.includes("Retry 13") && /title="Retry 13 cells — /.test(actions), "it offers to retry the thirteen cancelled cells", words);
  check(/aria-label="Run again"/.test(markup(createElement(EvalActions, { results: stopped }))), "and to run the eval again, as the trace's mark beside its pill", words);
  const done = results({ status: "completed", stopReason: null, rows: [{ exampleId: "x1", input: "a", expected: null, cells: [cell("succeeded")] }] });
  check(!text(markup(createElement(EvalActions, { results: done }))).includes("Retry"), "a complete eval has nothing to retry");
  const running = results({ status: "running" });
  check(text(markup(createElement(EvalActions, { results: running }))) === "", "and a running one offers neither");
  check(/aria-label="Export these results"/.test(markup(createElement(EvalActions, { results: running }))), "though it can be exported while it runs");
  // A case deleted before evals kept a copy cannot run again — retried, it only failed at once.
  const orphaned = results({
    datasetName: null,
    rows: [
      { exampleId: "x1", input: "(gone)", expected: null, caseGone: true, cells: [cell("cancelled"), cell("cancelled")] },
      { exampleId: "x2", input: "kept", expected: null, cells: [cell("cancelled")] },
    ],
  });
  check(/title="Retry 1 cell — /.test(markup(createElement(EvalActions, { results: orphaned }))), "Retry counts only the cells that still have a case");
  const allGone = results({ rows: [{ exampleId: "x1", input: "(gone)", expected: null, caseGone: true, cells: [cell("cancelled")] }] });
  check(!text(markup(createElement(EvalActions, { results: allGone }))).includes("Retry"), "and is not offered when none do");
  check(text(markup(tipped(createElement(ResultsHeader, { results: orphaned, live: null })))).includes("a deleted dataset"),
    "a dataset with no name left reads as deleted, not as the word \"dataset\"");
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
  // Two marks, each named by what it lists — the dataset's evals chosen, every dataset's beside it.
  // shadcn's ToggleGroup: a radiogroup of radios, whatever order Radix writes their attributes in.
  const radio = (label: RegExp): string => (html.match(/<button[^>]*>/g) ?? []).find((b) => label.test(b) && /role="radio"/.test(b)) ?? "";
  check(/<div[^>]*role="radiogroup"[^>]*aria-label="Which evals to list"/.test(html)
    && /aria-checked="true"/.test(radio(/aria-label="Show only this dataset[^"]*evals"/))
    && /aria-checked="false"/.test(radio(/aria-label="Show this agent[^"]*evals on every dataset[^"]*"/)),
    "the switch to every dataset is there with only one eval", text(html).slice(0, 200));
  check(/aria-label="Choose which eval to show"/.test(html) && text(html).includes("Screening cases"),
    "and the eval on screen is one menu, naming when it ran and on what");
  check(!/aria-label="Compare with an earlier eval"/.test(html), "with nothing to compare it with, there is no compare menu");
}

console.log("\nthe pickers name each past eval by when, what it ran on, and against which models");
{
  const { EvalFace, EvalsPanel } = await import("./EvalsPanel.tsx");
  const { useEvalStore, evalListKey } = await import("../store/evalStore.ts");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const e = (id: string, status: string, ago: number) => ({
    id, dataset_id: "d1", agent_id: "liven", rubric_id: "r", status, budget_usd: 1, judge_cost_usd: 0,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }, { provider: "anthropic", model: "claude-sonnet-5", effort: "high" }],
    started_at: new Date(Date.now() - ago).toISOString(), ended_at: null, error: null, dataset_name: "Screening cases", dataset_gone: false,
  });
  const face = text(markup(createElement(EvalFace, { e: e("e2", "aborted_over_budget", 3 * 3600_000) as never, dataset: "Screening cases", models: "Haiku 4.5 · Sonnet 5 (high)" })));
  check(face === "3h ago Screening cases Haiku 4.5 · Sonnet 5 (high) · over budget", "its time, its dataset, its models, and how it ended when not cleanly", face);
  seed(useEvalStore, {
    evalLists: { [evalListKey("liven", "d1")]: { evals: [e("e1", "completed", 60_000), e("e2", "aborted_over_budget", 3 * 3600_000)], complete: true, window: 50 } },
    selectedEvalByAgent: { liven: "e1" },
    compareWithByAgent: {},
  } as never);
  const panel = (): string => markup(createElement(TooltipProvider, null, createElement(EvalsPanel)));
  check(/aria-label="Compare with an earlier eval"/.test(panel()) && text(panel()).includes("Compare"),
    "with two, the eval on screen can be compared with the other");
  seed(useEvalStore, {
    compareWithByAgent: { liven: "e2" },
    resultsByEval: { e2: results({ evalId: "e2", startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }) },
  } as never);
  check(text(panel()).includes("vs 3h ago"), "and once compared, the menu says with which", text(panel()).slice(0, 300));
}

console.log("\nthe panel is headed as the trace is, and its two views are tabs that count only totals");
{
  const { EvalsPanel } = await import("./EvalsPanel.tsx");
  const { useEvalStore, evalListKey } = await import("../store/evalStore.ts");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const summary = {
    id: "e1", dataset_id: "d1", agent_id: "liven", rubric_id: "r", status: "completed", targets: [], budget_usd: 0.2,
    judge_cost_usd: 0, started_at: new Date().toISOString(), ended_at: null, error: null, dataset_name: "Screening cases", dataset_gone: false,
  };
  const example = (id: string) => ({ id, dataset_id: "d1", input: `case ${id}`, expected: null, notes: null, position: 0, created_at: "" });
  seed(useBuildStore, { activeAgentId: "liven", agents: [{ agent_id: "liven", name: "Liven" }] } as never);
  seed(useEvalStore, {
    datasetsByAgent: { liven: [{ id: "d1", agent_id: "liven", name: "Screening cases", created_at: "", updated_at: "" }] },
    selectedDatasetByAgent: { liven: "d1" },
    modeByAgent: { liven: "dataset" },
    examplesByDataset: { d1: [example("x1"), example("x2"), example("x3")] },
    evalLists: { [evalListKey("liven", "d1")]: { evals: [summary], complete: false, window: 50 } },
  } as never);
  const panel = (): string => markup(createElement(TooltipProvider, null, createElement(EvalsPanel)));
  const html = panel();
  check(text(html).startsWith("Evals Liven Screening cases"), "it names itself, the agent and the open dataset first", text(html).slice(0, 80));
  // shadcn's Tabs: a tablist whose tabs control their panels, the open one a panel of its own.
  check(/role="tablist"[^>]*aria-label="Eval views"/.test(html) && /role="tabpanel"/.test(html), "the two views are a tab strip", html.slice(0, 200));
  // Each tab is its mark, its word and — when it is a total — its count.
  const tab = (h: string, name: string): string =>
    (h.match(/<button[^>]*role="tab"[\s\S]*?<\/button>/g) ?? []).find((b) => b.includes(`</svg>${name}`)) ?? "";
  check(/aria-selected="true"/.test(tab(html, "Dataset")) && /<svg/.test(tab(html, "Dataset"))
    && /Dataset<span data-slot="badge"[^>]*>3<\/span>/.test(tab(html, "Dataset")), "Dataset is open and counts its three cases", tab(html, "Dataset"));
  check(/aria-selected="false"/.test(tab(html, "Results")) && /Results<\/button>$/.test(tab(html, "Results")),
    "and Results, whose list is still a window, carries no count", tab(html, "Results"));
  seed(useEvalStore, { evalLists: { [evalListKey("liven", "d1")]: { evals: [summary], complete: true, window: 50 } } } as never);
  check(/Results<span data-slot="badge"[^>]*>1<\/span>/.test(tab(panel(), "Results")), "once the list is whole, it is counted");
  check(!/role="progressbar"/.test(html) && !/bg-run\/10/.test(html), "with nothing running there is no bar and no pill");
}

console.log("\nan eval in flight is the trace's pill, and a bar of what it is made of");
{
  const { EvalProgressBar, EvalOutcomePill } = await import("./EvalsPanel.tsx");
  const p = { evalId: "e1", total: 12, done: 7, running: 2, queued: 3, failed: 1, succeeded: 6, cancelled: 0 };
  const html = markup(createElement(EvalProgressBar, { progress: p }));
  check(/role="progressbar"[^>]*aria-valuemax="12"[^>]*aria-valuenow="7"/.test(html), "a progress bar, seven of twelve", html.slice(0, 300));
  check(text(html) === "2 in flight · 3 queued · 1 failed", "and its caption says what the rest are", text(html));
  check(/bg-run(?![a-z])/.test(html) && !/text-run(?![a-z])/.test(html), "amber is spent on the jobs in flight, not on the words");
  const scoring = markup(createElement(EvalProgressBar, { progress: { ...p, done: 12, running: 0, queued: 0, status: "completed", scoring: true } }));
  check(text(scoring) === "every run finished · scoring the answers" && !/bg-run(?![a-z])/.test(scoring), "once the runs are done it says the judge is scoring, with nothing in flight", text(scoring));

  const pill = (status: string, extra: Record<string, unknown> = {}) => markup(createElement(EvalOutcomePill, { status, ...extra } as never));
  const live = pill("running", { detail: "7 of 12" });
  check(/bg-run\/10 text-run/.test(live) && /animate-stream-pulse/.test(live) && text(live) === "running · 7 of 12", "running is the trace's amber pill, alive", text(live));
  check(/bg-ok\/10 text-ok/.test(pill("completed")) && text(pill("completed")) === "completed", "a finished eval is green");
  check(/bg-warn\/10 text-warn/.test(pill("aborted_over_budget")) && text(pill("aborted_over_budget")) === "over budget", "one that stopped at its ceiling is the trace's stopped blue, in its own words");
  check(/bg-warn\/10/.test(pill("cancelled")) && /bg-err\/10 text-err/.test(pill("error")), "cancelled is stopped too, and only a broken one is red");
  check(text(pill("running", { word: "scoring" })) === "scoring", "and the judge's turn is said as scoring");
}

console.log("\nResults leads with what the eval found, in a sentence, under the trace's pill");
{
  const { EvalsPanel } = await import("./EvalsPanel.tsx");
  const { useEvalStore, evalListKey } = await import("../store/evalStore.ts");
  const leg = (over: Partial<import("../types.ts").ProviderMetrics>): import("../types.ts").ProviderMetrics => ({
    provider: "anthropic", model: "claude-haiku-4-5", total: 6, succeeded: 6, failed: 0, cancelled: 0, pending: 0, successRate: 1,
    comparisonCostUsd: 0.0114, costPerRunUsd: 0.0019, spentUsd: 0.0116, tokens: 9000, latencyP50Ms: 1200, latencyP95Ms: 1500,
    costUnknown: false, costIncomplete: false, qualityScore: 0.69, scored: 6, unscored: 0, ...over,
  });
  const done = results({
    status: "completed", stopReason: null, endedAt: new Date().toISOString(),
    providers: [leg({}), leg({ model: "claude-sonnet-5", qualityScore: 0.74, costPerRunUsd: 0.0044, comparisonCostUsd: 0.0264, latencyP50Ms: 1900 })],
    totals: { trueSpendUsd: 0.05, judgeCostUsd: 0.017, agentSpendUsd: 0.033, budgetUsd: 1 },
  });
  seed(useEvalStore, {
    modeByAgent: { liven: "results" },
    selectedEvalByAgent: { liven: "e1" },
    resultsByEval: { e1: done },
    compareWithByAgent: {},
    evalLists: { [evalListKey("liven", "d1")]: { evals: [], complete: true, window: 50 } },
  } as never);
  const html = markup(createElement(Tips, null, createElement(EvalsPanel)));
  const words = text(html);
  check(words.includes("claude-sonnet-5 leads quality (74 vs 69); claude-haiku-4-5 is 2.3× cheaper per run and fastest."), "the verdict says who won and at what price", words.slice(0, 400));
  check(/bg-ok\/10 text-ok/.test(html) && words.includes("completed"), "a finished eval wears the trace's green pill");
  check(words.includes("12 of 12 scored") && words.includes("of $1.00 budget"), "and its figures say what was scored and what the ceiling was");
  check(!/>anthropic</.test(html), "with one provider, its name is not repeated on every row");
}

console.log("\na refused Retry says why on Results, where it was pressed");
{
  const { EvalRefusal } = await import("./EvalsPanel.tsx");
  const { useEvalStore } = await import("../store/evalStore.ts");
  seed(useEvalStore, { error: "28 of 20 eval runs per month used on the free plan" } as never);
  const html = markup(createElement(EvalRefusal));
  check(/role="alert"/.test(html) && text(html).includes("28 of 20 eval runs"), "the refusal is drawn", text(html));
  seed(useEvalStore, { error: null } as never);
  check(markup(createElement(EvalRefusal)) === "", "and nothing when there is none");
}

console.log("\nan eval's figures are a grid that can go two by two, and a clean run reads green");
{
  const { EvalFigures } = await import("./EvalDashboard.tsx");
  const leg = (over: Partial<import("../types.ts").ProviderMetrics>): import("../types.ts").ProviderMetrics => ({
    provider: "anthropic", model: "m", total: 3, succeeded: 3, failed: 0, cancelled: 0, pending: 0, successRate: 1,
    comparisonCostUsd: 0.003, costPerRunUsd: 0.001, spentUsd: 0.003, tokens: 30, latencyP50Ms: 900, latencyP95Ms: 1000,
    costUnknown: false, costIncomplete: false, qualityScore: 0.7, scored: 3, unscored: 0, ...over,
  });
  const html = markup(createElement(EvalFigures, { results: results({ status: "completed", providers: [leg({})] }) }));
  // Four abreast cut every figure to "Spe… ≥ $0…" at the panel's narrowest; a grid's hairlines are its
  // gaps, so they are right whether it is four across or two by two.
  check(/class="mb-4 grid gap-px[^"]*bg-hair"/.test(html) && (html.match(/<div class="bg-panel">/g) ?? []).length === 4,
    "the four figures are cells of a grid drawn by its gaps", html.slice(0, 200));
  check(/text-ok[^"]*">3\/3</.test(html), "every run that ran answered, and Ran OK says so in green");
  const failed = markup(createElement(EvalFigures, { results: results({ status: "completed", providers: [leg({ succeeded: 2, failed: 1 })] }) }));
  check(!/text-ok[^"]*">2\/3</.test(failed), "and one failure takes the green away");
}

console.log("\nthe tab's menus sit on a firm edge, and every tick in it is green");
{
  // The product owner's two calls (2026-10-31): the menus' borders were too light, and a tick should
  // always read green. A closed Radix menu renders nothing, so its content is checked at the source.
  const { readFileSync } = await import("node:fs");
  const files = ["EvalsPanel", "DatasetBuilder", "EvalRunBar"].map((f) => readFileSync(`src/components/${f}.tsx`, "utf8"));
  const menus = files.flatMap((f) => f.match(/<DropdownMenuContent\b[^>]*>/g) ?? []);
  check(menus.length >= 8 && menus.every((m) => /edge="strong"/.test(m)), `every menu in the tab has the strong edge (${menus.length})`, menus.filter((m) => !/edge="strong"/.test(m)).join(" "));
  const boxes = files.flatMap((f) => f.match(/<DropdownMenuCheckboxItem\b[\s\S]*?>/g) ?? []);
  check(boxes.length >= 2 && boxes.every((b) => /tick="ok"/.test(b)), `and every checked row ticks green (${boxes.length})`);
  check(!files.some((f) => /"text-ink" : "text-transparent"\}><Icon\.evals\.chosen/.test(f)), "no chosen row is ticked in ink");
  const ui = readFileSync("src/components/ui/dropdown-menu.tsx", "utf8");
  check(/strong: "border-grip"/.test(ui) && /ok: \{ on: "border-ok bg-ok text-bg"/.test(ui), "strong is §01's strongest border, and the green tick is the success colour");
  check(/edge = "default"/.test(ui) && /tick = "ink"/.test(ui), "and every other surface keeps its own until it asks");

  const { Chosen, EVAL_SELECT } = await import("./evalUi.tsx");
  check(/text-ok/.test(markup(createElement(Chosen, { on: true }))) && /text-transparent/.test(markup(createElement(Chosen, { on: false }))),
    "a chosen row's tick is green, and an unchosen row keeps its space");
  check(/\bborder-grip\b/.test(EVAL_SELECT), "a select box has the strong border too", EVAL_SELECT);

  const { EvalFace } = await import("./EvalsPanel.tsx");
  const { STATUS } = await import("../lib/tokens.ts");
  const e = { id: "e1", dataset_id: "d1", agent_id: "liven", rubric_id: "r", status: "completed", budget_usd: 1, judge_cost_usd: 0,
    targets: [], started_at: new Date().toISOString(), ended_at: null, error: null, dataset_name: "Screening cases", dataset_gone: false };
  const done = markup(createElement(EvalFace, { e: e as never, dataset: "Screening cases", models: "" }));
  check(done.toLowerCase().includes(`color:${STATUS.ok.toLowerCase()}`), "a finished eval's tick is green in the picker", done.slice(0, 200));
  const stopped = markup(createElement(EvalFace, { e: { ...e, status: "cancelled" } as never, dataset: "Screening cases", models: "" }));
  check(!stopped.toLowerCase().includes(`color:${STATUS.ok.toLowerCase()}`), "and a stopped one is not");
  const { StatusGlyph } = await import("./StatusGlyph.tsx");
  check(!markup(createElement(StatusGlyph, { phase: "done" })).toLowerCase().includes(STATUS.ok.toLowerCase()),
    "while the shared glyph still draws done in neutral everywhere else");
}

console.log("\nthe Activity feed shows its rows before its viewport is measured");
{
  // Measured only on mount, before the first page had arrived: the viewport stayed 0 and the feed
  // card showed its caption over an empty list — every eval and run in it invisible.
  const { EventFeedCard } = await import("./ActivityFeed.tsx");
  const { useActivityStore } = await import("../store/activityStore.ts");
  const now = new Date().toISOString();
  seed(useActivityStore, {
    feed: [
      { id: "eval:e1", at: now, kind: "eval", agent_id: "liven", actor_user_id: null, object: "Screening cases", outcome: "stopped", num: null, target_type: "eval", target_id: "e1" },
      { id: "run:r1", at: now, kind: "run", agent_id: "liven", actor_user_id: null, object: "claude-haiku-4-5", outcome: "ok", num: 120, target_type: "run", target_id: "r1" },
    ],
    feedLoaded: true, feedNext: null,
  } as never);
  const words = text(markup(createElement(EventFeedCard)));
  check(words.includes("Evaluated") && words.includes("Screening cases") && words.includes("Ran"), "both rows are drawn", words.slice(0, 240));
}

console.log("\nResults reached from elsewhere still knows the agent's datasets");
{
  // Only the Dataset half asked for them, so Results opened from the Activity feed had none — no
  // Run again, no switch to every dataset's evals. The panel asks, whichever half is open.
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync("src/components/EvalsPanel.tsx", "utf8");
  const builder = readFileSync("src/components/DatasetBuilder.tsx", "utf8");
  check(/if \(connected && activeAgentId\) sendListDatasets\(activeAgentId\)/.test(panel), "the panel asks for the agent's datasets itself");
  check(!/sendListDatasets\(/.test(builder), "and the Dataset half no longer asks twice");
}

console.log("\nthe rail says that pressing the tab already showing hides the panel");
{
  const { railTip } = await import("../lib/railTip.ts");
  check(railTip("Evals", true) === "Evals · Press again to hide the panel", "the Evals mark, with Evals open, says a second press hides the panel");
  check(railTip("Evals", false) === "Evals", "and with another tab open it is only its name");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
