// The Evals tab: build a dataset, run it across providers, read the comparison.
//
// One tab with two modes rather than two tabs, because they're the same task at different
// stages — you build a dataset in order to run it, and you come back to the dataset when
// the results tell you what's missing. The mode auto-follows the work: starting an eval
// switches to Results, and an agent with no dataset yet lands on Dataset.

import { useEffect, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { datasetsOf, evalListKey, liveEvalOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendListDatasets, sendListEvals, sendLoadEvalResults, sendLoadJudge, sendRetryEval, sendSetJudgeOwnKey } from "../lib/socket.ts";
import { parseCeiling, suggestedCeiling } from "./EvalRunBar.tsx";
import { useCanRun } from "../lib/useCapability.ts";
import { useUiStore } from "../store/uiStore.ts";
import { DatasetBuilder } from "./DatasetBuilder.tsx";
import { ComparisonTable } from "./EvalDashboard.tsx";
import { ExampleDrillDown } from "./EvalDrillDown.tsx";
import { EvalRunBar } from "./EvalRunBar.tsx";
import { EvalUndoToast } from "./EvalUndoToast.tsx";
import { EvalCompare } from "./EvalCompare.tsx";
import { relTime } from "../lib/format.ts";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ActivityIcon, DatabaseIcon } from "./panelIcons.tsx";
import { ICON } from "../lib/tokens.ts";
import { Icon } from "../lib/icons/registry.ts";
import { EVAL_PHASE } from "../lib/domainPhase.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import type { EvalResults, EvalRunStatus } from "../types.ts";
import type { EvalProgress } from "../store/evalStore.ts";
import { fmtBudget, fmtCost } from "../lib/format.ts";

/**
 * This panel's word for each eval status, beside the phase's shape.
 *
 * "over budget" IS THE ONE THAT MATTERS. `aborted_over_budget` maps to `failed` — it did not finish
 * and it did not succeed — but a reader comparing two runs needs to know that the second one stopped
 * itself at a ceiling rather than breaking, and that is a sentence rather than a shape.
 */
const EVAL_WORD: Record<EvalRunStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  aborted_over_budget: "over budget",
  cancelled: "cancelled",
  error: "error",
};

/**
 * One line that says whose eval this is and how it went, over the comparison.
 *
 * NOTHING ON THE PANEL NAMED THE AGENT OR THE DATASET, and the status lived only in a strip of glyphs
 * that was drawn for two or more evals — so a single eval that had completed, been cancelled, stopped
 * over budget or stalled looked the same, and another agent's results could sit here unannounced. The
 * stop reason the server records ("stopped after $0.0048 of a $0.0010 budget", a workspace ceiling,
 * a restart) was on the row and nowhere else.
 */
export function ResultsHeader({ results, live }: { results: EvalResults; live: EvalProgress | null }) {
  const agentName = useBuildStore((s) => s.agents.find((a) => a.agent_id === results.agentId)?.name ?? results.agentId);
  const status = (live && live.evalId === results.evalId && live.status === undefined ? "running" : results.status) as EvalRunStatus;
  const word = EVAL_WORD[status] ?? status;
  // Each with its effort when it had one, so two comparisons at different levels are told apart.
  const models = (results.targets ?? results.providers).map((t) => ("effort" in t && t.effort ? `${t.model} (${t.effort})` : t.model));
  const { totals } = results;
  return (
    <div className="space-y-1 pb-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-caption">
        <span className="text-ink">{agentName}</span>
        {results.agentVersion != null && <span className="text-tiny text-faint">v{results.agentVersion}</span>}
        <span className="text-faint">·</span>
        <span className="min-w-0 truncate text-muted" title={results.datasetName ?? undefined}>
          {results.datasetName ?? "a deleted dataset"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-tiny text-muted">
        <span className="inline-flex items-center gap-1 text-ink">
          <StatusGlyph phase={EVAL_PHASE[status] ?? "pending"} size={ICON.xs} title={word} />
          {word}
        </span>
        <span title={results.startedAt}>{relTime(results.startedAt)}</span>
        <span className="tabular-nums">
          {fmtCost(totals.trueSpendUsd)} spent{totals.budgetUsd !== null ? ` of ${fmtBudget(totals.budgetUsd)}` : ""}
        </span>
        <span className="min-w-0 truncate" title={models.join(", ")}>{models.join(" · ")}</span>
      </div>
      {results.stopReason && status !== "completed" && status !== "running" && (
        <div className="text-tiny text-muted">{results.stopReason}</div>
      )}
    </div>
  );
}

/**
 * Whether Quality will be filled in, and the one control that fills it.
 *
 * A "—" IN EVERY QUALITY CELL, WITH NOTHING TO DO ABOUT IT. Production has no platform judge key, so
 * every eval came back unscored, and nothing on the panel led anywhere that could change that. The
 * workspace's own Anthropic key can judge, if somebody allowed to decide whose key pays says so.
 */
/**
 * What can be done with a finished eval: run its unfinished cells again, or run the whole thing again.
 *
 * NEITHER EXISTED. A budget stop that cancelled thirteen cells could only be followed by a new eval
 * of all fifteen, and repeating an eval meant choosing its models and ceiling again by hand.
 */
export function EvalActions({ results }: { results: EvalResults }) {
  const [retrying, setRetrying] = useState(false);
  const [ceiling, setCeiling] = useState("");
  const live = useEvalStore((s) => s.progressByEval[results.evalId]);
  const datasets = useEvalStore((s) => datasetsOf(s.datasetsByAgent, results.agentId));
  const finished = !["running", "queued"].includes(results.status) && !(live && (live.status === undefined || live.scoring));
  if (!finished) return null;
  const cells = results.rows.flatMap((r) => r.cells);
  // A case that is gone cannot run again, so it is not offered: retried, it only failed at once.
  const again = results.rows.filter((r) => !r.caseGone).flatMap((r) => r.cells)
    .filter((c) => ["failed", "timed_out", "cancelled"].includes(c.status)).length;
  const ran = cells.filter((c) => ["succeeded", "failed", "timed_out"].includes(c.status)).length;
  const { totals } = results;
  // WHAT THE RETRY WILL NEED: the spend so far, plus the cells left at what a cell has cost.
  const need = totals.trueSpendUsd + (ran ? totals.agentSpendUsd / ran : 0) * again;
  const spentOut = totals.budgetUsd !== null && totals.budgetUsd <= need;
  const parsed = spentOut ? parseCeiling(ceiling || suggestedCeiling(need)) : null;
  const datasetHere = datasets.some((d) => d.id === results.datasetId);

  const runAgain = (): void => {
    const store = useEvalStore.getState();
    store.setTargets(results.agentId, results.targets ?? results.providers.map((p) => ({ provider: p.provider, model: p.model })));
    store.selectDataset(results.agentId, results.datasetId);
    store.setMode(results.agentId, "dataset");
    store.requestEstimate(results.agentId);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pb-3 text-tiny">
      {again > 0 && !retrying && (
        <button
          onClick={() => (spentOut ? setRetrying(true) : sendRetryEval(results.evalId, results.agentId, totals.budgetUsd))}
          className="rounded-control bg-active px-2 py-1 text-ink transition-opacity hover:opacity-80"
          title="Run the failed, timed-out and cancelled cells again, inside this eval"
        >
          Retry {again} cell{again === 1 ? "" : "s"}
        </button>
      )}
      {retrying && parsed && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">Its ceiling is spent — retry with Stop at $</span>
          <input
            value={ceiling || suggestedCeiling(need)}
            onChange={(e) => setCeiling(e.target.value)}
            aria-label="New ceiling for the retry, in dollars"
            inputMode="decimal"
            className="w-16 rounded-input border border-edge bg-elevated px-1.5 py-0.5 tabular-nums text-ink outline-none focus:shadow-focusring"
          />
          <button
            disabled={"error" in parsed}
            title={"error" in parsed ? parsed.error : undefined}
            onClick={() => { if ("usd" in parsed) sendRetryEval(results.evalId, results.agentId, parsed.usd); setRetrying(false); }}
            className="rounded-control bg-active px-2 py-1 text-ink disabled:opacity-30"
          >
            Retry
          </button>
          <button onClick={() => setRetrying(false)} className="text-faint hover:text-ink">Cancel</button>
        </span>
      )}
      {datasetHere && (
        <button
          onClick={runAgain}
          className="rounded-control px-2 py-1 text-muted transition-colors hover:bg-active hover:text-ink"
          title="Choose the same models and open the estimate for a new eval of this dataset as it is now"
        >
          Run again
        </button>
      )}
    </div>
  );
}

/**
 * What the server refused, on Results as well as on Dataset.
 *
 * RETRY AND RUN AGAIN ARE PRESSED HERE, and their refusals ("28 of 20 eval runs per month used…")
 * were drawn only on the Dataset half — so on Results the button did nothing at all, as far as
 * anybody could see.
 */
export function EvalRefusal() {
  const error = useEvalStore((s) => s.error);
  const setError = useEvalStore((s) => s.setError);
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 pb-3 text-tiny" role="alert">
      <span className="text-err">{error}</span>
      <button
        onClick={() => setError(null)}
        title="Dismiss"
        aria-label="Dismiss"
        className="ml-auto shrink-0 text-faint transition-colors duration-fast hover:text-ink"
      >
        <Icon.global.dismissNotice size={ICON.xs} />
      </button>
    </div>
  );
}

/**
 * Which dataset a past eval ran on, as the strip and the compare picker say it: the name it ran
 * under, or — for an eval from before that was kept — the dataset's name now, or that it is gone.
 * Without it, two evals from one afternoon on two datasets both read only "4d ago".
 */
export function evalDatasetLabel(
  e: { dataset_id: string; dataset_name?: string | null; dataset_gone?: boolean },
  datasets: { id: string; name: string }[],
): string | null {
  if (e.dataset_name) return e.dataset_gone ? `${e.dataset_name} · deleted` : e.dataset_name;
  const now = datasets.find((d) => d.id === e.dataset_id)?.name;
  if (now) return now;
  return e.dataset_gone ? "a deleted dataset" : null;
}

export function JudgeLine() {
  const judge = useEvalStore((s) => s.judge);
  const canSwitch = useCanRun("setJudgeOwnKey");
  if (!judge) return null;
  if (judge.enabled) {
    if (judge.source !== "own-key" || !judge.ownKey) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 pb-3 text-tiny text-faint">
        <span>Quality is judged on this workspace's Anthropic key.</span>
        {canSwitch && (
          <button onClick={() => sendSetJudgeOwnKey(false)} className="text-muted underline underline-offset-2 transition-colors hover:text-ink">
            Turn off
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3 text-tiny" role="status">
      <span className="text-muted">Quality isn't scored — the judge is off.</span>
      {!judge.keyPresent ? (
        <button
          onClick={() => useUiStore.getState().openSecretsForProvider("anthropic")}
          className="text-ink underline underline-offset-2"
        >
          Add an Anthropic key in Secrets →
        </button>
      ) : canSwitch ? (
        <button
          onClick={() => sendSetJudgeOwnKey(true)}
          title="Score answers with this workspace's Anthropic key. It is used for the judge and nothing else."
          className="text-ink underline underline-offset-2"
        >
          Judge with my Anthropic key
        </button>
      ) : (
        <span className="text-faint">An admin can turn on judging with the workspace's Anthropic key.</span>
      )}
    </div>
  );
}

type Mode = "dataset" | "results";

export function EvalsPanel() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  // EVERYTHING BELOW IS THIS AGENT'S. These were single values for the whole tab, so another agent's
  // running eval — its table, its cases, its `running 2/12` — was what this agent's Results showed.
  const selectedDatasetId = useEvalStore((s) => (activeAgentId ? (s.selectedDatasetByAgent[activeAgentId] ?? null) : null));
  const agentDatasets = useEvalStore((s) => datasetsOf(s.datasetsByAgent, activeAgentId));
  const hasDatasets = agentDatasets.length > 0;
  const selectedEvalId = useEvalStore((s) => (activeAgentId ? (s.selectedEvalByAgent[activeAgentId] ?? null) : null));
  const selectEval = useEvalStore((s) => s.selectEval);
  const resultsByEval = useEvalStore((s) => s.resultsByEval);
  const progress = useEvalStore((s) => liveEvalOf(s.progressByEval, activeAgentId));

  // THIS AGENT'S HALF OF THE TAB, kept in the store: a trip to a cell's trace and back used to land
  // on Dataset, because the choice lived in a component that the trip unmounted.
  const mode: Mode = useEvalStore((s) => (activeAgentId ? (s.modeByAgent[activeAgentId] ?? "dataset") : "dataset"));
  const setMode = (m: Mode): void => { if (activeAgentId) useEvalStore.getState().setMode(activeAgentId, m); };
  /**
   * Which history the strip shows: the open dataset's, or every eval of this agent.
   *
   * THE SECOND IS HOW A DELETED DATASET'S EVALS ARE REACHED. The strip only ever listed the open
   * dataset's evals, so deleting a dataset made its evals unreachable from the tab for good — they were
   * in the database, readable, and there was no dataset left to open them from. With no dataset at all
   * there is nothing else to show, so that is the scope.
   */
  const [allDatasets, setAllDatasets] = useState(false);
  const scopeDataset = allDatasets || !selectedDatasetId ? null : selectedDatasetId;
  const list = useEvalStore((s) => (activeAgentId ? s.evalLists[evalListKey(activeAgentId, scopeDataset)] : undefined));
  const evals = list?.evals ?? [];
  /**
   * How many past evals the strip is showing.
   *
   * TWO CEILINGS USED TO SIT ON TOP OF EACH OTHER HERE, and both were unreachable: the server read
   * the newest fifty with no way to ask past it, and this strip then rendered the first SIX of those
   * — so the seventh-newest comparison could not be selected at all, in the panel whose entire job is
   * comparing. This is the local half; the window below is the server's.
   */
  const [shown, setShown] = useState(6);
  const shownEvalId = selectedEvalId ?? evals[0]?.id ?? null;
  const results = shownEvalId ? resultsByEval[shownEvalId] : undefined;
  // WHAT CHANGED SINCE: the eval the shown one is compared with, when one is chosen.
  const compareWith = useEvalStore((s) => (activeAgentId ? (s.compareWithByAgent[activeAgentId] ?? null) : null));
  const [picking, setPicking] = useState(false);
  const comparing = compareWith && compareWith !== shownEvalId ? resultsByEval[compareWith] : undefined;
  const running = progress !== null && (progress.status === undefined || progress.scoring === true);

  // Whether Quality will be scored here — asked once the socket is up.
  useEffect(() => {
    if (connected) sendLoadJudge();
  }, [connected]);

  // THE AGENT'S DATASETS, WHICHEVER HALF IS OPEN. Only the Dataset half asked for them, so Results
  // reached straight from the Activity feed or a trace had none: no Run again, no switch to every
  // dataset's evals, and a header that could not name an old eval's dataset.
  useEffect(() => {
    if (connected && activeAgentId) sendListDatasets(activeAgentId);
  }, [connected, activeAgentId]);

  // Past evals for this scope, so a finished comparison stays reachable.
  useEffect(() => {
    if (connected && activeAgentId) sendListEvals(activeAgentId, scopeDataset, list?.window);
  }, [connected, activeAgentId, scopeDataset]);

  // An eval starting is the moment the results view becomes the thing to look at — for whoever
  // started it. Another member's eval on this agent shows as running here, and does not take the panel.
  useEffect(() => {
    if (progress && progress.status === undefined && progress.startedHere) setMode("results");
  }, [progress?.evalId]);

  useEffect(() => {
    if (connected && shownEvalId && !resultsByEval[shownEvalId]) sendLoadEvalResults(shownEvalId);
  }, [connected, shownEvalId]);
  useEffect(() => {
    if (connected && compareWith && !resultsByEval[compareWith]) sendLoadEvalResults(compareWith);
  }, [connected, compareWith]);

  if (!activeAgentId) {
    return (
      <EmptyState
        icon={DatabaseIcon}
        title="No agent selected"
        hint="Pick one in the sidebar to build it a dataset and compare providers on it."
      />
    );
  }

  // A TWO-SEGMENT ICON TOGGLE, NOT A SECOND ROW OF TEXT TABS.
  //
  // This used to be `Dataset` / `Results` as words on their own row, directly beneath the right
  // panel's own ten-word tab strip — two stacked tab strips in two different visual languages,
  // which was the densest chrome in the product. The strip above is a glyph rail now, and this is
  // two glyphs: a database for what goes in, a chart for what came out.
  const tab = (m: Mode, label: string, Icon: (p: { size?: number }) => React.ReactElement) => (
    <button
      onClick={() => setMode(m)}
      title={label}
      aria-label={label}
      aria-pressed={mode === m}
      className={`flex h-7 w-7 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
        mode === m ? "bg-active text-accent" : "text-muted hover:bg-active/40 hover:text-ink"
      }`}
    >
      <Icon size={ICON.sm} />
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <EvalUndoToast />
      <div className="flex shrink-0 items-center gap-1 border-b border-hair px-4 pb-2 pt-1">
        {tab("dataset", "Dataset", DatabaseIcon)}
        {tab("results", "Results", ActivityIcon)}
        {running && (
          <span className="ml-2 text-tiny text-run animate-stream-pulse motion-reduce:animate-none">
            {progress.scoring && progress.status ? "scoring…" : `running ${progress.done}/${progress.total}`}
          </span>
        )}
      </div>

      {mode === "dataset" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0"><DatasetBuilder /></div>
          <EvalRunBar />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          <EvalRefusal />
          {/* Past evals — a comparison keeps its value after the run that produced it. Shown with a
              single eval too: the scope switch is the only way to a deleted dataset's evals, and
              hiding it until this dataset had two left them out of reach. */}
          {(evals.length > 0 || allDatasets || (hasDatasets && selectedDatasetId)) && (
            <div className="flex flex-wrap items-center gap-1.5 pb-3">
              {/* WHICH HISTORY. Only offered while there is a dataset to narrow to. */}
              {hasDatasets && selectedDatasetId && (
                <button
                  onClick={() => { setAllDatasets((v) => !v); setShown(6); }}
                  aria-pressed={allDatasets}
                  title={allDatasets ? "Show only this dataset's evals" : "Show this agent's evals on every dataset, including deleted ones"}
                  className="rounded-control px-2 py-1 text-tiny text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
                >
                  {allDatasets ? "All datasets" : "This dataset"}
                </button>
              )}
              {evals.slice(0, shown).map((e) => (
                <Chip
                  key={e.id}
                  onClick={() => activeAgentId && selectEval(activeAgentId, e.id)}
                  selected={e.id === shownEvalId}
                  tone="faint"
                  title={`${EVAL_WORD[e.status]} · ${e.targets.map((t) => t.model).join(", ")}${e.dataset_name ? ` · ${e.dataset_name}${e.dataset_gone ? " (deleted)" : ""}` : ""}`}
                  icon={<StatusGlyph phase={EVAL_PHASE[e.status]} size={ICON.xs} title={EVAL_WORD[e.status]} />}
                >
                  {relTime(e.started_at)}
                  {/* ACROSS DATASETS, each names its own — and says when that dataset is gone. */}
                  {scopeDataset === null && evalDatasetLabel(e, agentDatasets) && (
                    <span className="text-muted">{evalDatasetLabel(e, agentDatasets)}</span>
                  )}
                  {/* THE WORD IS NO LONGER COLOURED. It was `text-err` for one status and
                      `text-muted` for the rest — a status word rendered as coloured text, which is
                      the second of the three things §2.5 removes. The glyph carries the state now
                      and the word carries which state, which is the division I8 asks for. */}
                  {e.status !== "completed" && <span className="text-muted">{EVAL_WORD[e.status]}</span>}
                </Chip>
              ))}
              {/* COMPARE WITH ANOTHER EVAL — the regression question, "what changed since then". */}
              {shownEvalId && evals.length > 1 && !picking && (
                <button
                  onClick={() => setPicking(true)}
                  className="rounded-control px-2 py-1 text-tiny text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
                  title="Line this eval up against an earlier one: each model's figures, and every case whose outcome changed"
                >
                  Compare with…
                </button>
              )}
              {/* OLDER COMPARISONS. It widens the strip first and then asks the server for a bigger
                  window when the loaded ones run out, so one control answers "show me more" whichever
                  of the two ceilings is the one in the way. It disappears when both are exhausted. */}
              {(shown < evals.length || (list !== undefined && !list.complete)) && (
                <button
                  onClick={() => {
                    if (shown < evals.length) setShown(shown + 12);
                    else if (activeAgentId) sendListEvals(activeAgentId, scopeDataset, Math.min((list?.window ?? 50) * 2, 500));
                  }}
                  className="rounded-control px-2 py-1 text-tiny text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
                >
                  older…
                </button>
              )}
            </div>
          )}

          {picking && activeAgentId && (
            <div className="flex flex-wrap items-center gap-1.5 pb-3 text-tiny" role="group" aria-label="Compare with an earlier eval">
              <span className="text-faint">Compare with</span>
              {evals.filter((e) => e.id !== shownEvalId).slice(0, 12).map((e) => (
                <Chip
                  key={e.id}
                  tone="faint"
                  onClick={() => { useEvalStore.getState().setCompareWith(activeAgentId, e.id); setPicking(false); }}
                  title={`${EVAL_WORD[e.status]} · ${e.targets.map((t) => t.model).join(", ")}`}
                >
                  {relTime(e.started_at)}
                  {/* WHICH ONE: two from the same afternoon both read "4d ago". */}
                  {evalDatasetLabel(e, agentDatasets) && <span className="text-muted">{evalDatasetLabel(e, agentDatasets)}</span>}
                  {e.status !== "completed" && <span className="text-muted">{EVAL_WORD[e.status]}</span>}
                </Chip>
              ))}
              <button onClick={() => setPicking(false)} className="text-faint hover:text-ink">Cancel</button>
            </div>
          )}

          {progress && !progress.status && progress.evalId === shownEvalId && (
            <div className="text-tiny text-muted pb-3">
              {progress.done}/{progress.total} runs done · {progress.running} in flight
              {progress.queued > 0 && ` · ${progress.queued} queued`}
              {progress.failed > 0 && <span className="text-err"> · {progress.failed} failed</span>}
            </div>
          )}

          {results ? (
            <>
              <ResultsHeader results={results} live={progress} />
              <EvalActions results={results} />
              <JudgeLine />
              {comparing && activeAgentId && (
                // Older first, whichever was picked: "before → after" reads in time order.
                Date.parse(comparing.startedAt) <= Date.parse(results.startedAt)
                  ? <EvalCompare before={comparing} after={results} against={comparing} onClose={() => useEvalStore.getState().setCompareWith(activeAgentId, null)} />
                  : <EvalCompare before={results} after={comparing} against={comparing} onClose={() => useEvalStore.getState().setCompareWith(activeAgentId, null)} />
              )}
              <ComparisonTable results={results} />
              <ExampleDrillDown results={results} />
            </>
          ) : (
            <EmptyState
              size="line"
              icon={DatabaseIcon}
              title="No results yet"
              hint="Pick providers under the dataset and run it — quality, cost and latency land here side by side."
            />
          )}
        </div>
      )}
    </div>
  );
}
