// Two gateways, one eval: who owns it, who runs its jobs, and who may end it.
//
// Production runs two machines over one Redis. Each runner drained the shared run.eval queue, so the
// machine that did not own an eval admitted its jobs, found no record of the eval and dropped them —
// the eval sat at `running 2/12` with nothing in flight until somebody cancelled it, and the cancel
// left it `running` too. "One eval per workspace" lived in each machine's memory, so a reload onto
// the other machine started a second one; and every restart cancelled the other machine's evals.
//
// Here the two machines are two runners: each with its own lane and pool, sharing one claims backend
// and one database — which is exactly what they share in production.
//
//   npm run test:eval-replicas

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { EvalRunner, evalClaimHolder, evalClaimKey, evalRunsOwnedElsewhere } from "./evalRunner.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import type { QueueBackend } from "./queue/backend.ts";
import type { RunPool, RunPoolEvents, PoolRunOptions } from "./runPool.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A pool the test finishes runs on, by hand. */
class FakePool extends EventEmitter<RunPoolEvents> {
  started: PoolRunOptions[] = [];
  private active = new Set<string>();
  constructor(private capacity: number) { super(); }
  get freeSlots(): number { return this.capacity - this.active.size; }
  tryStart(opts: PoolRunOptions): boolean {
    if (this.freeSlots <= 0) return false;
    this.active.add(opts.runId);
    this.started.push(opts);
    return true;
  }
  stop(runId: string): void { this.finish(runId); }
  finish(runId: string): void {
    if (!this.active.delete(runId)) return;
    this.emit("exit", { runId, code: 0, signal: null, timedOut: false, elapsedMs: 0 });
  }
}

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const ctx = testContext();
const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

/** One gateway: its own pool and lane, the deployment's shared backend, a name. */
function machine(shared: QueueBackend, replicaId: string, capacity = 4) {
  const pool = new FakePool(capacity);
  const finished: { evalId: string; status: string; error?: string }[] = [];
  const forwarded: string[] = [];
  const runner = new EvalRunner({
    pool: pool as unknown as RunPool,
    store,
    dispatcher: new Dispatcher(new InMemoryQueueBackend()),
    shared,
    replicaId,
    forwardCancel: (_ws, evalId) => forwarded.push(evalId),
    agentVersion: async () => 4,
    evalStore,
    runtimeDir: ".",
    context: () => ctx,
    markEvalRun: () => {},
    onStarted: () => {},
    onProgress: () => {},
    onFinished: (e) => finished.push(e),
  });
  return { pool, runner, finished, forwarded };
}

async function dataset(name: string, cases: number): Promise<string> {
  const ds = await evalStore.createDataset(ctx, `agent_${name}`, name);
  for (let i = 0; i < cases; i++) await evalStore.addExample(ctx, ds.id, `${name}-${i}`, null, null);
  return ds.id;
}

async function completeRun(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await store.upsertRun(ctx, {
    id: runId, agent_id: "agent", provider: "fake", model: "fake", status: "completed",
    started_at: now, ended_at: now, cost: 0, tokens: 0, error: null,
  });
}

console.log("\none eval per workspace, across both machines");
{
  const shared = new InMemoryQueueBackend();
  const a = machine(shared, "machine-a", 0);
  const b = machine(shared, "machine-b", 0);
  const ds = await dataset("claim", 2);
  const first = await a.runner.start({ ctx, datasetId: ds, agentId: "agent_claim", rubricId: rubric.id, targets: [{ provider: "fake", model: "fake" }], budgetUsd: null });
  check("the first machine starts it", !("error" in first), JSON.stringify(first));
  if (!("error" in first)) {
    check("recording the agent version it runs against", (await evalStore.getEvalRun(ctx, first.evalId))?.agent_version === 4);
  }
  check("the second machine sees the workspace busy", await b.runner.busyIn(ctx.workspaceId));
  const second = await b.runner.start({ ctx, datasetId: ds, agentId: "agent_claim", rubricId: rubric.id, targets: [{ provider: "fake", model: "fake" }], budgetUsd: null });
  check("and refuses a second eval in it", "error" in second && second.error === "an eval is already running", JSON.stringify(second));
  if (!("error" in first)) {
    await a.runner.cancel(first.evalId);
    check("once it ends, the claim is free", !(await b.runner.busyIn(ctx.workspaceId)));
  }
}

console.log("\nan eval's jobs run on the machine that owns it, and only there");
{
  const shared = new InMemoryQueueBackend();
  const a = machine(shared, "machine-a");
  const b = machine(shared, "machine-b");
  const ds = await dataset("lane", 3);
  const started = await a.runner.start({ ctx, datasetId: ds, agentId: "agent_lane", rubricId: rubric.id, targets: [{ provider: "fake", model: "fake" }], budgetUsd: null });
  if ("error" in started) check("start", false, started.error);
  else {
    for (let i = 0; i < 60 && a.pool.started.length < 3; i++) await sleep(15);
    await sleep(600); // past the other machine's periodic drain, which used to take the jobs and drop them
    check("the owner started all three", a.pool.started.length === 3, `${a.pool.started.length}`);
    check("the other machine started none", b.pool.started.length === 0, `${b.pool.started.length}`);
    for (const launch of [...a.pool.started]) { await completeRun(launch.runId); a.pool.finish(launch.runId); }
    for (let i = 0; i < 60 && !a.finished.length; i++) await sleep(15);
    check("and the eval completes", a.finished[0]?.status === "completed", JSON.stringify(a.finished));
  }
}

console.log("\na cancel that arrives at the other machine reaches the owner");
{
  const shared = new InMemoryQueueBackend();
  const a = machine(shared, "machine-a", 0);
  const b = machine(shared, "machine-b", 0);
  const ds = await dataset("forward", 2);
  const started = await a.runner.start({ ctx, datasetId: ds, agentId: "agent_forward", rubricId: rubric.id, targets: [{ provider: "fake", model: "fake" }], budgetUsd: null });
  if ("error" in started) check("start", false, started.error);
  else {
    const where = await b.runner.cancel(started.evalId, ctx);
    check("the other machine forwards it", where === "forwarded" && b.forwarded.includes(started.evalId), where);
    check("and does not settle an eval it does not own", (await evalStore.getEvalRun(ctx, started.evalId))?.status === "running");
    // What the bridge does on the owner: a cancel with no context, which only a live eval answers.
    check("the owner, told, cancels it", (await a.runner.cancel(started.evalId)) === "here");
    check("and it finishes, cancelled", a.finished.at(-1)?.status === "cancelled", JSON.stringify(a.finished));
    check("a machine that never had it ignores the forwarded cancel", (await b.runner.cancel(started.evalId)) === "none");
  }
}

console.log("\nan eval nobody is running is settled by whoever is asked");
{
  const shared = new InMemoryQueueBackend();
  const a = machine(shared, "machine-a", 0);
  const b = machine(shared, "machine-b", 0);
  const ds = await dataset("orphan", 2);
  const started = await a.runner.start({ ctx, datasetId: ds, agentId: "agent_orphan", rubricId: rubric.id, targets: [{ provider: "fake", model: "fake" }], budgetUsd: null });
  if ("error" in started) check("start", false, started.error);
  else {
    // The machine went away: its claim lapsed, and nothing will ever run or end this eval.
    await shared.releaseSemaphore(evalClaimKey(ctx.workspaceId), evalClaimHolder(started.evalId, "machine-a"));
    const where = await b.runner.cancel(started.evalId, ctx);
    check("the cancel settles it where it was asked", where === "settled", where);
    const row = await evalStore.getEvalRun(ctx, started.evalId);
    check("as cancelled, with the reason", row?.status === "cancelled" && /no server/.test(row.error ?? ""), JSON.stringify(row));
    check("and the panel is told it finished", b.finished.at(-1)?.evalId === started.evalId);
    const jobs = await evalStore.jobsForEval(ctx, started.evalId);
    check("every job is cancelled", jobs.every((j) => j.status === "cancelled"), jobs.map((j) => j.status).join(","));
  }
}

console.log("\na restart settles its own evals and leaves the other machine's alone");
{
  const shared = new InMemoryQueueBackend();
  const a = machine(shared, "machine-a", 1);
  const ds = await dataset("restart", 2);
  const started = await a.runner.start({ ctx, datasetId: ds, agentId: "agent_restart", rubricId: rubric.id, targets: [{ provider: "fake", model: "fake" }], budgetUsd: null });
  if ("error" in started) check("start", false, started.error);
  else {
    for (let i = 0; i < 60 && a.pool.started.length < 1; i++) await sleep(15);
    const running = a.pool.started[0]!.runId;
    // Machine B restarts while A drains: neither the eval nor its running run is B's to close.
    const bRestarted = machine(shared, "machine-b", 0);
    const settled = await bRestarted.runner.reconcile([ctx], "interrupted by a server restart", false);
    check("the restarted machine settles nothing of the other's", settled === 0, `${settled}`);
    check("the eval is still running", (await evalStore.getEvalRun(ctx, started.evalId))?.status === "running");
    const elsewhere = await evalRunsOwnedElsewhere(shared, evalStore, ctx, "machine-b");
    check("and its running run is named as the other machine's", elsewhere.has(running), [...elsewhere].join(","));
    check("which the machine that owns it does not see as elsewhere", !(await evalRunsOwnedElsewhere(shared, evalStore, ctx, "machine-a")).has(running));

    // Machine A restarts under the same name: the eval it was running is now nobody's but its own.
    const aRestarted = machine(shared, "machine-a", 0);
    const mine = await aRestarted.runner.reconcile([ctx], "interrupted by a server restart", false);
    check("a machine restarting under its own name settles what it was running", mine === 1, `${mine}`);
    const row = await evalStore.getEvalRun(ctx, started.evalId);
    check("as interrupted", row?.status === "cancelled" && row.error === "interrupted by a server restart", JSON.stringify(row));
    check("and the workspace is free again", !(await aRestarted.runner.busyIn(ctx.workspaceId)));
  }
}

console.log("\nand the server is wired the way this suite assumes");
{
  // Everything above holds for two runners built like these. What made production stall was how
  // index.ts built its one: on the shared queue. Read the construction rather than trust it.
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const at = index.indexOf("evalRunner = new EvalRunner({");
  const construction = index.slice(at, index.indexOf("\n});", at));
  check("the runner drains this machine's own lane", /\bdispatcher: evalLane,/.test(construction));
  check("and keeps its claims and provider caps in the shared backend", /\bshared: dispatcher\.backend,/.test(construction));
  check("under this machine's name", /\breplicaId: REPLICA_ID,/.test(construction));
  check("a boot settles evals through the runner, not by cancelling every unfinished one",
    index.includes("evalRunner\n  .reconcile(workspaceContexts") && !index.includes("for (const stale of await evalStore.unfinishedEvalRuns(ctx))"));
  check("a cancel names its workspace, so it can reach another machine or none", index.includes("evalRunner.cancel(cmd.evalId, ctx)"));

  // AND AN ANSWER GOES TO THE TAB THAT ASKED. Every eval message reaches every socket in the
  // workspace; a reply that does not name its asker lands in everybody's tab.
  const handler = index.slice(index.indexOf("async function handleEvalCommand("), index.indexOf("// --- pipeline -----"));
  check("the eval handler answers through `reply`, which names the asker",
    handler.includes("const reply = (") && !/relay\.broadcastEval\(ctx, \{ type: "(error|estimate|promoted)"/.test(handler));
  check("and a started eval names the tab that started it", handler.includes("...(origin ? { origin } : {}),"));

  // AN AGENT WITH NO CODE IS REFUSED, before an estimate and before a start — every job would fail.
  const start = handler.slice(handler.indexOf('case "startEval": {'), handler.indexOf('case "cancelEval": {'));
  const estimate = handler.slice(handler.indexOf('case "estimateEval": {'), handler.indexOf('case "loadEvalResults": {'));
  check("a start asks whether the agent was ever built", start.includes("await evalBlockedFor(ctx, cmd.agentId)"));
  check("and so does an estimate", estimate.includes("await evalBlockedFor(ctx, cmd.agentId)"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
