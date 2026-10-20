// Eval orchestrator — expands a dataset into jobs and drains them through the run pool.
//
// This is the "distributed job system" of doc §5.5, built in-process: a task queue holding
// each (example × provider) run, a bounded worker pool executing them in parallel under
// per-provider limits, and results aggregated back into one comparison. §5.5 also says a
// single Node process and SQLite stay correct until the load is real — so the QUEUE
// SEMANTICS are built properly and the transport isn't Redis.
//
// Three properties the design turns on:
//
//   1. JOBS ARE PERSISTED BEFORE ANYTHING DISPATCHES. The queue is a table, not an array.
//      A crash mid-eval leaves a readable record of what was meant to run and what already
//      spent money, instead of orphaned runs nothing points at.
//
//   2. PER-PROVIDER CONCURRENCY, not just a global cap. Providers rate-limit independently;
//      eight simultaneous calls to one provider earns 429s that look like that provider
//      being unreliable, which is exactly the wrong conclusion for a tool whose job is
//      comparing providers.
//
//   3. ONE FAILING JOB IS ONE FAILING CELL. A job that errors, times out, or can't spawn
//      is recorded and the drain continues. Partial-failure isolation (§5.5) is the whole
//      reason a batch is worth running unattended.
//
// Every job executes through the ORDINARY run path — pool slot -> jaroku_runner ->
// JarokuTracer -> TraceStore. There is no second way to run an agent.

import { randomUUID } from "node:crypto";
import type { RunPool } from "./runPool.ts";
import type { TraceStore } from "./store.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { EvalStore, EvalJob, EvalTarget } from "./evalStore.ts";
import { aggregateJob } from "./evalAggregate.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import type { QueueBackend } from "./queue/backend.ts";
import { jobClassConfig, type QueueJob } from "./queue/jobs.ts";
import { providerSemaphore } from "./queue/semaphores.ts";

/**
 * What a `run.eval` queue job carries. The dispatcher and the worker-side admit loop never
 * look inside it — this shape exists only so `dispatch()` and `executeAdmitted()` (both in
 * this file) agree on what they put in and what they read back out.
 */
interface RunEvalPayload {
  evalId: string;
  jobId: string;
  agentId: string;
  input: string;
  provider: string;
  model: string;
  attempt: number;
}

/** Wall-clock deadline per job. A wedged subprocess must not hold a slot forever. Reads the
 *  SAME env var queue/jobs.ts's run.eval config does, rather than keeping a second copy of
 *  the same default that could drift from it. */
const DEFAULT_JOB_TIMEOUT_MS = jobClassConfig("run.eval").timeoutMs ?? 180_000;

/** How much longer than the job's own timeout a provider-semaphore lease is held for, so a
 *  legitimately slow job doesn't get its provider slot reclaimed by a reaper while it's still
 *  running fair and square. */
const PROVIDER_LEASE_TTL_MS = DEFAULT_JOB_TIMEOUT_MS + 30_000;

/** Total attempts per job, including the first. Bounded: every retry costs money again. */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.JAROKU_JOB_ATTEMPTS ?? 3));
const RETRY_BASE_MS = Number(process.env.JAROKU_RETRY_BASE_MS ?? 2_000);

/**
 * Is this failure worth paying to retry?
 *
 * The distinction is the whole point of bounding retries. A rate limit or a dropped
 * connection is luck, and retrying converts it into a result. A ContractError, a missing
 * module, or an unset API key is a property of the agent or the configuration — it will
 * fail identically every time, and retrying just multiplies the bill by the attempt count
 * while making the eval slower and the failure less legible.
 *
 * Unrecognized failures are treated as DETERMINISTIC. Getting this backwards means silently
 * paying 3x for every broken agent, so the default has to be the cheap one.
 */
export function isTransientFailure(error: string | null, timedOut: boolean): boolean {
  if (timedOut) return true; // a wedged call is the canonical retryable case
  if (!error) return false;
  const e = error.toLowerCase();

  // Deterministic markers win: an import error inside a retry-shaped message is still an
  // import error.
  const deterministic = [
    "contracterror", "modulenotfounderror", "importerror", "syntaxerror",
    "attributeerror", "typeerror", "nameerror", "indentationerror",
    "api key", "api_key", "authentication", "unauthorized", "permission",
    "not_found_error", "invalid_request_error", "does not exist",
  ];
  if (deterministic.some((m) => e.includes(m))) return false;

  const transient = [
    "rate limit", "rate_limit", "429", "overloaded", "529",
    "timeout", "timed out", "econnreset", "econnrefused", "etimedout", "enotfound",
    "connection error", "connection reset", "temporarily unavailable",
    "503", "502", "504", "internal server error", "apiconnectionerror",
  ];
  return transient.some((m) => e.includes(m));
}

/**
 * How long until the next backing-off retry is due, or null when no retry is waiting.
 *
 * EVERY QUEUED RETRY NOT YET HANDED TO THE QUEUE, DUE OR NOT. It counted only the ones still in the
 * future, and that lost a retry at the moment it came due: a timer can fire a millisecond before
 * `Date.now()` agrees it should, so the pump found the retry not due yet, and a few milliseconds later
 * this found it no longer in the future — and set no wake. Nothing pumped the eval again, and it sat
 * with a queued job and idle slots for ever. A retry already due is a wake now (the 50 ms floor).
 */
export function retryWakeIn(jobs: readonly EvalJob[], enqueued: ReadonlySet<string>, now: number): number | null {
  const waiting = jobs
    .filter((j) => j.status === "queued" && j.retry_not_before && !enqueued.has(`${j.id}:${j.attempt}`))
    .map((j) => Date.parse(j.retry_not_before!))
    .filter((t) => Number.isFinite(t));
  if (!waiting.length) return null;
  return Math.max(50, Math.min(...waiting) - now);
}

export interface EvalProgress {
  evalId: string;
  total: number;
  done: number;
  running: number;
  queued: number;
  failed: number;
  /**
   * The two halves of `done` that are not failures. A cancelled job never ran: counting it with the
   * successes logged a budget stop after two runs as "15/15 succeeded".
   */
  succeeded: number;
  cancelled: number;
  /**
   * What this eval has spent SINCE the last progress event (§4.3.3).
   *
   * THE ONE THING THIS CHANNEL DID NOT CARRY, and the reason §4.3.3's worked example was
   * unreachable. An eval's jobs are ordinary runs, so their step costs exist — but eval runs are
   * deliberately kept off the `trace` channel (a running eval must not steal the timeline's focus),
   * which is the only channel the client increments a live figure from. So a thread running an eval
   * showed a frozen cost and, because `done` never moved either, no projection at all: the two
   * halves of §4.3.3 were mutually exclusive in the shipped product.
   *
   * A DELTA, NOT A TOTAL, because the client adds it to the ledger's figure exactly as it adds a
   * step's cost from `trace` — one accumulation rule, not two. §7.1 still holds: this rides an event
   * that is already broadcast per job completion and carries no payload, so nothing polls and no new
   * message type exists.
   */
  spentDeltaUsd: number;
}

export interface EvalRunnerDeps {
  pool: RunPool;
  store: TraceStore;
  /** Where a run.eval job actually goes once its dataset row is written — the fair,
   *  per-workspace-capped queue, not a direct pool.tryStart(). See dispatch() and
   *  executeAdmitted() below for the two halves of what used to be one function. */
  dispatcher: Dispatcher;
  /**
   * The workspace every job in this runner belongs to.
   *
   * A function, not a value, matching the deploy manager's `token`: it is read at the
   * moment of use so the runner never holds a context that has gone stale, and so the
   * per-command contexts of Session 2 can replace this without changing a call site here.
   */
  context: (evalId: string) => TenantContext;
  evalStore: EvalStore;
  runtimeDir: string;
  /** Register/unregister a run id as belonging to an eval, so its events stay off "trace". */
  markEvalRun: (runId: string, isEval: boolean) => void;
  onStarted: (e: { evalId: string; datasetId: string; agentId: string; total: number; targets: EvalTarget[]; origin?: string }) => void;
  onProgress: (p: EvalProgress) => void;
  onFinished: (e: { evalId: string; status: string; error?: string }) => void;
  /** Called when a job reaches a terminal state, so later stages (aggregation, judging)
   *  can hook in without this file knowing about them. */
  onJobFinished?: (job: EvalJob) => void;
  /**
   * Record which workspace a new eval belongs to, before anything else runs.
   *
   * `context()` above answers "the workspace of the eval in flight", which it can only do once
   * something has told it — and everything after this point (the pump, a job's exit, the
   * judge) reads it. Called inside `start`, between the eval becoming live and the first job
   * being dispatched, because a gap there is a job whose events are recorded in the wrong
   * workspace. The caller cannot close that gap itself: it does not know the eval's id until
   * `start` returns, which is already too late.
   */
  bindWorkspace?: (evalId: string, ctx: TenantContext) => void;
  /**
   * What one of this eval's runs needs besides its job: the workspace it is recorded in, the app it
   * runs on, and the credentials it calls its provider with — or the sentence saying it cannot run.
   *
   * WITHOUT IT AN EVAL RUN CARRIED NONE OF THE THREE. Locally that was invisible: the subprocess
   * inherited this process's environment and its events fell back to the only workspace there is.
   * Hosted, the run had no key, no run token and no app to run on, and its trace was filed in the
   * server's own workspace. Optional, so a runner built without it — every suite — runs as before.
   */
  runSetup?: (
    evalId: string,
    runId: string,
    job: { provider: string; agentId: string },
  ) => Promise<{ workspaceId?: string; host?: TenantContext; env?: NodeJS.ProcessEnv; refusal?: string | null }>;
  /** `runSetup`'s undo, for a run that was set up and then never started — no exit is coming for it. */
  releaseRun?: (runId: string) => void;
  /**
   * Count this eval against the workspace's monthly eval-run quota, per dataset CASE.
   *
   * PER CASE AND NOT PER BATCH, which is the specification's own instruction and is the difference
   * between a quota that means something and one the eval engine walks around: a comparison over a
   * hundred examples is a hundred runs of the agent and a hundred model calls, and billing it as
   * one would make the eval tab the cheapest way to use the product.
   *
   * AT DISPATCH, beside `createJobs`, because that is the moment the work becomes real — the rows
   * exist and the pump is about to start them. Counting at completion would make a cancelled
   * five-hundred-job fan-out free, and it is not.
   *
   * Optional, so a runner constructed without billing — every existing suite — behaves exactly as
   * it did.
   */
  countEvalCases?: (ctx: TenantContext, evalRunId: string, cases: number) => void;
  /**
   * Whether the WORKSPACE has run out of room, and why — or null when it has not.
   *
   * Distinct from the eval's own `budget_usd`, which is a ceiling somebody set on this
   * comparison. This is the workspace's ceiling for the period, and it has to be consulted here
   * as well as at start: a five-hundred-job fan-out is five hundred things being STARTED, and a
   * gate that only ran once would let the first job's authorisation cover all of them. The eval
   * budget has always been checked on every pump for exactly this reason; the workspace's is
   * checked in the same place, on the same rule.
   *
   * Optional, so a runner constructed without billing — every existing suite — behaves exactly
   * as it did.
   */
  workspaceOverBudget?: (evalId: string) => Promise<string | null>;
  /**
   * What every machine of this deployment shares: the claims that keep one eval per workspace, and
   * the per-provider caps. Defaults to the dispatcher's own backend, which is right whenever the two
   * are one — a single process, and every suite.
   *
   * SEPARATE FROM THE DISPATCHER on a deployment of several machines, and the separation is the fix
   * for an eval that stalled forever. The run.eval queue was shared too, so whichever machine's
   * drain came round first admitted a job — and a machine that did not own the eval had no record of
   * it, acked the job and dropped it. Its row stayed `queued` and the owner, having already enqueued
   * it once, never did again. A job can only run where its eval is live (and where the desktop app
   * that runs it is connected), so the queue each runner drains is its own lane, and only the claim
   * and the provider caps are shared.
   */
  shared?: QueueBackend;
  /** This machine's name in a claim. A restarted machine that keeps its name recognises its own. */
  replicaId?: string;
  /** Tell the machine that owns this eval to cancel it — the socket asking may be on another one. */
  forwardCancel?: (workspaceId: string, evalId: string) => void;
  /** The version this agent is on now, recorded with the eval so comparisons across an edit can be told apart. */
  agentVersion?: (ctx: TenantContext, agentId: string) => Promise<number | null>;
}

/** How long a claim lives without a heartbeat. A machine that stops beating loses it in this long. */
const CLAIM_TTL_MS = Number(process.env.JAROKU_EVAL_CLAIM_TTL_MS ?? 60_000);
const CLAIM_HEARTBEAT_MS = Math.max(50, Math.floor(CLAIM_TTL_MS / 4));

/** The one slot an eval takes in its workspace, on every machine at once. */
export function evalClaimKey(workspaceId: string): string {
  return `run.eval:claim:${workspaceId}`;
}

/** A claim's lease names the eval AND the machine, so "is this eval alive, and where" has an answer. */
export function evalClaimHolder(evalId: string, replicaId: string): string {
  return `${evalId}@${replicaId}`;
}

/** The machine holding this eval's claim, or null when nobody does — which means nobody is running it. */
export function claimOwner(holders: readonly string[], evalId: string): string | null {
  const held = holders.find((h) => h.startsWith(`${evalId}@`));
  return held ? held.slice(evalId.length + 1) : null;
}

/**
 * The runs of this workspace's evals that ANOTHER machine is still running.
 *
 * A restart closes every run left `running` as interrupted, which is right for the runs this machine
 * was running and wrong for these: the eval is alive on the other gateway, and its runs with it.
 */
export async function evalRunsOwnedElsewhere(
  shared: QueueBackend,
  evalStore: EvalStore,
  ctx: TenantContext,
  replicaId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const unfinished = await evalStore.unfinishedEvalRuns(ctx);
  if (!unfinished.length) return out;
  const holders = await shared.semaphoreHolders(evalClaimKey(ctx.workspaceId));
  for (const run of unfinished) {
    const owner = claimOwner(holders, run.id);
    if (owner === null || owner === replicaId) continue;
    for (const job of await evalStore.jobsForEval(ctx, run.id)) if (job.run_id) out.add(job.run_id);
  }
  return out;
}

export interface StartEvalRequest {
  /**
   * The workspace that asked for this eval.
   *
   * NOT `deps.context()`, which is what every read and write below used to use. That function
   * answers "the workspace of the eval currently in flight", and at the moment `start` runs
   * there is no eval in flight — so it fell back to the server's own workspace. The dataset
   * lookup then ran in the wrong workspace and found nothing, and every workspace but the
   * server's was told its own dataset had no examples. Had it found rows, the eval and its
   * jobs would have been WRITTEN there too.
   */
  ctx: TenantContext;
  datasetId: string;
  agentId: string;
  rubricId: string;
  targets: EvalTarget[];
  budgetUsd: number | null;
  /** The tab that asked — echoed on `evalStarted` so only it switches to the results. */
  origin?: string;
}

interface Live {
  evalId: string;
  /** Whose eval this is — the workspace a second start is refused for while this one drains. */
  workspaceId: string;
  /** runId -> jobId, so a pool exit can be attributed to the job that caused it. */
  runToJob: Map<string, string>;
  /** `${jobId}:${attempt}` already sent to the dispatcher, so pump()'s reconciliation scan
   *  never enqueues the same attempt twice. A NEW attempt (a retry) is a new key, and gets
   *  enqueued fresh once its backoff has passed — see scheduleRetryWake. */
  enqueuedAttempts: Set<string>;
  cancelled: boolean;
  /** Single timer for the earliest backing-off retry. See scheduleRetryWake. */
  retryTimer: NodeJS.Timeout | null;
}

/** What a job's admission needs released once its run is done — the dispatcher's own lease,
 *  and the provider semaphore acquired on top of it. Keyed by runId because that's what
 *  onRunExit is handed; nothing upstream of it needs to know a lease exists at all. */
interface RunLease {
  jobId: string;
  dispatcherLeaseId: string;
  provider: string;
  providerLeaseId: string;
}

export class EvalRunner {
  /** Evals currently draining. More than one is allowed; they share the pool's slots. */
  private live = new Map<string, Live>();
  private jobToEval = new Map<string, string>();
  private leaseByRun = new Map<string, RunLease>();
  /** See `EvalRunnerDeps.shared`. */
  private readonly shared: QueueBackend;
  readonly replicaId: string;

  constructor(private deps: EvalRunnerDeps) {
    this.shared = deps.shared ?? deps.dispatcher.backend;
    this.replicaId = deps.replicaId ?? randomUUID();
    // EACH LIVE EVAL KEEPS ITS CLAIM. A machine that dies stops beating, its claims lapse, and the
    // workspace may start again — and the evals it left are recognisably nobody's (see `reconcile`).
    setInterval(() => this.guard("claim heartbeat", this.heartbeat()), CLAIM_HEARTBEAT_MS).unref();
    // A job's run finishing is what advances the queue. Attribution is by run id — the
    // pool tags every event with one precisely so N concurrent runs stay distinguishable.
    deps.pool.on("exit", ({ runId, timedOut }) => this.guard("run exit", this.onRunExit(runId, timedOut, null)));
    deps.pool.on("spawnError", ({ runId, error }) =>
      this.guard("spawn error", this.onRunExit(runId, false, error.message)),
    );

    // A SAFETY NET, not the primary driver. dispatch() already attempts an immediate drain
    // right after enqueueing, and onRunExit's own pump() does too once a slot frees up — this
    // timer only matters for capacity that opens for a reason NEITHER of those triggers on:
    // another eval's job finishing releases the global run.eval semaphore, or a provider
    // semaphore lease simply expiring. Unref'd so it never holds the process open.
    setInterval(() => this.guard("periodic drain", this.drainAvailable()), 500).unref();
  }

  /**
   * Every promise this class starts and does not await goes through here.
   *
   * NOT DEFENSIVE TIDYING — a floating promise that rejects is an `unhandledRejection`, and Node
   * has ENDED THE PROCESS for that since v15. Everything that drives this file forward is
   * floating by design: an EventEmitter listener cannot be awaited, and neither can a 500 ms
   * timer. So one SQLITE_BUSY under exactly the concurrency this session exists to support, or
   * one Redis blip, took down the gateway — the eval would have recovered on the next tick if
   * anything had been left running to take it.
   *
   * Logged rather than swallowed: the drain is idempotent and self-healing (the timer tries
   * again, and pump() reconciles against the persisted rows either way), so the right response to
   * one failed pass is to say so and let the next one run.
   */
  private guard(what: string, p: Promise<unknown>): void {
    void p.catch((err) => {
      console.error(`[eval] ${what} failed:`, (err as Error)?.message ?? err);
    });
  }

  /**
   * A start that has begun but has no eval id yet. `live` only gains an entry once the dataset
   * has been read and the rows written, which is five awaits after `start` was called — and
   * "one eval at a time" has to hold across that whole span, not just at its end. See start().
   */
  private starting = new Set<string>();

  /**
   * Whether this workspace has an eval draining, or on its way to. Used to refuse a second start.
   *
   * PER WORKSPACE. It was one for the whole server, and the reason was real: the runner answered
   * every read as "the workspace of the first live eval", so a second one wrote into the wrong
   * tenancy. Every read now names the eval it is for, which is what lets two workspaces each have one.
   */
  activeIn(workspaceId: string): boolean {
    if (this.starting.has(workspaceId)) return true;
    for (const l of this.live.values()) if (l.workspaceId === workspaceId) return true;
    return false;
  }

  /**
   * `activeIn`, asked of every machine: this one's own state, then the workspace's shared claim.
   *
   * THE CLAIM IS THE ANSWER, and it used to be each machine's own memory. A reload that landed the
   * socket on the other gateway could start a second eval while the first was still running, and a
   * machine holding a stalled eval refused every eval its workspace started until it restarted.
   */
  async busyIn(workspaceId: string): Promise<boolean> {
    if (this.activeIn(workspaceId)) return true;
    return (await this.shared.semaphoreCount(evalClaimKey(workspaceId))) > 0;
  }

  /** The context an eval's reads and writes happen in — its own workspace's, never another's. */
  private ctx(evalId: string): TenantContext {
    return this.deps.context(evalId);
  }

  activeEvalIds(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Expand the dataset into jobs and begin draining.
   *
   * Fails loudly rather than starting an empty or malformed eval — a comparison built on
   * nothing is worse than an error, because it renders as a dashboard full of blanks.
   *
   * ONE AT A TIME PER WORKSPACE, CLAIMED SYNCHRONOUSLY. The refusal used to live in the WebSocket
   * handler, followed by five awaits before anything became live — and wsRelay dispatches commands
   * concurrently, so two startEval messages genuinely overlapped and both passed. The claim belongs
   * here, where the invariant is, and is taken before the first await so there is no window to lose.
   * It was one for the whole server while every read resolved "the first live eval's" workspace;
   * each read names its eval now (`ctx(evalId)`), so another workspace's eval is no collision.
   */
  async start(req: StartEvalRequest): Promise<{ evalId: string } | { error: string }> {
    const workspaceId = req.ctx.workspaceId;
    if (this.activeIn(workspaceId)) return { error: "an eval is already running" };
    this.starting.add(workspaceId);
    // THE SHARED CLAIM, before any row exists, so an eval row is never written without one — which
    // is what lets a machine that finds an unfinished eval with no claim call it abandoned. The id is
    // minted here rather than by the store because the claim has to name it.
    const evalId = randomUUID();
    const holder = evalClaimHolder(evalId, this.replicaId);
    try {
      if (!(await this.shared.acquireSemaphore(evalClaimKey(workspaceId), 1, holder, CLAIM_TTL_MS))) {
        return { error: "an eval is already running" };
      }
      let started: { evalId: string } | { error: string } = { error: "the eval did not start" };
      try {
        started = await this.startClaimed(req, evalId);
        return started;
      } finally {
        if ("error" in started) await this.shared.releaseSemaphore(evalClaimKey(workspaceId), holder);
      }
    } finally {
      this.starting.delete(workspaceId);
    }
  }

  private async startClaimed(req: StartEvalRequest, evalId: string): Promise<{ evalId: string } | { error: string }> {
    const examples = await this.deps.evalStore.listExamples(req.ctx, req.datasetId);
    if (!examples.length) return { error: "that dataset has no examples" };
    if (!req.targets.length) return { error: "pick at least one provider to compare" };

    // (example × provider) — the fan-out. Ordered example-major so the first results to
    // land cover one example across every provider, which is the comparison the user is
    // actually waiting to see.
    // Each job carries its case: an edit or a delete after this moment changes the next eval, not
    // this one — neither its runs nor the results anybody later reads back.
    const spec = examples.flatMap((ex) =>
      req.targets.map((t) => ({
        example_id: ex.id, provider: t.provider, model: t.model, input: ex.input, expected: ex.expected,
      })),
    );
    const dataset = await this.deps.evalStore.getDataset(req.ctx, req.datasetId);
    const agentVersion = (await this.deps.agentVersion?.(req.ctx, req.agentId).catch(() => null)) ?? null;
    // The criteria it will be scored on, copied now: an edit to the rubric mid-eval must not change
    // what the rest of this eval is judged against.
    const rubric = await this.deps.evalStore.getRubric(req.ctx, req.rubricId);

    const evalRun = await this.deps.evalStore.createEvalRun(req.ctx, {
      id: evalId,
      dataset_id: req.datasetId,
      agent_id: req.agentId,
      rubric_id: req.rubricId,
      targets: req.targets,
      budget_usd: req.budgetUsd,
      dataset_name: dataset?.name ?? null,
      agent_version: agentVersion,
      rubric: rubric?.criteria ?? null,
    });
    // Rows first, dispatch second. If the process dies right here, the eval is recoverable
    // rather than a set of runs nothing points at.
    await this.deps.evalStore.createJobs(req.ctx, evalRun.id, spec);
    // `spec.length` and not `examples.length`: a comparison across three providers runs every
    // example three times, and each of those is a run of the agent that costs a model call. The
    // number of JOBS is the number of runs, which is what the quota bounds.
    this.deps.countEvalCases?.(req.ctx, evalRun.id, spec.length);
    await this.deps.evalStore.setEvalStatus(req.ctx, evalRun.id, "running");

    this.live.set(evalRun.id, {
      evalId: evalRun.id,
      workspaceId: req.ctx.workspaceId,
      runToJob: new Map(),
      enqueuedAttempts: new Set(),
      cancelled: false,
      retryTimer: null,
    });
    // Before the first job, never after: from here on `deps.context()` is what answers for
    // this eval, and it can only answer once it has been told.
    this.deps.bindWorkspace?.(evalRun.id, req.ctx);

    console.log(
      `[eval] ${evalRun.id} started — ${examples.length} example(s) × ${req.targets.length} target(s) = ${spec.length} job(s)`,
    );
    this.deps.onStarted({
      evalId: evalRun.id,
      datasetId: req.datasetId,
      agentId: req.agentId,
      total: spec.length,
      targets: req.targets,
      ...(req.origin ? { origin: req.origin } : {}),
    });
    this.guard("initial pump", this.pump(evalRun.id));
    return { evalId: evalRun.id };
  }

  /**
   * Stop an eval: kill what's running, cancel what's queued.
   *
   * A job already admitted (leased, mid-execution) is stopped below same as before. A job
   * still sitting unadmitted in the dispatcher's queue is now pulled back out too — purged by
   * idempotencyKey, best-effort (see backend.ts's own note on why this isn't the actual
   * safety mechanism). `executeAdmitted`'s `live.cancelled` check is what still catches
   * anything that slips past the purge because it was admitted in the same instant.
   *
   * AND THEN IT SETTLES, which it used to leave to a run's exit. With nothing in flight no exit is
   * coming — an eval whose jobs sat queued was cancelled on the server, stayed `running` in the row
   * and in `live`, never told anybody it had finished, and refused every later eval in its workspace.
   * The pump after the cancel reports the cancelled cells and finishes the eval when nothing is left.
   */
  async cancel(evalId: string, ctx?: TenantContext): Promise<"here" | "forwarded" | "settled" | "none"> {
    const live = this.live.get(evalId);
    if (!live) return ctx ? this.cancelElsewhere(ctx, evalId) : "none";
    await this.cancelLive(evalId, live);
    return "here";
  }

  /**
   * A cancel for an eval this machine is not running: the owner's, if it has one, else nobody's.
   *
   * THE SOCKET CAN BE ON EITHER MACHINE. A reload put it on the gateway that did not own the eval,
   * and Cancel did nothing there. The owner is whoever holds the eval's claim; with no holder, no
   * machine is running it, so its rows are settled here rather than left `running` forever.
   */
  private async cancelElsewhere(ctx: TenantContext, evalId: string): Promise<"forwarded" | "settled" | "none"> {
    const row = await this.deps.evalStore.getEvalRun(ctx, evalId);
    if (!row || (row.status !== "queued" && row.status !== "running")) return "none";
    const owner = claimOwner(await this.shared.semaphoreHolders(evalClaimKey(ctx.workspaceId)), evalId);
    if (owner !== null && owner !== this.replicaId) {
      this.deps.forwardCancel?.(ctx.workspaceId, evalId);
      return "forwarded";
    }
    await this.settleOrphan(ctx, evalId, "cancelled — no server was still running it", true);
    return "settled";
  }

  /**
   * End an unfinished eval that no machine is running: its queued and `running` rows become
   * cancelled, the eval becomes cancelled with the reason, and — when `announce` — it finishes the
   * way any eval does, so the panel watching it stops saying `running`.
   */
  async settleOrphan(ctx: TenantContext, evalId: string, reason: string, announce: boolean): Promise<void> {
    if (this.live.has(evalId)) return;
    this.deps.bindWorkspace?.(evalId, ctx);
    const queued = await this.deps.evalStore.cancelQueuedJobs(ctx, evalId, reason);
    let running = 0;
    for (const job of await this.deps.evalStore.jobsForEval(ctx, evalId)) {
      if (job.status !== "running") continue;
      await this.deps.evalStore.finishJob(ctx, job.id, "cancelled", { error: reason });
      running++;
    }
    await this.deps.evalStore.setEvalStatus(ctx, evalId, "cancelled", reason);
    await this.shared.releaseSemaphore(evalClaimKey(ctx.workspaceId), evalClaimHolder(evalId, this.replicaId));
    console.log(`[eval] ${evalId} ${reason} — ${queued} queued and ${running} running job(s) cancelled`);
    if (announce) this.deps.onFinished({ evalId, status: "cancelled", error: reason });
  }

  /**
   * The unfinished evals of these workspaces that NO machine is running, settled.
   *
   * AT BOOT this used to be every unfinished eval, and on a deployment of two machines that was the
   * other machine's too: a rolling deploy restarted one gateway and it cancelled the evals the other
   * was still draining. An eval whose claim is held by another machine is that machine's, and is left
   * alone. One held under THIS machine's name is one this machine was running before it restarted.
   */
  async reconcile(contexts: readonly TenantContext[], reason: string, announce: boolean): Promise<number> {
    let settled = 0;
    for (const ctx of contexts) {
      const unfinished = await this.deps.evalStore.unfinishedEvalRuns(ctx);
      if (!unfinished.length) continue;
      const holders = await this.shared.semaphoreHolders(evalClaimKey(ctx.workspaceId));
      for (const run of unfinished) {
        if (this.live.has(run.id)) continue;
        const owner = claimOwner(holders, run.id);
        if (owner !== null && owner !== this.replicaId) continue;
        await this.settleOrphan(ctx, run.id, reason, announce);
        settled++;
      }
    }
    return settled;
  }

  /** Keep every live eval's claim; take back one that lapsed while this machine was busy. */
  private async heartbeat(): Promise<void> {
    for (const l of this.live.values()) {
      const key = evalClaimKey(l.workspaceId);
      const holder = evalClaimHolder(l.evalId, this.replicaId);
      if (await this.shared.renewSemaphore(key, holder, CLAIM_TTL_MS)) continue;
      if (!(await this.shared.acquireSemaphore(key, 1, holder, CLAIM_TTL_MS))) {
        console.error(`[eval] ${l.evalId} lost its workspace claim to another eval`);
      }
    }
  }

  private async cancelLive(evalId: string, live: Live): Promise<void> {
    live.cancelled = true;
    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    await this.deps.evalStore.cancelQueuedJobs(this.ctx(evalId), evalId, "cancelled");
    const keys = new Set([...live.enqueuedAttempts].map((attemptKey) => `run.eval:${attemptKey}`));
    if (keys.size) {
      const purged = await this.deps.dispatcher.purgePending("run.eval", this.ctx(evalId).workspaceId, keys);
      if (purged) console.log(`[eval] ${evalId} purged ${purged} still-queued job(s) from the dispatcher`);
    }
    for (const runId of live.runToJob.keys()) this.deps.pool.stop(runId);
    // A row that says `running` with no run here to stop has no exit coming either, and would hold
    // the eval open forever. Those end now, as cancelled.
    const tracked = new Set(live.runToJob.values());
    for (const job of await this.deps.evalStore.jobsForEval(this.ctx(evalId), evalId)) {
      if (job.status === "running" && !tracked.has(job.id)) {
        await this.deps.evalStore.finishJob(this.ctx(evalId), job.id, "cancelled", { error: "cancelled" });
      }
    }
    console.log(`[eval] ${evalId} cancelled`);
    await this.pump(evalId);
  }

  // --- draining --------------------------------------------------------------

  /** Each live eval's latest pump, so the next one runs after it. See `pump`. */
  private pumps = new Map<string, Promise<void>>();

  /**
   * Run one pass of `pumpOnce` for this eval, AFTER any pass already running for it.
   *
   * TWO PASSES USED TO OVERLAP, and the second one outlived the eval. Two jobs exiting together each
   * pumped; the first finished the eval and announced it, the second had already read the counts and
   * announced progress after the finish — which the client took as "still running", leaving a
   * finished eval on `running 15/15` with a Cancel that cancelled nothing. Both also passed the
   * budget check, so a ceiling stop was recorded and logged twice. One at a time, a pass that starts
   * after the finish finds no live eval and does nothing.
   */
  private pump(evalId: string): Promise<void> {
    const before = this.pumps.get(evalId) ?? Promise.resolve();
    const next = before.catch(() => {}).then(() => this.pumpOnce(evalId));
    this.pumps.set(evalId, next);
    void next
      .finally(() => {
        if (this.pumps.get(evalId) === next) this.pumps.delete(evalId);
      })
      .catch(() => {});
    return next;
  }

  /**
   * Dispatch as many queued jobs as the caps allow, then stop.
   *
   * Deliberately not a loop with a timer: it is called on start and on each job's exit, so
   * it advances exactly when capacity frees up. Nothing polls, and nothing can spin.
   */
  private async pumpOnce(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;

    // THE BUDGET CEILING. Checked before dispatching anything, against TRUE spend (every
    // attempt plus judge cost) — never the comparison figure, which excludes failures and
    // would let a retry storm spend straight past the limit.
    //
    // It bounds what is STARTED, not what is spent: a job already in flight runs to
    // completion, so the final total can exceed the ceiling by at most the cost of the
    // runs already going. Stopping mid-run would spend the money and throw away the result.
    // TWO CEILINGS, ONE RULE. The eval's own `budget_usd` is a limit somebody set on this
    // comparison; the workspace's is the limit on everything it starts this period. Both bound
    // what is STARTED, both are checked on every pump for the same reason — a fan-out is many
    // starts, not one — and both stop the queue rather than the jobs already running.
    const workspaceReason = live.cancelled ? null : ((await this.deps.workspaceOverBudget?.(evalId)) ?? null);
    if (!live.cancelled && (workspaceReason !== null || (await this.overBudget(evalId)))) {
      const cancelled = await this.deps.evalStore.cancelQueuedJobs(
        this.ctx(evalId),
        evalId,
        workspaceReason ?? "budget ceiling reached",
      );
      live.cancelled = true;
      const spent = await this.deps.evalStore.trueSpend(this.ctx(evalId), evalId);
      const ceiling = (await this.deps.evalStore.getEvalRun(this.ctx(evalId), evalId))?.budget_usd;
      await this.deps.evalStore.setEvalStatus(this.ctx(evalId),
        evalId,
        "aborted_over_budget",
        // Which ceiling stopped it, in the words the user will read. "Over budget" with no
        // subject leaves somebody raising the wrong number and watching it stop again.
        workspaceReason ?? `stopped after $${spent.toFixed(4)} of a $${ceiling?.toFixed(4)} budget`,
      );
      console.log(
        `[eval] ${evalId} stopped — ${cancelled} queued job(s) cancelled ` +
          `(${workspaceReason ? "workspace ceiling" : "this eval's budget"})`,
      );
    }

    // WHICH QUEUED JOBS NEED TO REACH THE DISPATCHER — reconciliation against the persisted
    // rows, not execution. Capacity (pool slots, the provider semaphore) is a SEPARATE
    // concern now, checked by executeAdmitted() once the dispatcher's own fair rotation has
    // actually chosen a job to run; this loop's only job is "does the dispatcher know about
    // every eligible attempt yet."
    const jobs = await this.deps.evalStore.jobsForEval(this.ctx(evalId), evalId);
    if (!live.cancelled) {
      const now = Date.now();
      for (const job of jobs) {
        if (job.status !== "queued") continue;
        // A backing-off retry isn't eligible yet. Skipping (not breaking) lets other jobs
        // through — one provider's rate limit must not stall the whole eval.
        if (job.retry_not_before && Date.parse(job.retry_not_before) > now) continue;
        const attemptKey = `${job.id}:${job.attempt}`;
        if (live.enqueuedAttempts.has(attemptKey)) continue;
        live.enqueuedAttempts.add(attemptKey);
        await this.enqueueJob(live, job);
      }
    }
    this.guard("drain", this.drainAvailable()); // best-effort; the periodic timer covers the rest
    await this.reportProgress(evalId);
    await this.finishIfDone(evalId);
    await this.scheduleRetryWake(evalId);
  }

  /** True when this eval has spent at or past its ceiling. No ceiling => never true. */
  private async overBudget(evalId: string): Promise<boolean> {
    const budget = (await this.deps.evalStore.getEvalRun(this.ctx(evalId), evalId))?.budget_usd;
    if (budget === null || budget === undefined) return false;
    return (await this.deps.evalStore.trueSpend(this.ctx(evalId), evalId)) >= budget;
  }

  /**
   * Wake once when the earliest backing-off retry comes due.
   *
   * Needed because pump() is otherwise driven purely by job exits, and a job waiting on a
   * backoff has no exit coming — without this the eval would sit forever with queued work
   * and idle slots. One timer for the earliest deadline, replaced each pump, so backoffs
   * never accumulate timers or spin.
   */
  private async scheduleRetryWake(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;
    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    if (live.cancelled) return;

    const jobs = await this.deps.evalStore.jobsForEval(this.ctx(evalId), evalId);
    const wakeIn = retryWakeIn(jobs, live.enqueuedAttempts, Date.now());
    if (wakeIn === null) return;
    live.retryTimer = setTimeout(() => {
      const l = this.live.get(evalId);
      if (l) l.retryTimer = null;
      this.guard("retry wake", this.pump(evalId));
    }, wakeIn);
  }

  /**
   * Tell the dispatcher a queued job exists. This is the whole of what used to be dispatch()
   * — it does NOT touch the pool, and does not know whether or when a slot will actually
   * open up. Fairness across workspaces is the dispatcher's job now, not a loop counting
   * pool.freeSlots one eval at a time.
   */
  private async enqueueJob(live: Live, job: EvalJob): Promise<void> {
    // The case as it was when the eval started. Only a job from before that copy existed reads the
    // dataset, and only that job can find its case gone.
    const input = job.input ?? (await this.deps.evalStore.getExample(this.ctx(live.evalId), job.example_id))?.input;
    if (input === undefined || input === null) {
      // Record it rather than skipping silently — a missing cell in the dashboard needs a reason.
      await this.deps.evalStore.finishJob(this.ctx(live.evalId), job.id, "failed", { error: "example no longer exists" });
      return;
    }
    const evalRun = (await this.deps.evalStore.getEvalRun(this.ctx(live.evalId), live.evalId))!;
    const payload: RunEvalPayload = {
      evalId: live.evalId,
      jobId: job.id,
      agentId: evalRun.agent_id,
      input,
      provider: job.provider,
      model: job.model,
      attempt: job.attempt,
    };
    this.jobToEval.set(job.id, live.evalId);
    await this.deps.dispatcher.enqueue("run.eval", this.ctx(live.evalId).workspaceId, payload, {
      id: job.id,
      idempotencyKey: `run.eval:${job.id}:${job.attempt}`,
      attempt: job.attempt,
    });
  }

  /**
   * Admit as many run.eval jobs as the dispatcher and this process's own pool both have room
   * for, right now, and start each one.
   *
   * WHY THIS LOOP AWAITS EACH START, AND WHY IT STOPS ON A REQUEUE.
   *
   * It used to do neither, and the combination was a livelock that took the whole process with
   * it. `pool.freeSlots` only moves once a job actually reaches tryStart, which is several awaits
   * into executeAdmitted — so a loop that fires each one off unawaited kept reading room it had
   * already spoken for. That alone is over-admission. The livelock is what happens next: a job
   * admitted with no provider slot left is put straight BACK on the queue, so the queue never
   * empties, and `freeSlots > 0` stays true because the provider cap (two, for a real provider)
   * is tighter than the eval pool (four). Admit, refuse, requeue, admit the same job again,
   * forever — and because every step of it resolves as a microtask, the event loop never reaches
   * a timer or a socket. Not a busy loop beside a working server: a wedged one. Any eval against
   * a real provider with more queued jobs than the provider cap did this.
   *
   * A requeue means the thing standing in the way is a lease held by a run that has not finished,
   * so no amount of asking again in this pass changes the answer. Stop, and let the next trigger
   * — a job exiting, or the 500 ms timer — ask again once something has actually changed.
   */
  private draining = false;

  private async drainAvailable(): Promise<void> {
    // Overlapping drains (the timer firing into one already running, two exits landing together)
    // do not admit twice — tryAdmit is atomic — but they do each add a full pass of round trips
    // to a queue that one pass is already walking.
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.deps.pool.freeSlots <= 0) return; // this process has nowhere to put another one
        const admission = await this.deps.dispatcher.tryAdmit<RunEvalPayload>("run.eval");
        if (!admission) return;
        const outcome = await this.executeAdmitted(admission.job, admission.leaseId);
        // "dropped" is progress — the queue got shorter and nothing went back on it.
        if (outcome === "requeued") return;
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * A job the dispatcher has fairly chosen. From here it either actually runs, or is put
   * straight back — never left admitted-but-stranded, which would hold its capacity hostage
   * for nothing.
   *
   * Reports which of the three it was, because drainAvailable's loop cannot tell them apart from
   * the outside and has to stop on one of them — see its own note.
   */
  private async executeAdmitted(
    job: QueueJob<RunEvalPayload>,
    leaseId: string,
  ): Promise<"started" | "dropped" | "requeued"> {
    const payload = job.payload;
    const live = this.live.get(payload.evalId);
    if (!live || live.cancelled) {
      // The eval finished or was cancelled between being enqueued and being admitted. Ack
      // and drop it — see cancel()'s note on why this is a lazy purge rather than an eager one.
      await this.deps.dispatcher.ack("run.eval", leaseId);
      return "dropped";
    }

    // The provider cap is GLOBAL now — every eval, every workspace, one shared count per
    // provider — where the old per-eval-instance map let two concurrent evals each get their
    // own budget against the same provider. Checked here, after a fair admit rather than
    // fused into it: see queue/semaphores.ts for why that composition is deliberate.
    const provLeaseId = randomUUID();
    const provSem = providerSemaphore(this.shared, "run.eval", payload.provider);
    if (!(await provSem.acquire(provLeaseId, PROVIDER_LEASE_TTL_MS))) {
      await this.deps.dispatcher.ack("run.eval", leaseId);
      await this.requeueVerbatim(job);
      return "requeued";
    }

    const runId = randomUUID();
    live.runToJob.set(runId, payload.jobId);
    this.leaseByRun.set(runId, {
      jobId: payload.jobId,
      dispatcherLeaseId: leaseId,
      provider: payload.provider,
      providerLeaseId: provLeaseId,
    });
    this.deps.markEvalRun(runId, true);

    // FROM HERE ON THIS RUN HOLDS TWO RESERVATIONS — the dispatcher's lease and the provider
    // slot — and something has to give them back on EVERY path out. The happy one is
    // onRunExit's; there is no exit event coming for a run that never started, so any throw
    // between here and a successful tryStart has to hand them back itself. Without this, one
    // failing markJobRunning (SQLITE_BUSY under exactly the concurrency this session is about)
    // silently retired one of the two provider slots a real provider gets, permanently.
    let started = false;
    try {
      await this.deps.evalStore.markJobRunning(this.ctx(payload.evalId), payload.jobId, runId, payload.attempt);
      const setup = (await this.deps.runSetup?.(payload.evalId, runId, { provider: payload.provider, agentId: payload.agentId })) ?? {};
      if (setup.refusal) {
        // It cannot start, and saying so is a failed job with the reason on it — the same ending a
        // spawn error gets, through the same path, so its leases come back exactly once.
        this.guard("refused run", this.onRunExit(runId, false, setup.refusal));
        return "started";
      }
      started = this.deps.pool.tryStart({
        runId,
        runtimeDir: this.deps.runtimeDir,
        agentId: payload.agentId,
        input: payload.input,
        timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
        ...(setup.workspaceId ? { workspaceId: setup.workspaceId } : {}),
        ...(setup.host ? { host: setup.host } : {}),
        env: {
          ...(setup.env ?? {}),
          JAROKU_RUN_ID: runId,
          JAROKU_PROVIDER: payload.provider,
          JAROKU_MODEL: payload.model,
        },
      });
    } catch (err) {
      live.runToJob.delete(runId);
      this.leaseByRun.delete(runId);
      this.deps.markEvalRun(runId, false);
      this.deps.releaseRun?.(runId);
      await provSem.release(provLeaseId);
      await this.deps.dispatcher.ack("run.eval", leaseId);
      // The row too, as the `!started` path below does: left `running` with nothing running it, a
      // cancel arriving before the retry would have nothing to stop and the eval would never end.
      await this.deps.evalStore.requeueJob(this.ctx(payload.evalId), payload.jobId).catch(() => {});
      await this.requeueVerbatim(job);
      throw err; // guard() logs it; the reservations are already back
    }

    // freeSlots > 0 in drainAvailable() only proves there was room a moment ago — another
    // caller of drainAvailable() (the periodic timer, another eval's own pump()) can win the
    // same slot in between. Undo everything and put the job back exactly as it was; no
    // attempt is consumed, because nothing ran.
    if (!started) {
      live.runToJob.delete(runId);
      this.leaseByRun.delete(runId);
      this.deps.markEvalRun(runId, false);
      this.deps.releaseRun?.(runId);
      await provSem.release(provLeaseId);
      await this.deps.dispatcher.ack("run.eval", leaseId);
      await this.deps.evalStore.requeueJob(this.ctx(payload.evalId), payload.jobId);
      await this.requeueVerbatim(job);
      return "requeued";
    }
    return "started";
  }

  /** Put an admitted-but-not-executed job straight back on the queue, unchanged — no attempt
   *  bump, no backoff. It didn't fail; there just wasn't room yet. */
  private async requeueVerbatim(job: QueueJob<RunEvalPayload>): Promise<void> {
    await this.deps.dispatcher.enqueue("run.eval", job.workspaceId, job.payload, {
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      attempt: job.attempt,
    });
  }

  private async onRunExit(runId: string, timedOut: boolean, spawnError: string | null): Promise<void> {
    // Release the dispatcher lease and the provider slot the moment the run is actually done,
    // regardless of how it turned out — a job that failed still frees the capacity it was
    // holding, and holding it any longer starves whatever is waiting behind it.
    //
    // BEFORE the "is this run's eval still live" check below, not after. Those are two different
    // questions: an eval can stop being live (finished, swept, cancelled and reconciled) while a
    // run it started is still winding down, and returning early on the second question used to
    // skip the release for the first — the run's provider slot then sat held until its own
    // three-and-a-half-minute TTL lapsed. A real provider gets two.
    const lease = this.leaseByRun.get(runId);
    if (lease) {
      this.leaseByRun.delete(runId);
      await this.deps.dispatcher.ack("run.eval", lease.dispatcherLeaseId);
      await providerSemaphore(this.shared, "run.eval", lease.provider).release(lease.providerLeaseId);
    }

    // Find the eval this run belongs to. Interactive runs match nothing and fall through.
    let live: Live | undefined;
    for (const l of this.live.values()) {
      if (l.runToJob.has(runId)) { live = l; break; }
    }
    if (!live) return;

    const jobId = live.runToJob.get(runId)!;
    live.runToJob.delete(runId);
    this.deps.markEvalRun(runId, false);

    const job = await this.deps.evalStore.getJob(this.ctx(live.evalId), jobId);

    // The run row is the source of truth for what happened — the runner brackets every
    // execution with run_start/run_end, so a contract violation or a mid-graph crash is
    // already recorded there as status 'error'.
    const run = await this.deps.store.getRun(this.ctx(live.evalId), runId);
    const status = timedOut
      ? "timed_out"
      : spawnError
        ? "failed"
        : run?.status === "completed"
          ? "succeeded"
          : "failed";
    const error = timedOut
      ? `timed out after ${DEFAULT_JOB_TIMEOUT_MS}ms`
      : (spawnError ?? run?.error ?? (run ? null : "the run produced no trace"));

    // Metrics come from the run's STEPS, not runs.cost — a run that died mid-graph never
    // emitted run_end, so its row reads 0 while its steps record what it really spent.
    // Recorded for failed and timed-out jobs too: partial spend is still spend, and the
    // budget ceiling has to see it.
    const metrics = await aggregateJob(
      this.ctx(live.evalId),
      this.deps.store,
      runId,
      job?.model ?? run?.model ?? "",
    );

    await this.deps.evalStore.finishJob(this.ctx(live.evalId), jobId, status as "succeeded" | "failed" | "timed_out", {
      error,
      cost_usd: metrics.cost_usd,
      tokens: metrics.tokens,
      latency_ms: metrics.latency_ms,
      cost_complete: metrics.cost_complete,
    });

    // Retry only what's worth paying to retry, and only while attempts remain. `finishJob`
    // above has already folded this attempt's spend into spent_usd, so the retry is
    // accounted for even though the job goes back on the queue.
    const attempt = (job?.attempt ?? 0) + 1;
    const retryable =
      status !== "succeeded" &&
      !live.cancelled &&
      attempt < MAX_ATTEMPTS &&
      isTransientFailure(error, timedOut) &&
      // Never spend past EITHER ceiling to retry. A retry is another start, and the workspace's
      // limit binds it exactly as the eval's own does — without this, a workspace that ran out
      // mid-eval would keep paying for attempts on the jobs that happened to fail.
      !(await this.overBudget(live.evalId)) &&
      ((await this.deps.workspaceOverBudget?.(live.evalId)) ?? null) === null;

    if (retryable) {
      // Exponential backoff: a rate limit retried immediately is a rate limit again.
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      await this.deps.evalStore.retryJob(this.ctx(live.evalId), jobId, attempt, new Date(Date.now() + delay));
      console.log(
        `[eval] job ${jobId.slice(0, 8)} attempt ${attempt}/${MAX_ATTEMPTS} in ${delay}ms — ${error}`,
      );
    } else {
      const finished = await this.deps.evalStore.getJob(this.ctx(live.evalId), jobId);
      if (finished) this.deps.onJobFinished?.(finished);
    }

    // One failed job is one failed cell — keep draining.
    await this.pump(live.evalId);
  }

  private async counts(evalId: string) {
    const jobs = await this.deps.evalStore.jobsForEval(this.ctx(evalId), evalId);
    const by = (s: string) => jobs.filter((j) => j.status === s).length;
    const terminal = jobs.filter(
      (j) => j.status !== "queued" && j.status !== "running",
    ).length;
    return {
      total: jobs.length,
      done: terminal,
      running: by("running"),
      queued: by("queued"),
      failed: by("failed") + by("timed_out"),
      succeeded: by("succeeded"),
      cancelled: by("cancelled"),
    };
  }

  /**
   * What each live eval had spent when its last progress event went out.
   *
   * The delta is computed here rather than by the client, because `trueSpend` is the authority on
   * what an eval has cost — every attempt plus the judge — and a client subtracting two totals it
   * was sent would be a second implementation of that. Removed when the eval finishes, so this is
   * bounded by "evals running right now" exactly as `live` is.
   */
  private reportedSpend = new Map<string, number>();

  private async reportProgress(evalId: string): Promise<void> {
    const spent = await this.deps.evalStore.trueSpend(this.ctx(evalId), evalId).catch(() => 0);
    const before = this.reportedSpend.get(evalId) ?? 0;
    this.reportedSpend.set(evalId, spent);
    this.deps.onProgress({
      evalId,
      ...(await this.counts(evalId)),
      // Clamped at zero: `trueSpend` only grows, and a negative delta would be a client subtracting
      // money from a figure the ledger already justified.
      spentDeltaUsd: Math.max(0, spent - before),
    });
  }

  private async finishIfDone(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;
    const c = await this.counts(evalId);
    if (c.done < c.total) return;

    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    this.live.delete(evalId);
    this.reportedSpend.delete(evalId);
    await this.shared.releaseSemaphore(evalClaimKey(live.workspaceId), evalClaimHolder(evalId, this.replicaId));
    // A budget abort already recorded its own status and reason; don't overwrite it with
    // the generic "cancelled", which would lose why the eval stopped.
    const current = (await this.deps.evalStore.getEvalRun(this.ctx(evalId), evalId))?.status;
    const status =
      current === "aborted_over_budget" ? current : live.cancelled ? "cancelled" : "completed";
    if (current !== "aborted_over_budget") await this.deps.evalStore.setEvalStatus(this.ctx(evalId), evalId, status);
    console.log(
      `[eval] ${evalId} ${status} — ${c.succeeded}/${c.total} succeeded, ${c.failed} failed, ${c.cancelled} cancelled`,
    );
    this.deps.onFinished({ evalId, status });
  }
}
