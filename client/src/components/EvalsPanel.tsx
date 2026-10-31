// The Evals tab: build a dataset, run it across providers, read the comparison.
//
// One tab with two modes rather than two tabs, because they're the same task at different
// stages — you build a dataset in order to run it, and you come back to the dataset when
// the results tell you what's missing. The mode auto-follows the work: starting an eval
// switches to Results, and an agent with no dataset yet lands on Dataset.

import { useEffect, useMemo, useState } from "react";
import { compareEvals } from "../lib/evalCompare.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { datasetsOf, evalListKey, liveEvalOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendListDatasets, sendListEvals, sendLoadEvalResults, sendLoadJudge, sendRetryEval, sendSetJudgeOwnKey } from "../lib/socket.ts";
import { parseCeiling, suggestedCeiling } from "./EvalRunBar.tsx";
import { useCanRun } from "../lib/useCapability.ts";
import { useUiStore } from "../store/uiStore.ts";
import { DatasetBuilder } from "./DatasetBuilder.tsx";
import { ComparisonTable, EXPORTS, saveExport } from "./EvalDashboard.tsx";
import { CriterionBreakdown, ExampleDrillDown } from "./EvalDrillDown.tsx";
import { EvalRunBar } from "./EvalRunBar.tsx";
import { EvalUndoToast } from "./EvalUndoToast.tsx";
import { EvalCompare } from "./EvalCompare.tsx";
import { absTime, relTime } from "../lib/format.ts";
import { evalDuration, verdict } from "../lib/evalView.ts";
import { EmptyState } from "./EmptyState.tsx";
import { DatabaseIcon } from "./panelIcons.tsx";
import { Chosen, EVAL_SELECT, FACT_TONE, FactPill, ModelLabel, SOFT_ICON, SOFT_ICON_XS, type PillTone } from "./evalUi.tsx";
import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { modelName, useProviderStore } from "../store/providerStore.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Tip } from "./ui/tooltip.tsx";
import { ICON, STATUS, TYPE } from "../lib/tokens.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { EVAL_PHASE } from "../lib/domainPhase.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import type { EvalResults, EvalRunStatus, EvalRunSummary } from "../types.ts";
import type { EvalProgress } from "../store/evalStore.ts";

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
export function ResultsHeader({ results, live, actions }: {
  results: EvalResults;
  live: EvalProgress | null;
  /** The eval's own actions, beside its outcome — as the trace's run actions sit beside its pill. */
  actions?: React.ReactNode;
}) {
  const agentName = useBuildStore((s) => s.agents.find((a) => a.agent_id === results.agentId)?.name ?? results.agentId);
  const liveHere = live !== null && live.evalId === results.evalId && live.status === undefined;
  const status = (liveHere ? "running" : results.status) as EvalRunStatus;
  // Each leg as the run bar chose it, with its effort when it had one, so two comparisons at
  // different levels are told apart.
  const legs = (results.targets ?? results.providers).map((t) => ({
    provider: t.provider,
    model: t.model,
    effort: "effort" in t ? (t.effort ?? null) : null,
  }));
  const duration = evalDuration(results);
  // HEADED AS A RUN IS IN THE TRACE: what this is and its outcome on the first line, the facts that
  // identify it as round chips on the second — each behind its own mark, so the row is read by its
  // marks before its words — and the models it compared as a third, each behind its provider's mark.
  return (
    // AN EDITOR'S DOCUMENT HEADER: what this is and how it ended, the facts that identify it, and what
    // it compared — set off from the figures under it by a hairline.
    <div className="mb-3 border-b border-hair pb-3">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* THE NAME KEEPS ITS LINE: on a narrow panel the outcome and the actions wrap under it rather
            than squeezing it to its first word. */}
        <span className="flex min-w-[9rem] flex-[1_1_12rem] items-center gap-2" title={results.datasetName ?? undefined}>
          <Icon.evals.datasetView size={ICON.sm} className="shrink-0 text-reviewed" />
          <span className="min-w-0 truncate text-title text-ink">{results.datasetName ?? "a deleted dataset"}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <EvalOutcomePill status={status} detail={liveHere ? `${live.done} of ${live.total}` : null} />
          {actions}
        </span>
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-tiny text-muted">
        <Tip label="The agent, and the version of it this eval ran against">
          <FactPill icon={Icon.evals.agent} tone={FACT_TONE.agent}>
            {agentName}{results.agentVersion != null ? ` v${results.agentVersion}` : ""}
          </FactPill>
        </Tip>
        <Tip label={absTime(results.startedAt)}>
          <FactPill icon={Icon.evals.when} tone={FACT_TONE.when}>{relTime(results.startedAt)}</FactPill>
        </Tip>
        {duration && (
          <Tip label="How long the eval took, from its first run to its last">
            <FactPill icon={Icon.evals.duration} tone={FACT_TONE.runs}>{duration}</FactPill>
          </Tip>
        )}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-caption text-ink" aria-label="Models compared">
        {legs.map((t) => (
          <span key={`${t.provider} ${t.model}`} className="inline-flex h-6 max-w-full items-center rounded-control border border-edge bg-elevated px-2">
            <ModelLabel provider={t.provider} model={t.model} effort={t.effort} />
          </span>
        ))}
      </div>
      {results.stopReason && status !== "completed" && status !== "running" && (
        <Alert tone="info" className="mt-2 items-start py-1.5">
          <Icon.evals.refused size={ICON.xs} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{results.stopReason}</span>
        </Alert>
      )}
    </div>
  );
}

/**
 * What can be done with an eval: export it, run its unfinished cells again, or run it all again.
 *
 * RETRY AND RUN AGAIN DID NOT EXIST. A budget stop that cancelled thirteen cells could only be
 * followed by a new eval of all fifteen, and repeating an eval meant choosing its models and
 * ceiling again by hand. They sit beside the outcome now, drawn as the trace's run actions are: the
 * next thing to do as the one filled button, the rest as marks on a grey ground. Export lived at the
 * foot of the table as a word; it is a mark here, and it is there while an eval is still running.
 */
export function EvalActions({ results }: { results: EvalResults }) {
  const [retrying, setRetrying] = useState(false);
  const [ceiling, setCeiling] = useState("");
  const live = useEvalStore((s) => s.progressByEval[results.evalId]);
  const datasets = useEvalStore((s) => datasetsOf(s.datasetsByAgent, results.agentId));
  const agentName = useBuildStore((s) => s.agents.find((a) => a.agent_id === results.agentId)?.name);
  const finished = !["running", "queued"].includes(results.status) && !(live && (live.status === undefined || live.scoring));
  // Every caveat survives the trip — unknown cost is an empty cell with a cost_known flag beside it,
  // never a 0 a spreadsheet would happily sum — and the download says where it went.
  const exportMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={SOFT_ICON} aria-label="Export these results" title="Export these results">
          <Icon.evals.exportCsv size={ICON.sm} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent edge="strong" align="end">
        {EXPORTS.map((x) => (
          <DropdownMenuItem key={x.label} onSelect={() => saveExport(results, x, agentName)}>
            {x.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (!finished) return <span className="flex items-center gap-1" role="group" aria-label="Eval actions">{exportMenu}</span>;
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
    <span className="flex flex-wrap items-center gap-1 text-tiny" role="group" aria-label="Eval actions">
      {again > 0 && !retrying && (
        <Button
          size="sm"
          onClick={() => (spentOut ? setRetrying(true) : sendRetryEval(results.evalId, results.agentId, totals.budgetUsd))}
          title={`Retry ${again} cell${again === 1 ? "" : "s"} — the failed, timed-out and cancelled ones, inside this eval`}
        >
          <Icon.graph.retry size={ICON.sm} />
          Retry {again}
        </Button>
      )}
      {retrying && parsed && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">Its ceiling is spent — retry with Stop at $</span>
          <Input
            value={ceiling || suggestedCeiling(need)}
            onChange={(e) => setCeiling(e.target.value)}
            aria-label="New ceiling for the retry, in dollars"
            inputMode="decimal"
            className="w-16 px-1.5 text-tiny tabular-nums"
          />
          <Button
            size="sm"
            disabled={"error" in parsed}
            title={"error" in parsed ? parsed.error : undefined}
            onClick={() => { if ("usd" in parsed) sendRetryEval(results.evalId, results.agentId, parsed.usd); setRetrying(false); }}
          >
            Retry
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setRetrying(false)}>Cancel</Button>
        </span>
      )}
      {datasetHere && (
        <button
          type="button"
          onClick={runAgain}
          className={SOFT_ICON}
          aria-label="Run again"
          title="Run again — the same models, and the estimate for a new eval of this dataset as it is now"
        >
          <Icon.cockpit.refresh size={ICON.sm} />
        </button>
      )}
      {exportMenu}
    </span>
  );
}


/**
 * A notice on Results — a refusal, the judge's state — as one construction: a card in the trace's
 * surface, its sentence, and what can be done about it. They were three differently spaced lines of
 * small text, one of them red, stacked over the table.
 */
const NOTICE = "mb-3";

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
    <Alert tone="destructive" className={NOTICE} role="alert">
      <Icon.evals.refused size={ICON.sm} className="shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      <button type="button" onClick={() => setError(null)} title="Dismiss" aria-label="Dismiss" className={SOFT_ICON_XS}>
        <Icon.global.dismissNotice size={ICON.xs} />
      </button>
    </Alert>
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

/**
 * Whether Quality will be filled in, and the one control that fills it.
 *
 * A "—" IN EVERY QUALITY CELL, WITH NOTHING TO DO ABOUT IT. Production has no platform judge key, so
 * every eval came back unscored, and nothing on the panel led anywhere that could change that. The
 * workspace's own Anthropic key can judge, if somebody allowed to decide whose key pays says so.
 */
export function JudgeLine() {
  const judge = useEvalStore((s) => s.judge);
  const canSwitch = useCanRun("setJudgeOwnKey");
  if (!judge) return null;
  if (judge.enabled) {
    if (judge.source !== "own-key" || !judge.ownKey) return null;
    return (
      <Alert className={NOTICE}>
        <Icon.evals.judge size={ICON.sm} className="shrink-0 text-bespoke" />
        <span className="min-w-0 flex-1">Quality is judged on this workspace's Anthropic key.</span>
        {canSwitch && (
          <Button variant="ghost" size="xs" onClick={() => sendSetJudgeOwnKey(false)}>
            Turn off
          </Button>
        )}
      </Alert>
    );
  }
  return (
    <Alert className={NOTICE} role="status">
      <Icon.evals.judge size={ICON.sm} className="shrink-0 text-bespoke" />
      <span className="min-w-0 flex-1">Quality isn't scored — the judge is off.</span>
      {!judge.keyPresent ? (
        <Button variant="secondary" size="xs" onClick={() => useUiStore.getState().openSecretsForProvider("anthropic")}>
          Add an Anthropic key in Secrets →
        </Button>
      ) : canSwitch ? (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => sendSetJudgeOwnKey(true)}
          title="Score answers with this workspace's Anthropic key. It is used for the judge and nothing else."
        >
          Judge with my Anthropic key
        </Button>
      ) : (
        <span className="text-faint">An admin can turn on judging with the workspace's Anthropic key.</span>
      )}
    </Alert>
  );
}

/**
 * An eval's outcome as a pill — the trace header's, tone for tone and mark for mark, so the two
 * panels answer "how did it go" in one visual language.
 *
 * Green finished, amber (with a pulsing dot) while it is moving, red when it broke. AN EVAL THAT
 * STOPPED — cancelled, or stopped itself at its ceiling — is the trace's info blue: not a success and
 * not a fault, which is the distinction `EVAL_WORD` exists to keep. The word stays this panel's own.
 */
const PILL: Record<"done" | "live" | "stopped" | "failed", { tone: PillTone; Mark: IconComponent }> = {
  done: { tone: "ok", Mark: Icon.trace.finished },
  live: { tone: "run", Mark: Icon.trace.running },
  stopped: { tone: "info", Mark: Icon.trace.stopped },
  failed: { tone: "err", Mark: Icon.trace.failed },
};
const PILL_OF: Record<EvalRunStatus, keyof typeof PILL> = {
  queued: "live",
  running: "live",
  completed: "done",
  aborted_over_budget: "stopped",
  cancelled: "stopped",
  error: "failed",
};

export function EvalOutcomePill({ status, word, detail }: {
  status: EvalRunStatus;
  /** Said instead of the status's own word — "scoring", once the runs are done and the judge is not. */
  word?: string;
  /** Beside the word, unbolded: "7 of 12". */
  detail?: string | null;
}) {
  const kind = PILL_OF[status] ?? "failed";
  const { tone, Mark } = PILL[kind];
  return (
    <Badge tone={tone} size="md" className="gap-1.5 font-medium">
      {kind === "live" ? (
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-stream-pulse rounded-full bg-run motion-reduce:animate-none" />
      ) : (
        <Mark size={ICON.xs} />
      )}
      {word ?? EVAL_WORD[status] ?? status}
      {detail && <span className="font-normal tabular-nums">· {detail}</span>}
    </Badge>
  );
}

/**
 * What this agent's running eval is made of, as one bar under the tabs — in either half.
 *
 * IT WAS A WORD, "running 2/12", and a second line under the history on Results only, so building the
 * next dataset while an eval ran showed a count and nothing about what the count was made of. The
 * bar is built as the step details' token split is: segments on a rounded track. Each kind of
 * finished job has its own colour — answered, failed, cancelled — and what is in flight is amber,
 * the one thing here that moves. Queued work is the empty track. How far along it is lives in the
 * header's pill; this says what the rest is.
 */
export function EvalProgressBar({ progress }: { progress: EvalProgress }) {
  const { total, done, running, queued, failed } = progress;
  const cancelled = progress.cancelled ?? 0;
  const succeeded = progress.succeeded ?? Math.max(0, done - failed - cancelled);
  const scoring = progress.status !== undefined && progress.scoring === true;
  const share = (n: number): string => `${total > 0 ? (Math.max(0, n) / total) * 100 : 0}%`;
  const caption = scoring
    ? "every run finished · scoring the answers"
    : [
        running > 0 ? `${running} in flight` : null,
        queued > 0 ? `${queued} queued` : null,
        failed > 0 ? `${failed} failed` : null,
        cancelled > 0 ? `${cancelled} cancelled` : null,
      ].filter(Boolean).join(" · ");
  return (
    // A STRIP UNDER THE TABS, as an editor shows a view's work in progress: answered runs in green,
    // failed in red, cancelled in grey, and what is in flight amber — the one thing here that moves.
    <div className="flex shrink-0 items-center gap-3 border-b border-hair bg-panel px-4 py-2">
      <div
        role="progressbar"
        aria-label="Eval progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={scoring ? "every run finished, scoring the answers" : `${done} of ${total} runs finished`}
        className="flex h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-active"
      >
        <span className="h-full bg-ok" style={{ width: share(succeeded) }} />
        <span className="h-full bg-err" style={{ width: share(failed) }} />
        <span className="h-full bg-faint" style={{ width: share(cancelled) }} />
        {!scoring && (
          <span className="h-full bg-run animate-stream-pulse motion-reduce:animate-none" style={{ width: share(running) }} />
        )}
      </div>
      {caption && <span className="shrink-0 whitespace-nowrap text-tiny tabular-nums text-muted">{caption}</span>}
    </div>
  );
}

/**
 * A FINISHED EVAL'S TICK IS GREEN HERE. The shared vocabulary draws `done` in neutral grey, and every
 * other tab keeps that; the product owner asked for this panel's ticks to read green (2026-10-31).
 */
const tickColour = (status: EvalRunStatus): string | undefined => (status === "completed" ? STATUS.ok : undefined);

/**
 * One past eval as both pickers list it: its state and when on the first line, what it ran on and
 * against which models under it.
 *
 * IT WAS A CHIP READING "4d ago". Two evals from one afternoon on two datasets were two identical
 * chips, and the models — the thing a comparison is OF — were only in a tooltip.
 */
export function EvalFace({ e, dataset, models, chosen = false }: {
  e: EvalRunSummary;
  dataset: string | null;
  models: string;
  /** The one on screen, ticked — a menu row's fill alone is the same grey as the one under the pointer. */
  chosen?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className="pt-0.5">
        <StatusGlyph phase={EVAL_PHASE[e.status]} size={ICON.xs} title={EVAL_WORD[e.status]} colour={tickColour(e.status)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2 text-caption">
          <span className="shrink-0 text-ink">{relTime(e.started_at)}</span>
          {dataset && <span className="min-w-0 truncate text-muted">{dataset}</span>}
        </span>
        <span className="block truncate text-tiny text-faint">
          {models || "no models"}
          {e.status !== "completed" && ` · ${EVAL_WORD[e.status]}`}
        </span>
      </span>
      <span className="shrink-0 pt-0.5"><Chosen on={chosen} /></span>
    </span>
  );
}

/**
 * Which evals the picker lists, as two marks — one dataset, or the stack of all of them. "Every
 * dataset" is how a deleted dataset's evals are reached. The words are the tooltips.
 */
const SCOPES: { value: "dataset" | "all"; label: string; icon: IconComponent }[] = [
  { value: "dataset", label: "Show only this dataset's evals", icon: Icon.evals.scopeDataset },
  { value: "all", label: "Show this agent's evals on every dataset, including deleted ones", icon: Icon.evals.scopeAll },
];

/** The panel's two views, as the trace's run views are drawn — each behind its own mark. */
const VIEWS: { id: "dataset" | "results"; label: string; title: string; Mark: IconComponent }[] = [
  { id: "dataset", label: "Dataset", title: "The cases, and how answers are scored", Mark: Icon.evals.datasetView },
  { id: "results", label: "Results", title: "What each eval found", Mark: Icon.evals.resultsView },
];

type Mode = "dataset" | "results";

export function EvalsPanel() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const agentName = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId)?.name ?? s.activeAgentId);
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
   * What each half of the switch holds — as a total, or not at all. The open dataset's cases arrive
   * whole; the eval list is a growing window, so it is counted only once the server says it has sent
   * every one. Until either has arrived there is no figure, because unknown is not zero.
   */
  const cases = useEvalStore((s) => (selectedDatasetId ? s.examplesByDataset[selectedDatasetId] : undefined));
  const pendingDelete = useEvalStore((s) => s.pendingDelete);
  const caseCount = cases?.filter((e) => !(pendingDelete?.kind === "case" && pendingDelete.id === e.id)).length;
  const evalCount = list?.complete ? evals.length : undefined;
  /**
   * How many past evals the picker is listing.
   *
   * TWO CEILINGS USED TO SIT ON TOP OF EACH OTHER HERE, and both were unreachable: the server read
   * the newest fifty with no way to ask past it, and the strip then rendered the first SIX of those
   * — so the seventh-newest comparison could not be selected at all, in the panel whose entire job is
   * comparing. This is the local half; the window below is the server's. A menu scrolls, so it opens
   * on twelve rather than six.
   */
  const [shown, setShown] = useState(12);
  const shownEvalId = selectedEvalId ?? evals[0]?.id ?? null;
  const results = shownEvalId ? resultsByEval[shownEvalId] : undefined;
  // WHAT CHANGED SINCE: the eval the shown one is compared with, when one is chosen.
  const compareWith = useEvalStore((s) => (activeAgentId ? (s.compareWithByAgent[activeAgentId] ?? null) : null));
  const comparing = compareWith && compareWith !== shownEvalId ? resultsByEval[compareWith] : undefined;
  // The cases whose outcome moved between the two, for the case list's Changed facet — the same
  // diff the comparison draws, laid out older first as it is.
  const changedIds = useMemo(() => {
    if (!results || !comparing) return undefined;
    const [older, newer] = Date.parse(comparing.startedAt) <= Date.parse(results.startedAt) ? [comparing, results] : [results, comparing];
    return new Set(compareEvals(older, newer).changes.map((c) => c.exampleId));
  }, [results, comparing]);
  // The pickers name models as the run bar does — "Haiku 4.5" — with the id where the catalogue has none.
  const providerModels = useProviderStore((s) => s.models);
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

  const scoring = progress?.status !== undefined && progress?.scoring === true;
  const openDataset = agentDatasets.find((d) => d.id === selectedDatasetId);
  const counts = { dataset: caseCount, results: evalCount };
  const shownSummary = evals.find((e) => e.id === shownEvalId);
  const verdictOf = (r: EvalResults): string | null => verdict(r.providers, (m) => modelName(providerModels, m));
  /**
   * A changed case, opened from the comparison: every case listed, its answer for that model open,
   * and scrolled to — the cell is this eval's own, whichever of the two the change was read from.
   */
  const pickCase = (exampleId: string, model: string): void => {
    if (!results) return;
    const store = useEvalStore.getState();
    store.setCaseFacet(results.evalId, "all");
    const cell = results.rows.find((r) => r.exampleId === exampleId)?.cells.find((c) => c.model === model);
    if (cell) store.setOpenCell(results.evalId, cell.jobId);
    requestAnimationFrame(() => document.querySelector(`[data-example-id="${exampleId}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const modelsOf = (e: EvalRunSummary): string =>
    e.targets.map((t) => `${modelName(providerModels, t.model)}${t.effort ? ` (${t.effort})` : ""}`).join(" · ");
  const showOlder = (): void => {
    if (shown < evals.length) setShown(shown + 12);
    else sendListEvals(activeAgentId, scopeDataset, Math.min((list?.window ?? 50) * 2, 500));
  };

  return (
    // THE TWO VIEWS ARE shadcn's TABS (Radix underneath): the tab strip is a real tablist whose panels
    // it controls, the arrow keys move between the two, and the view on screen is the store's.
    <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="flex h-full flex-col bg-bg">
      <EvalUndoToast />
      {/* HEADED AS AN EDITOR'S PANEL IS: its name in the title bar, with an eval's pill at the bar's end
          while one runs; where you are as a breadcrumb — the agent, then the dataset open in it — and
          the panel's views as its tabs, all on the panel's own ground over the content's. */}
      <header className="shrink-0 border-b border-hair bg-panel">
        <div className="flex h-9 items-center gap-3 px-4">
          <span className={`flex min-w-0 items-center gap-1.5 ${TYPE.panelLabel}`}>
            <Icon.evals.panel size={ICON.xs} className="shrink-0" />
            <span className="truncate">Evals</span>
          </span>
          {running && (
            <span className="ml-auto flex shrink-0 items-center gap-3">
              <EvalOutcomePill
                status="running"
                word={scoring ? "scoring" : undefined}
                detail={scoring ? null : `${progress.done} of ${progress.total}`}
              />
            </span>
          )}
        </div>
        <nav aria-label="Where this is" className="flex min-w-0 items-center gap-1.5 px-4 pb-1.5 text-caption">
          <span className="flex min-w-0 shrink items-center gap-1.5 text-label text-ink" title={agentName ?? undefined}>
            <Icon.evals.agent size={ICON.sm} className="shrink-0 text-stateful" />
            <span className="truncate">{agentName}</span>
          </span>
          {openDataset && (
            <>
              <Icon.evals.crumb size={ICON.xs} className="shrink-0 text-faint" />
              <Tip label="The dataset open in this tab">
                <FactPill icon={Icon.evals.datasetView} tone={FACT_TONE.dataset} className="min-w-[1.75rem] shrink-[1000]">
                  <span className="truncate">{openDataset.name}</span>
                </FactPill>
              </Tip>
            </>
          )}
        </nav>
        {/* EACH VIEW WITH HOW MANY THINGS IT HOLDS, when that is a total — a badge, as an editor
            counts its problems, and in ink on the tab that is open. */}
        <TabsList aria-label="Eval views" className="border-b-0 px-2">
          {VIEWS.map((v) => (
            <TabsTrigger key={v.id} value={v.id} title={v.title}>
              <v.Mark size={ICON.xs} />
              {v.label}
              {counts[v.id] !== undefined && (
                <Badge tone={mode === v.id ? "ink" : "neutral"} className="h-4 px-1.5">{counts[v.id]}</Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>
      {running && <EvalProgressBar progress={progress} />}

      <TabsContent value="dataset" className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 min-h-0"><DatasetBuilder /></div>
        <EvalRunBar />
      </TabsContent>
      <TabsContent value="results" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
          {/* WHICH EVAL, AND AGAINST WHICH — two menus and the scope, in one row. This was three rows
              of near-identical chips: a strip of timestamps, a second strip to pick a comparison from,
              and `older…`. Shown with a single eval too: the scope switch is the only way to a deleted
              dataset's evals, and hiding it until this dataset had two left them out of reach. */}
          {(evals.length > 0 || allDatasets || (hasDatasets && selectedDatasetId)) && (
            // AN EDITOR'S VIEW TOOLBAR, pinned while the results scroll under it, so which eval this
            // is — and against which — stays in sight down a long list of cases.
            <div className="sticky top-0 z-10 -mx-4 -mt-3 mb-3 flex flex-wrap items-center gap-1.5 border-b border-hair bg-bg px-4 py-2">
              {evals.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(EVAL_SELECT, "h-8 min-w-[10rem] max-w-full flex-1")}
                      aria-label="Choose which eval to show"
                      title="The eval on screen — choose another"
                    >
                      <Icon.evals.history size={ICON.xs} className="shrink-0 text-faint" />
                      {shownSummary && <StatusGlyph phase={EVAL_PHASE[shownSummary.status]} size={ICON.xs} title={EVAL_WORD[shownSummary.status]} colour={tickColour(shownSummary.status)} />}
                      <span className="min-w-0 truncate">
                        {shownSummary ? relTime(shownSummary.started_at) : results ? relTime(results.startedAt) : "Choose an eval"}
                        {shownSummary && evalDatasetLabel(shownSummary, agentDatasets) && (
                          <span className="text-muted"> · {evalDatasetLabel(shownSummary, agentDatasets)}</span>
                        )}
                      </span>
                      <Icon.evals.menu size={ICON.xs} className="shrink-0 text-faint" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent edge="strong" align="start" aria-label="Past evals" className="max-h-[360px] w-[320px] overflow-y-auto">
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                      <Icon.evals.history size={ICON.badge} />
                      Past evals
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={shownEvalId ?? ""} onValueChange={(id) => selectEval(activeAgentId, id)}>
                      {evals.slice(0, shown).map((e) => (
                        <DropdownMenuRadioItem key={e.id} value={e.id}>
                          <EvalFace e={e} dataset={evalDatasetLabel(e, agentDatasets)} models={modelsOf(e)} chosen={e.id === shownEvalId} />
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    {/* OLDER EVALS. It lists more of what is loaded first and then asks the server for a
                        bigger window when that runs out, so one row answers "show me more" whichever of
                        the two ceilings is in the way — and the menu stays open while they arrive. */}
                    {(shown < evals.length || (list !== undefined && !list.complete)) && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem size="compact" onSelect={(event) => { event.preventDefault(); showOlder(); }}>
                          Older evals…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {/* COMPARE WITH ANOTHER EVAL — the regression question, "what changed since then". */}
              {shownEvalId && evals.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(EVAL_SELECT, "h-8", comparing && "border-muted/60 bg-panel")}
                      aria-label="Compare with an earlier eval"
                      title="Line this eval up against an earlier one: each model's figures, and every case whose outcome changed"
                    >
                      <Icon.evals.compare size={ICON.xs} className={`shrink-0 ${comparing ? "text-ink" : "text-faint"}`} />
                      <span className="truncate">{comparing ? `vs ${relTime(comparing.startedAt)}` : "Compare"}</span>
                      <Icon.evals.menu size={ICON.xs} className="shrink-0 text-faint" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent edge="strong" align="start" aria-label="Compare with an earlier eval" className="max-h-[360px] w-[320px] overflow-y-auto">
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                      <Icon.evals.compare size={ICON.badge} />
                      Compare with
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={compareWith ?? ""}
                      onValueChange={(id) => useEvalStore.getState().setCompareWith(activeAgentId, id)}
                    >
                      {evals.filter((e) => e.id !== shownEvalId).slice(0, 12).map((e) => (
                        <DropdownMenuRadioItem key={e.id} value={e.id}>
                          <EvalFace e={e} dataset={evalDatasetLabel(e, agentDatasets)} models={modelsOf(e)} chosen={e.id === compareWith} />
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    {compareWith && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem size="compact" onSelect={() => useEvalStore.getState().setCompareWith(activeAgentId, null)}>
                          <Icon.evals.clearComparison size={ICON.xs} />
                          Stop comparing
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {/* WHICH HISTORY. Only offered while there is a dataset to narrow to. */}
              {hasDatasets && selectedDatasetId && (
                <ToggleGroup
                  value={allDatasets ? "all" : "dataset"}
                  onValueChange={(v) => { setAllDatasets(v === "all"); setShown(12); }}
                  aria-label="Which evals to list"
                  className="ml-auto"
                >
                  {SCOPES.map((o) => (
                    <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} title={o.label}>
                      <o.icon size={ICON.sm} />
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </div>
          )}

          <EvalRefusal />
          {results ? (
            <>
              <ResultsHeader results={results} live={progress} actions={<EvalActions results={results} />} />
              {/* THE ANSWER, IN A SENTENCE, before the figures it is drawn from — who leads, on what, by
                  how much. Left out when there is nothing to compare or nothing it could honestly say. */}
              {verdictOf(results) && (
                // WHO LEADS, as a callout with the leader's green edge — the trophy is the one mark in
                // the panel that says somebody won.
                <div className="mb-3 flex items-start gap-2.5 rounded-card border border-hair border-l-2 border-l-ok bg-panel px-3 py-2.5">
                  <Icon.evals.verdict size={ICON.sm} className="mt-px shrink-0 text-ok" />
                  <p className={TYPE.body}>{verdictOf(results)}</p>
                </div>
              )}
              <JudgeLine />
              {comparing && activeAgentId && (
                // Older first, whichever was picked: "before → after" reads in time order.
                Date.parse(comparing.startedAt) <= Date.parse(results.startedAt)
                  ? <EvalCompare before={comparing} after={results} against={comparing} onPickCase={pickCase} onClose={() => useEvalStore.getState().setCompareWith(activeAgentId, null)} />
                  : <EvalCompare before={results} after={comparing} against={comparing} onPickCase={pickCase} onClose={() => useEvalStore.getState().setCompareWith(activeAgentId, null)} />
              )}
              <ComparisonTable results={results} />
              <CriterionBreakdown results={results} />
              <ExampleDrillDown results={results} changed={changedIds} />
            </>
          ) : (
            <EmptyState
              size="line"
              icon={DatabaseIcon}
              title="No results yet"
              hint="Pick providers under the dataset and run it — quality, cost and latency land here side by side."
            />
          )}
      </TabsContent>
    </Tabs>
  );
}
