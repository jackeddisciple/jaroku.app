// The eval store: what the eval channel's messages do to the Evals tab's state.
//
// A finished eval stays finished. The server once sent a progress count after `evalFinished`, and the
// store replaced the whole object with it — so the status went, and the panel read `running 15/15`
// over a Cancel that cancelled nothing, with every model chip locked until a reload.
//
//   npm run test:eval-store

import { useEvalStore, type EvalProgress } from "./evalStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const count = (over: Partial<EvalProgress> = {}): EvalProgress => ({
  evalId: "e1", total: 15, done: 2, running: 0, queued: 13, failed: 0, succeeded: 2, cancelled: 0, ...over,
});

console.log("\na count after the finish does not bring an eval back to life");
{
  const s = useEvalStore.getState();
  s.setProgress(null);
  s.applyProgress(count());
  check("a count lands while the eval runs", useEvalStore.getState().progress?.done === 2);
  s.patchProgress({ status: "aborted_over_budget", scoring: true });
  s.applyProgress(count({ done: 15, queued: 0, cancelled: 13 }));
  const p = useEvalStore.getState().progress;
  check("the status survives a late count", p?.status === "aborted_over_budget", JSON.stringify(p));
  check("and so does scoring", p?.scoring === true);
}

console.log("\nanother eval's count is not that eval's");
{
  const s = useEvalStore.getState();
  s.setProgress(count({ status: "completed" }));
  s.applyProgress(count({ evalId: "e2", done: 0, queued: 3, total: 3 }));
  const p = useEvalStore.getState().progress;
  check("a new eval's count replaces a finished one", p?.evalId === "e2" && p.status === undefined, JSON.stringify(p));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// `globalThis.process` rather than `process`: the client tsconfig has no node types.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
