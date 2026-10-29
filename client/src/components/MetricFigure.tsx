// One figure of a metrics strip — the trace's, shared with the Evals panel's.
//
// MOVED OUT OF TraceMetrics.tsx when the Evals panel took its figures from the trace: a run's
// Duration, Tokens and Cost and an eval's Spent, Ran OK and Judge are the same kind of thing — a
// number somebody opens the panel to read — and two copies of how one is drawn is how they end up a
// size apart. The markup is the trace strip's, unchanged.

import type { IconComponent } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";

/** The card a strip of figures sits in, split by hairlines — the trace's. */
export const FIGURE_STRIP = "grid divide-x divide-hair rounded-card border border-hair bg-panel";

/**
 * One of the strip's figures: its mark and its word, then the number, large — the number is what
 * somebody opens a trace to read (the product owner's call on 2026-10-12, "richer metrics").
 *
 * EACH SAYS HOW IT COMPARES WITH THE LAST RUN ON THE SAME INPUT (2026-10-15): the change beside the
 * number, and under it what it is against — "vs last run on this input", which opens that run — so
 * the arrow is never a number without a subject. Lower is green, higher red; Duration's is the
 * steps' working time (`runFigures`).
 * The sparklines over an agent's recent runs that stood beside the other runs' words came out the
 * same day — the product owner read them as decoration.
 */
export interface MetricFigureProps {
  Mark: IconComponent;
  label: string;
  value: string;
  title: string;
  tone?: string;
  delta?: React.ReactNode;
  /** What the delta is against, said under the number — and, pressed, that run opened. */
  note?: string;
  onNote?: () => void;
  /** What pressing the note does, for its tooltip. The trace's note opens the run it is compared with. */
  noteTitle?: string;
}

export function MetricFigure({
  Mark,
  label,
  value,
  title,
  tone = "text-ink",
  delta,
  note,
  onNote,
  noteTitle = "Open the run this is compared with",
}: MetricFigureProps) {
  return (
    <div className="min-w-0 px-3 py-2.5" title={title}>
      <div className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
        <span aria-hidden className="shrink-0"><Mark size={ICON.xs} /></span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
        <span className={`truncate text-section tabular-nums ${tone}`}>{value}</span>
        {delta && <span className="shrink-0 text-tiny tabular-nums">{delta}</span>}
      </div>
      {note && (onNote ? (
        <button
          type="button"
          onClick={onNote}
          title={noteTitle}
          className="block max-w-full truncate rounded-xs text-left text-tiny text-faint underline decoration-transparent underline-offset-2 transition-colors hover:text-muted hover:decoration-current focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {note}
        </button>
      ) : <div className="truncate text-tiny text-faint">{note}</div>)}
    </div>
  );
}
