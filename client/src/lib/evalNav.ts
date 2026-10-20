// Going back from an eval's trace to the eval.
//
// "Open trace" was one way: the trace did not say its run came from an eval, had no way back, and the
// Evals tab came back on Dataset with the cell shut. This is the way back — the agent, its Results, the
// eval selected, and the cell that was open still open.

import { useBuildStore } from "../store/buildStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { useUiStore } from "../store/uiStore.ts";

export function openEvalResults(agentId: string, evalId: string): void {
  if (useBuildStore.getState().activeAgentId !== agentId) useBuildStore.getState().selectAgent(agentId);
  const evals = useEvalStore.getState();
  evals.selectEval(agentId, evalId);
  evals.setMode(agentId, "results");
  useUiStore.getState().setRightTab("evals");
}
