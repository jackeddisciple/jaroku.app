// Per-example drill-down (doc §6.4: "per-example drill-down into full traces").
//
// The comparison table says provider A scored higher than B. This is where you find out
// WHY — which example separated them, what each one actually answered, what the judge said,
// and from there into the full trace of the run that produced it.
//
// The trace is opened through the EXISTING loadRun path, not a new one. An eval job's run
// is an ordinary run: the same timeline, the same step details, the same graph sync. That
// is the whole reason eval jobs were built on the normal execution path — the debugger the
// user already knows is the drill-down.

import { useState } from "react";
import { sendLoadRun } from "../lib/socket.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { fmtCost, fmtLatency } from "../lib/format.ts";
import { ICON } from "../lib/tokens.ts";
import { Truncate } from "./Truncate.tsx";
import { TYPE } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import type { EvalResults, ExampleCell } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";

/**
 * How a cell that has no score yet reads: its word and its tone.
 *
 * FIVE STATES, NOT TWO. Everything that was not `succeeded` read "failed", in red — so ten jobs still
 * waiting to run, and thirteen a budget stop had cancelled before they ever ran, were all shown as
 * failures, and only a tooltip said otherwise. Red is kept for the two that are failures.
 */
export function cellLook(status: string): { label: string; tone: string; struck?: boolean } | null {
  switch (status) {
    case "succeeded": return null;
    case "queued": return { label: "queued", tone: "text-faint" };
    case "running": return { label: "running", tone: "text-run animate-stream-pulse motion-reduce:animate-none" };
    case "cancelled": return { label: "cancelled", tone: "text-faint", struck: true };
    case "timed_out": return { label: "timeout", tone: "text-err" };
    default: return { label: "failed", tone: "text-err" };
  }
}

/** Compact score chip. A score, unscored, or the job's state — see `cellLook`. */
function ScoreChip({ cell, active, onClick }: { cell: ExampleCell; active: boolean; onClick: () => void }) {
  const look = cellLook(cell.status);
  const label = look ? look.label : cell.score === null ? "—" : (cell.score * 100).toFixed(0);
  const tone = look
    ? look.tone
    : cell.score === null
      ? "text-faint"
      : cell.score >= 0.8
        ? "text-ok"
        : cell.score < 0.4
          ? "text-err"
          : "text-ink";
  const why = look
    ? cell.status === "failed" || cell.status === "timed_out" ? ` — ${cell.error ?? cell.status}` : ` — ${look.label}`
    : cell.score === null ? ` — ${cell.scoreError ?? "unscored"}` : "";
  return (
    <Chip
      onClick={onClick}
      selected={active}
      // The score rides in the figure slot, which is tabular everywhere, so a column of these
      // lines up. The model id used to be set in mono beside it, on the argument that it is an
      // identifier — typography.pdf §04 puts "provider and model labels" in its Sans list and §05
      // refuses the argument in as many words, and the alignment was always `tabular-nums` doing
      // the work rather than the face.
      tone="muted"
      title={`${cell.model}${why}`}
      figure={<span className={`${tone}${look?.struck ? " line-through" : ""}`}>{label}</span>}
    >
      <Truncate className="max-w-[110px]">{cell.model}</Truncate>
    </Chip>
  );
}

/**
 * Text that keeps its line breaks and folds to a few lines, with a way to read the rest.
 *
 * A Liven case is a whole job description and a résumé: unfolded, one case filled the panel, and with
 * its newlines collapsed the `---` between the two ran straight into the text.
 */
export function ClampedText({ text, lines = 3, className = "" }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 90;
  return (
    <div className={className}>
      <div
        className="whitespace-pre-wrap break-words"
        style={open || !long ? undefined : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {text}
      </div>
      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-tiny text-faint transition-colors hover:text-ink"
        >
          {open ? "show less" : "show more"}
        </button>
      )}
    </div>
  );
}

/** Everything known about one (example, provider) pair. */
export function CellDetail({
  cell,
  expected,
  criteria,
  onStep,
  responses = 2,
}: {
  cell: ExampleCell;
  /** What the case expected, to read beside what was answered. */
  expected: string | null;
  criteria: string[];
  /**
   * Move to the neighbouring response for this example, or null at either end.
   *
   * §5 NAMES THESE TWO AND THERE WAS NOWHERE TO PUT THEM, which is the finding rather than the
   * omission: comparing four models' answers to one input meant scrolling back up to the chip row
   * and picking the next one, so the reading you actually want — this answer, then that one, same
   * question — cost a round trip through the control that opened it.
   */
  onStep: (delta: -1 | 1) => void;
  /** How many responses this case has. With one there is nothing to step to. */
  responses?: number;
}) {
  const setRightTab = useUiStore((s) => s.setRightTab);
  const selectRun = useTraceStore((s) => s.selectRun);

  const openTrace = () => {
    if (!cell.runId) return;
    // The existing path, unchanged: focus the run and load its steps. An eval job's run is
    // an ordinary run, so the timeline, step details and graph sync all just work.
    selectRun(cell.runId);
    sendLoadRun(cell.runId);
    setRightTab("trace");
  };

  return (
    <div className="mt-2 ml-6 space-y-2 border-l border-hair pl-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-tiny">
        <span className="flex items-center" role="group" aria-label="Step through this example's responses">
          <IconButton
            icon={Icon.evals.prevResponse}
            label="Previous response"
            size={ICON.xs}
            // One response is a ring of one: stepping "wrapped" onto the same answer.
            disabledReason={responses < 2 ? "This case has only one response" : null}
            onClick={() => onStep(-1)}
          />
          <IconButton
            icon={Icon.evals.nextResponse}
            label="Next response"
            size={ICON.xs}
            disabledReason={responses < 2 ? "This case has only one response" : null}
            onClick={() => onStep(1)}
          />
        </span>
        <span className="text-ink">{cell.model}</span>
        <span className={cellLook(cell.status)?.tone ?? "text-muted"}>{cellLook(cell.status)?.label ?? cell.status}</span>
        {/* The floor marker, where the number is. `cost_complete` has ridden the per-leg rollup
            since the dashboard was written and never reached the cell — so a cost that was an
            undercount rendered, and exported, as a clean measurement. A "≥" is the smallest
            thing that says otherwise and it goes beside the figure, not in a legend. */}
        <span
          className="text-muted tabular-nums"
          title={cell.costComplete ? undefined : "some step reported tokens with no price — this is a floor"}
        >
          {cell.costComplete ? "" : "≥ "}{fmtCost(cell.costUsd)}
        </span>
        <span className="text-muted tabular-nums">{fmtLatency(cell.latencyMs)}</span>
        {cell.attempt > 0 && (
          <span className="text-run" title="this job was retried after a transient failure">
            attempt {cell.attempt + 1}
          </span>
        )}
        {cell.runId && (
          <button
            onClick={openTrace}
            className="ml-auto inline-flex items-center gap-1 text-faint transition-colors duration-fast hover:text-ink"
          >
            Open trace
            <Icon.cockpitWork.openTrace size={ICON.xs} />
          </button>
        )}
      </div>

      {cell.error && <div className="text-tiny text-err whitespace-pre-wrap break-words">{cell.error}</div>}

      {/* WHAT IT ANSWERED, beside what was expected. This panel's header promises "what each one actually
          answered", and it showed a status, a cost and a latency — the answer was only in the trace. */}
      {cell.status === "succeeded" && (
        <div className="space-y-1.5 text-tiny">
          <div>
            <div className="text-faint">Answer</div>
            {cell.output
              ? <ClampedText text={cell.output} lines={6} className="text-ink" />
              : <div className="text-faint italic">no answer was kept for this run — Open trace has the whole of it</div>}
          </div>
          {expected && (
            <div>
              <div className="text-faint">Expected</div>
              <ClampedText text={expected} lines={3} className="text-muted" />
            </div>
          )}
        </div>
      )}

      {/* Per-criterion breakdown: what the overall score is actually made of. */}
      {cell.perCriterion && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-tiny">
          {criteria.map((id) => (
            <span key={id} className="text-muted">
              {id} <span className="text-ink tabular-nums">{cell.perCriterion?.[id] ?? "—"}</span>
              <span className="text-faint">/4</span>
            </span>
          ))}
        </div>
      )}

      {cell.rationale && (
        <div className="text-tiny text-muted whitespace-pre-wrap break-words leading-relaxed">
          {cell.rationale}
        </div>
      )}

      {/* Unscored is not zero, and the reason matters — a judge failure is not a bad answer. */}
      {cell.score === null && cell.status === "succeeded" && (
        <div className="text-tiny text-faint">{cell.scoreError ?? "not scored"}</div>
      )}
    </div>
  );
}

export function ExampleDrillDown({ results }: { results: EvalResults }) {
  // KEPT PER EVAL in the store, so the cell whose trace was opened is still open on the way back.
  const openCell = useEvalStore((s) => s.openCellByEval[results.evalId] ?? null);
  const setOpenCell = (jobId: string | null): void => useEvalStore.getState().setOpenCell(results.evalId, jobId);

  // Criterion ids, taken from whichever cell has a breakdown — the rubric is the same for
  // the whole eval, so any scored cell names them all.
  const criteria = Object.keys(
    results.rows.flatMap((r) => r.cells).find((c) => c.perCriterion)?.perCriterion ?? {},
  );

  if (!results.rows.length) return null;

  return (
    <div className="mt-5">
      <div className={`pb-1.5 ${TYPE.sectionLabel}`}>By example</div>
      <div className="space-y-1">
        {results.rows.map((row, i) => {
          const open = row.cells.find((c) => c.jobId === openCell);
          return (
            <div key={row.exampleId} className="py-1.5">
              <div className="flex items-start gap-3">
                <span className="text-faint text-tiny tabular-nums w-5 shrink-0 text-right select-none pt-1">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  {/* LINE BREAKS KEPT, LONG CASES FOLDED. The input was one run-on paragraph with every
                      newline collapsed, so a Liven case's `---` between the job and the résumé ran
                      into the text — and a whole case filled the panel. */}
                  <ClampedText text={row.input} lines={3} className="text-caption text-ink" />
                  {row.expected && (
                    <div className="mt-0.5 flex gap-1 text-tiny text-faint">
                      <span className="shrink-0">expected:</span>
                      <ClampedText text={row.expected} lines={2} className="min-w-0" />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {row.cells.map((c) => (
                      <ScoreChip
                        key={c.jobId}
                        cell={c}
                        active={c.jobId === openCell}
                        onClick={() => setOpenCell(c.jobId === openCell ? null : c.jobId)}
                      />
                    ))}
                  </div>
                  {open && (
                    <CellDetail
                      cell={open}
                      expected={row.expected}
                      criteria={criteria}
                      responses={row.cells.length}
                      onStep={(delta) => {
                        // WRAPS, because a row is a ring of two to four answers to one question
                        // and stopping at the end would make the last one a dead end.
                        const at = row.cells.findIndex((c) => c.jobId === open.jobId);
                        const next = row.cells[(at + delta + row.cells.length) % row.cells.length];
                        if (next) setOpenCell(next.jobId);
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
