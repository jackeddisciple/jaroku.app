// Comparison dashboard (doc §6.4): quality / cost / latency per provider.
//
// This is the screen the doc's cost warning is aimed at — "wrong cost numbers destroy trust
// instantly" — so the rendering rules are as load-bearing as the arithmetic behind them:
//
//   * An unpriced model shows "unknown", never "$0.00". Those are different claims, and a
//     $0.00 in a comparison reads as "this provider is free".
//   * A partially-priced run shows its cost with a "≥" — the figure is a floor, not a total.
//   * Quality averages only what was actually scored, and says how many weren't. A judge
//     that failed says nothing about the provider and must not be averaged in as a zero.
//   * The comparison cost and the true spend are shown as separate things, because they
//     answer different questions: "which is cheaper per run" and "what did this cost me".

import { fmtBudget, fmtCost, fmtLatency, fmtPercent, fmtTokens } from "../lib/format.ts";
import { evalDuration, leaders } from "../lib/evalView.ts";
import { useNarrowerThan } from "../lib/useNarrower.ts";
import {
  download,
  exportStem,
  resultsToCsv,
  resultsToJson,
  summaryToCsv,
} from "../lib/evalExport.ts";
import { ICON } from "../lib/tokens.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { MetricFigure, type MetricFigureProps } from "./MetricFigure.tsx";
import { useUiStore } from "../store/uiStore.ts";
import { ModelLabel, Pill, RanOkMark, SectionFold } from "./evalUi.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";
import { cn } from "../lib/utils.ts";
import type { EvalResults, ProviderMetrics } from "../types.ts";

/**
 * "This one leads the column", as the column's own mark in a green pill beside the figure it leads
 * on — a crown for quality, coins for the cheapest, a flash for the fastest — so three leads on one
 * row are three different marks rather than three identical ticks somebody has to hover to tell apart.
 */
function LeadMark({ title, Mark }: { title: string; Mark: IconComponent }) {
  return (
    <span className="ml-1.5 inline-flex align-middle" role="img" aria-label={title}>
      <Pill icon={Mark} tone="ok" title={title} className="px-1" />
    </span>
  );
}

/** A column's head: its mark, then its word — the same mark the card's fact carries. */
function Head({ Mark, children, title, align = "right", className = "" }: {
  Mark: IconComponent;
  children: React.ReactNode;
  title?: string;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <TableHead className={cn(align === "left" ? "text-left" : "text-right", className)} title={title}>
      <span className={`inline-flex items-center gap-1 ${align === "left" ? "" : "justify-end"}`}>
        <Mark size={ICON.badge} />
        {children}
      </span>
    </TableHead>
  );
}

/** Cost cell. The four states — known, unknown, floor, nothing to compare — must stay visually distinct. */
function CostCell({ p }: { p: ProviderMetrics }) {
  // NOTHING SUCCEEDED, NOTHING TO COMPARE. "$0.00" here read as "this model is free" for a model that
  // went 0 of 6 — and whose failed attempts did cost money, which is in Spent below.
  if (p.succeeded === 0) {
    return (
      <span className="text-faint" title="Nothing succeeded, so there is no per-run cost to compare. What the attempts cost is under Spent.">
        —
      </span>
    );
  }
  if (p.costUnknown) {
    return (
      <span className="text-faint" title={`No pricing entry for ${p.model} — cost is unknown, not zero`}>
        unknown
      </span>
    );
  }
  return (
    <span className="text-ink tabular-nums" title={p.costIncomplete ? "Some steps could not be priced — this is a floor" : undefined}>
      {/* A FLOOR IS A CAUTION, NOT SOMETHING RUNNING: the info blue, not the amber that means in flight. */}
      {p.costIncomplete && <span className="text-warn">≥</span>}
      {fmtCost(p.comparisonCostUsd ?? 0)}
    </span>
  );
}

/**
 * What one answered run cost — the figure the table compares on — in the same four states as the
 * total: known, unknown, a floor, or nothing answered to compare.
 */
function PerRunCell({ p }: { p: ProviderMetrics }) {
  if (p.succeeded === 0) return <span className="text-faint" title="Nothing succeeded, so there is no per-run cost to compare">—</span>;
  if (p.costUnknown) return <span className="text-faint" title={`No pricing entry for ${p.model} — cost is unknown, not zero`}>unknown</span>;
  return (
    <span className="text-ink tabular-nums" title={p.costIncomplete ? "Some steps could not be priced — this is a floor" : undefined}>
      {p.costIncomplete && <span className="text-warn">≥</span>}
      {fmtCost(p.costPerRunUsd ?? 0)}
    </span>
  );
}

/**
 * Quality as a number and a bar — the bar so a column of them can be read at a glance, the number
 * so it can be read exactly. Built as the step details' token split is: a fill on a rounded track.
 * The leader's fill is ink and the rest are muted, so the lead reads before any number does.
 */
function QualityCell({ p, lead = false }: { p: ProviderMetrics; lead?: boolean }) {
  if (p.qualityScore === null) {
    return (
      <span className="text-faint" title={p.unscored ? `${p.unscored} run(s) unscored` : "not scored"}>
        —
      </span>
    );
  }
  // Colour only at the extremes; the doc's palette reserves status colours for meaning.
  const tone = p.qualityScore >= 0.8 ? "text-ok" : p.qualityScore < 0.4 ? "text-err" : "text-ink";
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {/* THE BAR IN THE SCORE'S OWN BAND — green from 80, red under 40, ink between — and the leader's
          at full strength, the rest a step back, so the lead still reads before any number does. */}
      <span aria-hidden className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-active">
        <span className={`block h-full rounded-full ${p.qualityScore >= 0.8 ? "bg-ok" : p.qualityScore < 0.4 ? "bg-err" : "bg-ink"} ${lead ? "" : "opacity-60"}`} style={{ width: `${Math.round(p.qualityScore * 100)}%` }} />
      </span>
      <span className={`${tone} tabular-nums`}>
        {(p.qualityScore * 100).toFixed(0)}
        <span className="text-faint text-tiny ml-0.5">/100</span>
      </span>
      {/* UNSCORED IS NOT ZERO, so it is said beside the average rather than folded into it. */}
      {p.unscored > 0 && (
        <Pill icon={Icon.evals.facetUnscored} title={`${p.unscored} unscored — answers the judge did not score, left out of the average`}>
          {p.unscored}
        </Pill>
      )}
    </span>
  );
}

// The lead markers' rule lives with the verdict it shares a judgement with — see lib/evalView.ts.
export { leaders };

/**
 * "Ran OK": how many of the jobs that RAN finished without failing, with what did not run said apart.
 *
 * IT WAS "PASSED", AND IT MEANT NEITHER. It meant the run did not crash — not that the judge passed
 * it — and its denominator counted work that never ran: `2/15` after a budget stop cancelled
 * thirteen, `0/6` while five were still queued. The percentage only appeared when something failed.
 */
function RanOk({ p }: { p: ProviderMetrics }) {
  const ran = p.succeeded + p.failed;
  const notes = [
    (p.cancelled ?? 0) > 0 ? `${p.cancelled} cancelled` : null,
    (p.pending ?? 0) > 0 ? `${p.pending} waiting` : null,
  ].filter(Boolean);
  // EVERY JOB AS A LENGTH: answered, failed, and the rest — cancelled or still to run — as the empty
  // track. The progress bar's own construction, so a finished leg reads as a finished bar.
  const share = (n: number): string => `${p.total > 0 ? (n / p.total) * 100 : 0}%`;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums">
      <span aria-hidden className="flex h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-active">
        <span className="h-full bg-ok" style={{ width: share(p.succeeded) }} />
        <span className="h-full bg-err" style={{ width: share(p.failed) }} />
      </span>
      <span className={p.failed > 0 ? "text-err" : "text-muted"}>
        {p.succeeded}/{ran}
      </span>
      {ran > 0 && <span className="text-faint text-tiny ml-1">{fmtPercent(p.successRate, "share")}</span>}
      {notes.length > 0 && <span className="text-faint text-tiny ml-1">· {notes.join(" · ")}</span>}
    </span>
  );
}

/** How many answers met their case's expected output, of those checked. */
function MatchCell({ p }: { p: ProviderMetrics }) {
  const checked = p.checked ?? 0;
  const matched = p.matched ?? 0;
  if (!checked) return <span className="text-faint">—</span>;
  return (
    <span>
      <span className={matched === checked ? "text-ok" : matched === 0 ? "text-err" : "text-ink"}>{matched}/{checked}</span>
      <span className="text-faint text-tiny ml-1">{fmtPercent(matched / checked, "share")}</span>
    </span>
  );
}

/** The table's row as a card, for a panel too narrow for seven columns. */
function ProviderCard({ p, lead }: { p: ProviderMetrics; lead: ReturnType<typeof leaders> }) {
  // EACH FACT BEHIND THE SAME MARK AS ITS TABLE COLUMN, so a card and a row of the same model are
  // read the same way — and the marks, in one column down the card, are what the eye runs along.
  const fact = (Mark: IconComponent, label: string, value: React.ReactNode) => (
    <div className="flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-faint"><Mark size={ICON.xs} />{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
  return (
    <div className="rounded-card border border-hair bg-elevated px-3 py-2.5 text-caption">
      <div className="-mx-3 mb-2 flex items-center gap-1 border-b border-hair px-3 pb-2">
        <ModelLabel provider={p.provider} model={p.model} className="text-label text-ink" />
        {lead.best === p.model && <LeadMark title="highest quality" Mark={Icon.evals.bestQuality} />}
        {lead.cheapest === p.model && <LeadMark title="cheapest per run" Mark={Icon.evals.cheapest} />}
        {lead.fastest === p.model && <LeadMark title="fastest" Mark={Icon.evals.fastest} />}
      </div>
      <div className="space-y-1 text-tiny">
        {fact(Icon.evals.quality, "Quality", <QualityCell p={p} lead={lead.best === p.model} />)}
        {fact(Icon.evals.cost, "Cost", <CostCell p={p} />)}
        {fact(Icon.evals.perRun, "Per run", <span className="text-muted tabular-nums">{p.costUnknown || p.succeeded === 0 ? "—" : fmtCost(p.costPerRunUsd ?? 0)}</span>)}
        {fact(Icon.evals.latency, "p50 · p95", <span className="text-muted tabular-nums">{fmtLatency(p.latencyP50Ms)} · {fmtLatency(p.latencyP95Ms)}</span>)}
        {(p.checked ?? 0) > 0 && fact(Icon.evals.matches, "Matches", <MatchCell p={p} />)}
        {fact(RanOkMark, "Ran OK", <RanOk p={p} />)}
        {/* WHAT IT ACTUALLY COST AND USED — every attempt, failed ones included — which the server
            sent for each model and nothing drew. */}
        {fact(Icon.evals.spent, "Spent", <span className="text-muted tabular-nums">{fmtCost(p.spentUsd)}</span>)}
        {fact(Icon.evals.tokens, "Tokens", <span className="text-muted tabular-nums">{fmtTokens(p.tokens)}</span>)}
      </div>
    </div>
  );
}

/**
 * The eval as a whole, as the trace's strip shows a run: what it spent, how much of it ran, what
 * scoring cost and how long it took — each a mark, a word and a large number.
 *
 * THE SPEND WAS A LINE OF SMALL TEXT AT THE FOOT OF THE TABLE, the same size as its own caveats. It
 * answers a different question from the table — "what did this cost me", failed attempts and the
 * judge included, against "which model is cheaper per run" — so it leads now, in figures, and the
 * table under it keeps to the comparison. Judging that never ran is "not scored", not $0.00.
 */
export function EvalFigures({ results }: { results: EvalResults }) {
  const { totals, providers } = results;
  const over = totals.budgetUsd !== null && totals.trueSpendUsd >= totals.budgetUsd;
  const floor = providers.some((p) => p.costIncomplete);
  const sum = (f: (p: ProviderMetrics) => number): number => providers.reduce((n, p) => n + f(p), 0);
  const ok = sum((p) => p.succeeded);
  const ran = sum((p) => p.succeeded + p.failed);
  const cancelled = sum((p) => p.cancelled ?? 0);
  const waiting = sum((p) => p.pending ?? 0);
  const scored = sum((p) => p.scored);
  const duration = evalDuration(results);
  const live = results.status === "running" || results.status === "queued";
  const [box, narrow] = useNarrowerThan<HTMLDivElement>(FIGURES_WRAP_PX);
  const figures: MetricFigureProps[] = [
    {
      Mark: Icon.trace.metricCost,
      label: "Spent",
      value: `${floor ? "≥ " : ""}${fmtCost(totals.trueSpendUsd)}`,
      tone: over ? "text-err" : "text-ink",
      note: totals.budgetUsd !== null ? `of ${fmtBudget(totals.budgetUsd)} budget${over ? " — ceiling reached" : ""}` : "no ceiling",
      // THE CEILING AS A LENGTH. Red once it is reached; there is no bar where there is no ceiling.
      meter: totals.budgetUsd ? { value: totals.trueSpendUsd / totals.budgetUsd, tone: over ? "bg-err" : "bg-muted" } : undefined,
      title: `${fmtCost(totals.agentSpendUsd)} on agent runs and ${fmtCost(totals.judgeCostUsd)} on the judge, failed attempts included — the comparison below leaves those out`
        + (floor ? ". Some steps could not be priced, so this is a floor" : ""),
    },
    {
      Mark: Icon.trace.metricSteps,
      label: "Ran OK",
      value: `${ok}/${ran}`,
      // EVERY RUN THAT RAN, ANSWERED, reads green — a success, said in the success colour.
      tone: ran > 0 && ok === ran ? "text-ok" : "text-ink",
      meter: ran ? { value: ok / ran, tone: ok === ran ? "bg-ok" : "bg-muted" } : undefined,
      note: [cancelled ? `${cancelled} cancelled` : null, waiting ? `${waiting} waiting` : null].filter(Boolean).join(" · ")
        || (ran ? fmtPercent(ok / ran, "share") : "nothing has run yet"),
      title: "Of the jobs that ran, how many finished without failing. Not a judgement of the answer.",
    },
    {
      Mark: Icon.trace.metricCalls,
      label: "Judge",
      value: scored > 0 ? fmtCost(totals.judgeCostUsd) : "—",
      note: scored > 0 ? `${scored} of ${ok} scored` : "not scored",
      title: "What scoring the answers cost. It is the same model for every leg, so it is kept out of each model's figures.",
    },
    {
      Mark: Icon.trace.time,
      label: "Duration",
      value: duration ?? (live ? "running" : "—"),
      tone: live ? "text-run" : "text-ink",
      title: "From the eval's first run to its last",
    },
  ];
  return (
    // A GRID OF STAT CARDS THAT FITS THE PANEL IT IS IN. Four abreast at the panel's narrowest cut every
    // figure to "Spe… ≥ $0…", so below `FIGURES_WRAP_PX` they sit two by two. The hairlines are the
    // grid's 1px gaps on a hairline ground, so they are right in either layout — the trace strip's
    // `divide-x` would draw a stray edge down the left of the second row.
    <div ref={box} className="mb-4 grid gap-px overflow-hidden rounded-card border border-hair bg-hair" style={{ gridTemplateColumns: `repeat(${narrow ? 2 : figures.length}, minmax(0, 1fr))` }}>
      {figures.map((f) => <div key={f.label} className="bg-panel"><MetricFigure {...f} /></div>)}
    </div>
  );
}

/** Narrower than this, an eval's four figures cannot each show their number; they go two by two. */
const FIGURES_WRAP_PX = 460;

/**
 * Narrower than this, the table's columns are clipped; the rows become cards. 640 since quality is a
 * bar and models go by their names: at 560 the table cut "Ran OK" in half at the panel's default
 * width, with nothing to say so but a sideways scroll macOS does not draw. 700 since each lead wears
 * its own mark beside the figure it leads on.
 */
const STACK_BELOW_PX = 700;

/** The three files an eval exports, each with what it holds. Offered from the eval's actions. */
export const EXPORTS = [
  { label: "Summary (CSV)", suffix: "-summary.csv", mime: "text/csv", make: summaryToCsv },
  { label: "Every case (CSV)", suffix: "-examples.csv", mime: "text/csv", make: resultsToCsv },
  { label: "Everything (JSON)", suffix: ".json", mime: "application/json", make: resultsToJson },
] as const;

/** Write one export and say where it went. */
export function saveExport(results: EvalResults, x: (typeof EXPORTS)[number], agentName: string | undefined): string {
  const filename = `${exportStem(results)}${x.suffix}`;
  download(filename, x.make(results, { agentName }), x.mime);
  useUiStore.getState().showToast(`Saved to Downloads as ${filename}`, "ok");
  return filename;
}

export function ComparisonTable({
  results,
  onSelectProvider,
}: {
  results: EvalResults;
  onSelectProvider?: (p: ProviderMetrics) => void;
}) {
  const lead = leaders(results.providers);
  // A MATCHES COLUMN, only when the eval checked answers against `expected` — see expectedMatch.ts.
  const checking = results.providers.some((p) => (p.checked ?? 0) > 0);
  // HOW WIDE THE PANEL ACTUALLY IS. Below about 600px the columns were clipped with nothing to say so.
  const [box, narrow] = useNarrowerThan<HTMLDivElement>(STACK_BELOW_PX);

  return (
    <div ref={box}>
      <EvalFigures results={results} />
      {/* THE COMPARISON AS A SECTION OF ITS OWN — an editor's folding section over shadcn's Table, so
          the cases under it can be reached without a scroll past a comparison already read. */}
      <SectionFold icon={Icon.evals.models} label="Models" count={results.providers.length} ariaLabel="Models">
        {narrow ? (
          <div className="space-y-2">
            {results.providers.map((p) => <ProviderCard key={`${p.provider} ${p.model}`} p={p} lead={lead} />)}
          </div>
        ) : (
        <div className="overflow-hidden rounded-card border border-hair bg-elevated">
          <Table>
            <TableHeader>
              <tr>
                <Head Mark={Icon.evals.models} align="left" className="pl-3 pr-3">Model</Head>
                <Head Mark={Icon.evals.quality} className="px-2" title="The judge's mean score, over the answers it scored">Quality</Head>
                {/* PER RUN AND NOT THE TOTAL, in the table: it is the like-for-like figure, and the total is in
                    each row's tooltip and on the cards. Both columns did not fit beside each lead's mark. */}
                <Head Mark={Icon.evals.perRun} className="px-2" title="The mean cost of one answered run — the like-for-like figure">Per run</Head>
                <Head Mark={Icon.evals.latency} className="px-2" title="Latency of an answered run: the median, then the 95th percentile">p50 · p95</Head>
                {checking && (
                  <Head Mark={Icon.evals.matches} className="px-2" title={`Answers that met the case's expected output (${results.checkMode ?? "checked"})`}>Matches</Head>
                )}
                {/* A TICK, WHITE ON GREEN, even in a header (the product owner, 2026-10-31). */}
                <Head Mark={RanOkMark} className="pl-2 pr-3" title="Of the jobs that ran, how many finished without failing. Not a judgement of the answer.">Ran OK</Head>
              </tr>
            </TableHeader>
            <TableBody>
              {results.providers.map((p) => (
                <TableRow
                  key={`${p.provider} ${p.model}`}
                  onClick={() => onSelectProvider?.(p)}
                  title={`${p.provider} · ${p.model} — ${p.costUnknown ? "cost unknown" : `${fmtCost(p.comparisonCostUsd ?? 0)} on answered runs`}; ${fmtCost(p.spentUsd)} spent and ${fmtTokens(p.tokens)} used, failed attempts included`}
                  className={onSelectProvider ? "cursor-pointer" : ""}
                >
                  {/* A model's name breaks as a unit or not at all. While the judge is still scoring, the
                      quality column carries an extra "· N unscored" and squeezes this one — which was
                      enough to wrap "claude-haiku-4-5" after the hyphen, leaving a row headed
                      "claude-haiku-4-" over a lone "5". The name of the thing being compared is the last
                      text in a comparison table that should be guessable. */}
                  <TableCell className="pl-3 pr-3">
                    <ModelLabel provider={p.provider} model={p.model} className="whitespace-nowrap text-label text-ink" />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <QualityCell p={p} lead={lead.best === p.model} />
                    {lead.best === p.model && p.qualityScore !== null && (
                      <LeadMark title="highest quality" Mark={Icon.evals.bestQuality} />
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <PerRunCell p={p} />
                    {lead.cheapest === p.model && !p.costUnknown && (
                      <LeadMark title="cheapest per run" Mark={Icon.evals.cheapest} />
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted tabular-nums whitespace-nowrap">
                    {fmtLatency(p.latencyP50Ms)}
                    <span className="text-faint"> · {fmtLatency(p.latencyP95Ms)}</span>
                    {lead.fastest === p.model && p.latencyP50Ms !== null && (
                      <LeadMark title="fastest" Mark={Icon.evals.fastest} />
                    )}
                  </TableCell>
                  {checking && (
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      <MatchCell p={p} />
                    </TableCell>
                  )}
                  <TableCell className="pl-2 pr-3 text-right">
                    <RanOk p={p} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        )}
      </SectionFold>
    </div>
  );
}
