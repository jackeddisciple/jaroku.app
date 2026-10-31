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

import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { sendLoadRun } from "../lib/socket.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { modelName, useProviderStore } from "../store/providerStore.ts";
import { ProviderMark } from "../lib/icons.tsx";
import { FACT_TONE, MatchMark, ModelLabel, Pill, RanOkMark, SectionFold, type PillTone } from "./evalUi.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";
import { fmtCost, fmtLatency } from "../lib/format.ts";
import { CASE_FACETS, criterionLabel, criterionTable, facetCounts, rowIs, type CaseFacet } from "../lib/evalView.ts";
import { useNarrowerThan } from "../lib/useNarrower.ts";
import { ICON } from "../lib/tokens.ts";
import { Truncate } from "./Truncate.tsx";
import { TYPE } from "../lib/tokens.ts";
import { SectionHeader } from "./SectionHeader.tsx";
import type { EvalResults, ExampleCell } from "../types.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
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

/**
 * What a ran cell's chip says when it has no score — which, with the judge off, is every cell.
 *
 * IT SAID "—", which beside "cancelled" read as nothing having happened. The check against
 * expected is the answer when there is one; otherwise that it ran.
 */
export function unscoredLook(cell: Pick<ExampleCell, "matches">): { label: string; tone: string } {
  if (cell.matches === true) return { label: "match", tone: "text-ok" };
  if (cell.matches === false) return { label: "no match", tone: "text-err" };
  return { label: "ran", tone: "text-muted" };
}

/** Compact score chip. A score, unscored, or the job's state — see `cellLook`. */
function ScoreChip({ cell, name, active, onClick }: { cell: ExampleCell; name: string; active: boolean; onClick: () => void }) {
  const look = cellLook(cell.status);
  const unscored = cell.score === null ? unscoredLook(cell) : null;
  const label = look ? look.label : unscored ? unscored.label : (cell.score! * 100).toFixed(0);
  const tone = look
    ? look.tone
    : unscored
      ? unscored.tone
      : cell.score! >= 0.8
        ? "text-ok"
        : cell.score! < 0.4
          ? "text-err"
          : "text-ink";
  const why = look
    ? cell.status === "failed" || cell.status === "timed_out" ? ` — ${cell.error ?? cell.status}` : ` — ${look.label}`
    : cell.score === null ? ` — ${cell.scoreError ?? "unscored"}` : "";
  return (
    // A CELL AS A CHIP THAT OPENS IT: the provider's mark, the model's name and the score in its band's
    // colour, on the field's ground — and, open, held down with an ink ring rather than filled, so the
    // score keeps its colour while it is the one being read.
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${cell.model}${why}`}
      className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-control border px-2 text-tiny transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
        active ? "border-ink bg-elevated text-ink ring-1 ring-ink" : "border-edge bg-elevated text-muted hover:border-grip hover:bg-panel hover:text-ink"
      }`}
    >
      {/* THE PROVIDER'S MARK, so a row of four chips is told apart by its marks before its names. */}
      <span aria-hidden className="inline-flex shrink-0"><ProviderMark provider={cell.provider} size={ICON.xs} /></span>
      {/* BY THE NAME THE RUN BAR USES — "Haiku 4.5" — with the id kept in the tooltip. */}
      <Truncate className="max-w-[110px]">{name}</Truncate>
      {/* The score in the figure slot, tabular, so a column of these lines up. */}
      <span className={`tabular-nums ${tone}${look?.struck ? " line-through" : ""}`}>{label}</span>
    </button>
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
        className={`whitespace-pre-wrap break-words${open || !long ? "" : " clamp-lines"}`}
        style={open || !long ? undefined : ({ "--clamp": lines } as CSSProperties)}
      >
        {text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 inline-flex items-center gap-1 rounded-xs text-tiny text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {open ? <Icon.evals.fold size={ICON.xs} /> : <Icon.evals.unfold size={ICON.xs} />}
          {open ? "show less" : "show more"}
        </button>
      )}
    </div>
  );
}

/** A criterion's steps in the score's band: green at 3 and 4, red at 0 and 1, ink between. */
const STEP_FILL = (value: number): string => (value >= 3 ? "bg-ok" : value <= 1 ? "bg-err" : "bg-ink");

/** A criterion's 0–4 score as four steps — the judge's anchored scale, which is four steps up from 0. */
function Steps({ value }: { value: number }) {
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={`h-1.5 w-2.5 rounded-full ${value >= i ? STEP_FILL(value) : "bg-active"}`} />
      ))}
    </span>
  );
}

/** One of a cell's parts — the answer, what was expected, the judge — under its mark and its word. */
function Part({ Mark, label, aside, tone = "text-faint", children }: { Mark: IconComponent; label: string; aside?: ReactNode; tone?: string; children: ReactNode }) {
  // AN EDITOR'S PANE: its name in a header bar on the panel's ground, and what it holds under it — so
  // an answer and what was expected sit side by side as two documents, split as an editor splits.
  return (
    <div className="min-w-0 overflow-hidden rounded-control border border-hair">
      <div className={`flex min-h-7 items-center gap-1.5 border-b border-hair bg-panel px-2.5 py-1 ${TYPE.sectionLabel}`}>
        <Mark size={ICON.xs} className={`shrink-0 ${tone}`} />
        {label}
        {aside}
      </div>
      <div className="bg-elevated px-2.5 py-2">{children}</div>
    </div>
  );
}

/** A cell's figure behind its mark — what it cost, how long it took. */
function Fact({ Mark, title, children }: { Mark: IconComponent; title?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums text-muted" title={title}>
      <Mark size={ICON.xs} className="shrink-0 text-faint" />
      {children}
    </span>
  );
}

/** Wider than this, a cell's answer and what its case expected sit side by side. */
const SIDE_BY_SIDE_PX = 460;

/** Everything known about one (example, provider) pair. */
export function CellDetail({
  cell,
  expected,
  criteria,
  onStep,
  responses = 2,
  labelOf = (id) => id,
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
  /**
   * A criterion's name as the rubric gives it. The breakdown printed the ids verdicts are recorded
   * under — `correctness 3/4` — while the eval carried the labels somebody had written for them.
   */
  labelOf?: (id: string) => string;
}) {
  const setRightTab = useUiStore((s) => s.setRightTab);
  const selectRun = useTraceStore((s) => s.selectRun);
  const [box, narrow] = useNarrowerThan<HTMLDivElement>(SIDE_BY_SIDE_PX);

  const openTrace = () => {
    if (!cell.runId) return;
    // The existing path, unchanged: focus the run and load its steps. An eval job's run is
    // an ordinary run, so the timeline, step details and graph sync all just work.
    selectRun(cell.runId);
    sendLoadRun(cell.runId);
    setRightTab("trace");
  };

  return (
    // UNDER A HAIRLINE IN ITS CASE, as the trace opens a section's body — not a rule down the left
    // edge that indented the answer away from the case it answers.
    <div ref={box} className="mt-2.5 space-y-3 border-t border-hair pt-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny">
        <span className="flex items-center" role="group" aria-label="Step through this example's responses">
          <IconButton variant="soft"
            icon={Icon.evals.prevResponse}
            label="Previous response"
            size={ICON.xs}
            // One response is a ring of one: stepping "wrapped" onto the same answer.
            disabledReason={responses < 2 ? "This case has only one response" : null}
            onClick={() => onStep(-1)}
          />
          <IconButton variant="soft"
            icon={Icon.evals.nextResponse}
            label="Next response"
            size={ICON.xs}
            disabledReason={responses < 2 ? "This case has only one response" : null}
            onClick={() => onStep(1)}
          />
        </span>
        <ModelLabel provider={cell.provider} model={cell.model} className="text-label text-ink" />
        {cellLook(cell.status)
          ? <span className={cellLook(cell.status)!.tone}>{cellLook(cell.status)!.label}</span>
          : <Pill icon={RanOkMark} tone="ok">{cell.status}</Pill>}
        {/* The floor marker, where the number is. `cost_complete` has ridden the per-leg rollup
            since the dashboard was written and never reached the cell — so a cost that was an
            undercount rendered, and exported, as a clean measurement. A "≥" is the smallest
            thing that says otherwise and it goes beside the figure, not in a legend. */}
        <Fact Mark={Icon.evals.cost} title={cell.costComplete ? "What this run cost" : "some step reported tokens with no price — this is a floor"}>
          {cell.costComplete ? "" : "≥ "}{fmtCost(cell.costUsd)}
        </Fact>
        <Fact Mark={Icon.evals.latency} title="How long this run took">{fmtLatency(cell.latencyMs)}</Fact>
        {cell.attempt > 0 && (
          <Pill icon={Icon.evals.attempt} tone={FACT_TONE.runs} title="this job was retried after a transient failure">
            attempt {cell.attempt + 1}
          </Pill>
        )}
        {cell.runId && (
          // A WAY TO LOOK AT SOMETHING, so the secondary weight — the one `buttons.ts` gives exactly that.
          <Button variant="secondary" size="xs" onClick={openTrace} className="ml-auto">
            <Icon.cockpitWork.openTrace size={ICON.xs} />
            Open trace
          </Button>
        )}
      </div>

      {cell.error && (
        <Alert tone="destructive" className="items-start">
          <Icon.evals.facetFailed size={ICON.xs} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{cell.error}</span>
        </Alert>
      )}

      {/* WHAT IT ANSWERED, beside what was expected — side by side where there is room, so the reading
          this view exists for is one glance across rather than one scroll down. */}
      {cell.status === "succeeded" && (
        <div className={expected && !narrow ? "grid grid-cols-2 gap-3" : "space-y-2.5"}>
          {/* EACH IN ITS OWN WELL, on the page's ground under a hairline, so the answer and what was
              expected read as two documents to hold side by side rather than as more of the case. */}
          <Part Mark={Icon.evals.answer} label="Answer">
            {cell.output
              ? <ClampedText text={cell.output} lines={6} className={TYPE.body} />
              : <div className="text-tiny text-faint italic">no answer was kept for this run — Open trace has the whole of it</div>}
          </Part>
          {expected && (
            <Part
              Mark={Icon.evals.expected}
              tone="text-reviewed"
              label="Expected"
              aside={cell.matches === true
                ? <Pill icon={MatchMark} tone="ok" className="ml-auto normal-case tracking-normal">matches</Pill>
                : cell.matches === false
                  ? <Pill icon={Icon.evals.noMatch} tone="err" className="ml-auto normal-case tracking-normal">does not match</Pill>
                  : null}
            >
              <ClampedText text={expected} lines={3} className="text-caption text-muted" />
            </Part>
          )}
        </div>
      )}

      {/* WHAT THE SCORE IS MADE OF, each criterion by its name and as the four steps it is scored on. */}
      {cell.perCriterion && criteria.length > 0 && (
        <Part
          Mark={Icon.evals.judge}
          tone="text-bespoke"
          label="Judge"
          aside={cell.score !== null
            ? <Pill icon={Icon.evals.quality} tone={cell.score >= 0.8 ? "ok" : cell.score < 0.4 ? "err" : "ink"} className="ml-auto">{Math.round(cell.score * 100)}</Pill>
            : null}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 text-tiny">
            {criteria.map((id) => {
              const value = cell.perCriterion?.[id];
              return (
                <Fragment key={id}>
                  <span className="min-w-0 truncate text-muted" title={id}>{labelOf(id)}</span>
                  {typeof value === "number" ? <Steps value={value} /> : <span />}
                  <span className="text-right tabular-nums text-ink">
                    {typeof value === "number" ? value : "—"}<span className="text-faint">/4</span>
                  </span>
                </Fragment>
              );
            })}
          </div>
        </Part>
      )}

      {/* WHAT THE JUDGE SAID, AS ITS WORDS — set off as a quotation, not more of the panel's own text. */}
      {cell.rationale && (
        // THE JUDGE'S OWN WORDS, set off as a quotation in the judge's purple.
        <div className="flex items-start gap-2 rounded-control border-l-2 border-l-bespoke bg-bespoke/5 px-2.5 py-2">
          <Icon.evals.rationale size={ICON.xs} className="mt-0.5 shrink-0 text-bespoke" />
          <div className="min-w-0 text-tiny leading-relaxed text-muted whitespace-pre-wrap break-words">{cell.rationale}</div>
        </div>
      )}

      {/* Unscored is not zero, and the reason matters — a judge failure is not a bad answer. */}
      {cell.score === null && cell.status === "succeeded" && (
        <div className="flex items-center gap-1.5 text-tiny text-faint">
          <Icon.evals.facetUnscored size={ICON.xs} className="shrink-0" />
          {cell.scoreError ?? "not scored"}
        </div>
      )}
    </div>
  );
}

/** A criterion's average for one model, as a short bar and the figure — for the breakdown. */
function CriterionMeter({ value, n, lead }: { value: number | null; n: number; lead: boolean }) {
  if (value === null) return <span className="text-faint" title="nothing scored on this criterion">—</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2" title={`the mean of ${n} score${n === 1 ? "" : "s"}`}>
      {/* IN THE SCORE'S BAND, as the quality bar is — green from 3.2 of 4, red under 1.6 — the leader's
          at full strength and the rest a step back. */}
      <span aria-hidden className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-active">
        <span className={`block h-full rounded-full ${value >= 3.2 ? "bg-ok" : value < 1.6 ? "bg-err" : "bg-ink"} ${lead ? "" : "opacity-60"}`} style={{ width: `${(value / 4) * 100}%` }} />
      </span>
      <span className={`tabular-nums ${lead ? "text-ink" : "text-muted"}`}>{value.toFixed(1)}</span>
    </span>
  );
}

/**
 * Each criterion, each model's average on it — where two models' overall scores come apart.
 *
 * THE VERDICTS ALWAYS CARRIED THIS AND NOTHING SUMMED IT. A 74 against a 69 says one model is better;
 * it does not say whether that is correctness or grounding, which is the thing somebody choosing
 * between them needs. A criterion's weight is said as its share of the overall score, since weights
 * are normalised and their raw values add up to nothing in particular.
 */
export function CriterionBreakdown({ results }: { results: EvalResults }) {
  const providerModels = useProviderStore((s) => s.models);
  const rows = criterionTable(results);
  if (!rows.length) return null;
  const totalWeight = rows.reduce((sum, r) => sum + (r.weight ?? 0), 0);
  return (
    <SectionFold icon={Icon.evals.criteria} label="By criterion" aside="each model's average, 0–4" ariaLabel="By criterion" className="mt-5">
      <div className="overflow-hidden rounded-card border border-hair bg-elevated">
        <Table>
          <TableHeader>
            <tr>
              <TableHead className="pl-3 pr-3">Criterion</TableHead>
              {results.providers.map((p, i) => (
                <TableHead
                  key={`${p.provider} ${p.model}`}
                  className={`text-right ${i === results.providers.length - 1 ? "pl-2 pr-3" : "px-2"}`}
                  title={`${p.provider} · ${p.model}`}
                >
                  <span className="inline-flex items-center justify-end gap-1 normal-case tracking-normal">
                    <ProviderMark provider={p.provider} size={ICON.badge} />
                    {modelName(providerModels, p.model)}
                  </span>
                </TableHead>
              ))}
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const values = r.scores.map((s) => s.avg).filter((v): v is number => v !== null);
              const top = values.length > 1 && Math.max(...values) > Math.min(...values) ? Math.max(...values) : null;
              return (
                <TableRow key={r.id} title={r.description ?? undefined}>
                  <TableCell className="pl-3 pr-3">
                    <span className="text-ink">{r.label}</span>
                    {r.weight !== null && totalWeight > 0 && (
                      <Pill tone={FACT_TONE.judge} title="This criterion's share of the overall score" className="ml-1.5 align-middle">
                        {Math.round((r.weight / totalWeight) * 100)}%
                      </Pill>
                    )}
                  </TableCell>
                  {r.scores.map((s, j) => (
                    <TableCell key={`${s.provider} ${s.model}`} className={`text-right ${j === r.scores.length - 1 ? "pl-2 pr-3" : "px-2"}`}>
                      <CriterionMeter value={s.avg} n={s.n} lead={top !== null && s.avg === top} />
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </SectionFold>
  );
}

/** The colour each facet's count wears once it has something in it. */
const FACET_TONE: Record<CaseFacet, PillTone> = { all: "neutral", failed: "err", disagree: "info", unscored: "neutral", changed: FACT_TONE.judge };

/** Each facet as the case list's filter says it, and what choosing it shows. */
const FACET_TEXT: Record<CaseFacet, { text: string; noun: string; Mark: IconComponent }> = {
  all: { text: "All", noun: "every case", Mark: Icon.evals.facetAll },
  failed: { text: "Failed", noun: "the cases a model failed", Mark: Icon.evals.facetFailed },
  disagree: { text: "Disagree", noun: "the cases the models answered differently", Mark: Icon.evals.facetDisagree },
  unscored: { text: "Unscored", noun: "the cases with an answer the judge did not score", Mark: Icon.evals.facetUnscored },
  changed: { text: "Changed", noun: "the cases whose outcome moved since the eval this is compared with", Mark: Icon.evals.facetChanged },
};

export function ExampleDrillDown({ results, changed }: {
  results: EvalResults;
  /** The cases whose outcome moved against the eval this one is compared with, while comparing. */
  changed?: ReadonlySet<string>;
}) {
  // KEPT PER EVAL in the store, so the cell whose trace was opened is still open on the way back —
  // and so is the facet it was found under.
  const openCell = useEvalStore((s) => s.openCellByEval[results.evalId] ?? null);
  const setOpenCell = (jobId: string | null): void => useEvalStore.getState().setOpenCell(results.evalId, jobId);
  const chosen = useEvalStore((s) => s.caseFacetByEval[results.evalId] ?? "all");
  const providerModels = useProviderStore((s) => s.models);

  // Criterion ids, taken from whichever cell has a breakdown — the rubric is the same for
  // the whole eval, so any scored cell names them all.
  const criteria = Object.keys(
    results.rows.flatMap((r) => r.cells).find((c) => c.perCriterion)?.perCriterion ?? {},
  );

  if (!results.rows.length) return null;

  // THE QUESTIONS SOMEBODY OPENS THE CASES TO ASK, as the trace's step filters are drawn: how many
  // each holds, Failed in red the moment there is one, and an empty one greyed in place rather than
  // gone — a filter whose options come and go is a row whose buttons move under the pointer.
  // Unscored is offered only when the judge scored something, since with it off every case is;
  // Changed only while there is an eval to have changed against.
  const counts = facetCounts(results.rows, changed);
  const anyScored = results.rows.some((r) => r.cells.some((c) => c.score !== null));
  const offered = CASE_FACETS.filter((f) => (f === "changed" ? changed !== undefined : f === "unscored" ? anyScored : true));
  const facet: CaseFacet = offered.includes(chosen) ? chosen : "all";
  const options = offered.map((f) => ({
    value: f,
    text: FACET_TEXT[f].text,
    glyph: FACET_TEXT[f].Mark,
    count: counts[f],
    // EACH COUNT IN THE COLOUR OF WHAT IT COUNTS, once there is something to count: a failure red, a
    // disagreement the caution blue, a change the judge's purple; every case and the unscored grey.
    tone: (counts[f] > 0 ? FACET_TONE[f] : "neutral") as PillTone,
    alert: f === "failed" && counts.failed > 0,
    // Never disable the one that is chosen: it must stay pressable to read as chosen.
    disabled: counts[f] === 0 && f !== facet,
    label: counts[f] === 0 ? `Show ${FACET_TEXT[f].noun} — this eval has none` : `Show ${FACET_TEXT[f].noun}`,
  }));
  // THE NUMBERS STAY EACH CASE'S OWN, so "case 7" is case 7 under any facet.
  const shown = results.rows.map((row, i) => ({ row, i })).filter(({ row }) => rowIs(row, facet, changed));

  return (
    <section className="mt-5" aria-label="Cases">
      <SectionHeader name="Cases" count={results.rows.length} icon={Icon.evals.cases} className="mb-1.5 min-h-8 flex-wrap">
        {offered.length > 1 && (
          // shadcn's ToggleGroup: one facet in force, its count a badge in the facet's own colour.
          <div className="ml-auto max-w-full overflow-x-auto">
            <ToggleGroup
              value={facet}
              onValueChange={(f) => useEvalStore.getState().setCaseFacet(results.evalId, f as CaseFacet)}
              aria-label="Show cases"
            >
              {options.map((o) => (
                <ToggleGroupItem
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  aria-label={o.label}
                  title={o.label}
                  className={o.alert ? "text-err hover:text-err data-[state=on]:text-err" : ""}
                >
                  <o.glyph size={ICON.xs} />
                  {o.text}
                  <Pill tone={o.tone} className="h-4 px-1">{o.count}</Pill>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
      </SectionHeader>
      {shown.length === 0 ? (
        <Alert className="py-3 text-faint">
          <Icon.evals.facetAll size={ICON.xs} className="shrink-0" />
          No case is in this view.
        </Alert>
      ) : (
        <div className="divide-y divide-hair overflow-hidden rounded-card border border-hair bg-panel">
          {shown.map(({ row, i }) => {
            const open = row.cells.find((c) => c.jobId === openCell);
            return (
              // THE OPEN CASE IS THE LINE THE CURSOR IS ON: the elevated ground and the ink bar down its edge.
              <div key={row.exampleId} data-example-id={row.exampleId} className={`px-3 py-2.5 transition-colors ${open ? "bg-elevated shadow-[inset_2px_0_0] shadow-ink" : "hover:bg-active/40"}`}>
                <div className="flex items-start gap-3">
                  <span className="text-faint text-tiny tabular-nums w-5 shrink-0 text-right select-none pt-0.5">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* LINE BREAKS KEPT, LONG CASES FOLDED. The input was one run-on paragraph with every
                        newline collapsed, so a Liven case's `---` between the job and the résumé ran
                        into the text — and a whole case filled the panel. */}
                    <ClampedText text={row.input} lines={3} className="text-caption text-ink" />
                    {row.expected && (
                      <div className="mt-1 flex items-start gap-1.5 text-tiny text-muted" title="What this case expected">
                        <Icon.evals.expected size={ICON.xs} className="mt-px shrink-0 text-reviewed" />
                        <ClampedText text={row.expected} lines={2} className="min-w-0" />
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {row.cells.map((c) => (
                        <ScoreChip
                          key={c.jobId}
                          cell={c}
                          name={modelName(providerModels, c.model)}
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
                        labelOf={(id) => criterionLabel(results, id)}
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
      )}
    </section>
  );
}
