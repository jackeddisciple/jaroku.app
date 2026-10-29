// The eval store: what the eval channel's messages do to the Evals tab's state.
//
// Two rules, both about state that belonged to something and was shown as if it belonged to
// whatever was on screen:
//
//   A FINISHED EVAL STAYS FINISHED. The server once sent a progress count after `evalFinished`, and
//   the store replaced the whole object with it — so the status went, and the panel read
//   `running 15/15` over a Cancel that cancelled nothing, with every model chip locked until a reload.
//
//   EACH AGENT'S IS ITS OWN. The datasets, the selection, the history and the live progress were
//   single values, so selecting another agent while an eval ran showed it the first agent's results,
//   cases and `running 2/12`, with nothing on the panel to say whose they were.
//
//   npm run test:eval-store

import { datasetsOf, evalListKey, liveEvalOf, useEvalStore, type EvalProgress } from "./evalStore.ts";
import type { Dataset, EvalRunSummary } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const count = (over: Partial<EvalProgress> = {}): EvalProgress => ({
  evalId: "e1", total: 15, done: 2, running: 0, queued: 13, failed: 0, succeeded: 2, cancelled: 0, ...over,
});
const dataset = (id: string, agent: string): Dataset => ({ id, agent_id: agent, name: id, created_at: "", updated_at: "" });
const summary = (id: string): EvalRunSummary => ({
  id, dataset_id: "d", agent_id: "liven", status: "completed", targets: [], budget_usd: null,
  judge_cost_usd: 0, started_at: "", ended_at: null, error: null,
});

console.log("\na count after the finish does not bring an eval back to life");
{
  const s = useEvalStore.getState();
  s.noteStarted(count({ done: 0, queued: 15, agentId: "liven", datasetId: "d1" }));
  s.applyProgress(count());
  check("a count lands while the eval runs", useEvalStore.getState().progressByEval["e1"]?.done === 2);
  check("and keeps the agent it started under", useEvalStore.getState().progressByEval["e1"]?.agentId === "liven");
  s.patchProgress("e1", { status: "aborted_over_budget", scoring: true });
  s.applyProgress(count({ done: 15, queued: 0, cancelled: 13 }));
  const p = useEvalStore.getState().progressByEval["e1"];
  check("the status survives a late count", p?.status === "aborted_over_budget", JSON.stringify(p));
  check("and so does scoring", p?.scoring === true);
  s.patchProgress("e1", { scoring: false });
  check("once scoring ends it is no longer this agent's live eval", liveEvalOf(useEvalStore.getState().progressByEval, "liven") === null);
}

console.log("\none agent's eval is not another agent's");
{
  const s = useEvalStore.getState();
  s.noteStarted(count({ evalId: "e2", done: 0, queued: 12, total: 12, agentId: "liven", datasetId: "d1" }));
  const byEval = useEvalStore.getState().progressByEval;
  check("the agent that runs it sees it running", liveEvalOf(byEval, "liven")?.evalId === "e2");
  check("another agent sees nothing running", liveEvalOf(byEval, "bruno") === null);
}

console.log("\neach agent keeps its own datasets, selection and history");
{
  const s = useEvalStore.getState();
  s.setDatasets("liven", [dataset("d1", "liven"), dataset("d2", "liven")]);
  s.selectDataset("liven", "d2");
  s.setDatasets("bruno", [dataset("d9", "bruno")]);
  const st = useEvalStore.getState();
  check("listing one agent's datasets leaves the other's", datasetsOf(st.datasetsByAgent, "liven").length === 2);
  check("and each agent keeps its own selection", st.selectedDatasetByAgent["liven"] === "d2" && st.selectedDatasetByAgent["bruno"] === "d9");
  s.removeDataset("d2");
  check("a deleted selection falls back to the agent's newest", useEvalStore.getState().selectedDatasetByAgent["liven"] === "d1");

  s.setEvals(evalListKey("liven", "d1"), [summary("x1")], { complete: true, window: 50 });
  s.setEvals(evalListKey("liven", null), [summary("x1"), summary("x2")], { complete: false, window: 50 });
  const lists = useEvalStore.getState().evalLists;
  check("a dataset's history and the agent's all-datasets history are kept apart",
    lists[evalListKey("liven", "d1")]?.evals.length === 1 && lists[evalListKey("liven", null)]?.evals.length === 2);
  check("and neither is another agent's", lists[evalListKey("bruno", "d9")] === undefined);
  s.selectEval("liven", "x2");
  check("the selected eval is this agent's", useEvalStore.getState().selectedEvalByAgent["bruno"] === undefined);
}

console.log("\nnothing listed yet is one value, so a selector reading it settles");
{
  // A fresh `[]` per call is a snapshot that never settles: opening Evals before the datasets
  // arrived blanked the app with "Maximum update depth exceeded".
  const { examplesOf } = await import("./evalStore.ts");
  const none = useEvalStore.getState().datasetsByAgent;
  check("an agent with no datasets listed reads the same empty list every time",
    datasetsOf(none, "not-listed-yet") === datasetsOf(none, "not-listed-yet") && datasetsOf(none, null) === datasetsOf(none, null));
  check("and so does a dataset whose cases have not arrived",
    examplesOf({}, "d-pending") === examplesOf({}, "d-pending") && examplesOf({}, null) === examplesOf({}, null));
}

console.log("\nthe facet a case list was narrowed to is kept per eval, for the trip to a trace and back");
{
  useEvalStore.getState().setCaseFacet("e1", "failed");
  useEvalStore.getState().setCaseFacet("e2", "disagree");
  const st = useEvalStore.getState();
  check("each eval keeps its own", st.caseFacetByEval["e1"] === "failed" && st.caseFacetByEval["e2"] === "disagree");
  check("and the store starts with none, so a workspace switch's reset clears them",
    Object.keys(useEvalStore.getInitialState().caseFacetByEval).length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// `globalThis.process` rather than `process`: the client tsconfig has no node types.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
