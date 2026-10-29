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
import { TYPE } from "../lib/tokens.ts";
import { Icon } from "../lib/icons/registry.ts";
import { CheckIcon } from "./panelIcons.tsx";
import { FIGURE_STRIP, MetricFigure, type MetricFigureProps } from "./MetricFigure.tsx";
import { modelName, useProviderStore } from "../store/providerStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { EvalResults, ProviderMetrics } from "../types.ts";

/**
 * "This one leads the column." A green check rather than the `●` it replaces: a coloured bullet
 * character is the same shape as every other bullet on the screen, and this one is the only mark
 * in the table that means something. Same check the rest of the app uses for "this is the good
 * one", at the same weight.
 */
function LeadMark({ title }: { title: string }) {
  return (
    <span className="ml-1 inline-flex align-middle text-ok" title={title}>
      <CheckIcon size={ICON.xs} />
    </span>
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
      <span aria-hidden className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-active">
        <span className={`block h-full rounded-full ${lead ? "bg-ink" : "bg-muted"}`} style={{ width: `${Math.round(p.qualityScore * 100)}%` }} />
      </span>
      <span className={`${tone} tabular-nums`}>
        {(p.qualityScore * 100).toFixed(0)}
        <span className="text-faint text-tiny ml-0.5">
          /100{p.unscored > 0 && ` · ${p.unscored} unscored`}
        </span>
      </span>
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
  return (
    <span className="whitespace-nowrap tabular-nums">
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
function ProviderCard({ p, lead, name, showProvider }: { p: ProviderMetrics; lead: ReturnType<typeof leaders>; name: string; showProvider: boolean }) {
  const fact = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-faint">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
  return (
    <div className="rounded-card border border-hair bg-panel px-3 py-2.5 text-caption">
      <div className="pb-1.5" title={`${p.provider} · ${p.model}`}>
        <span className="text-label text-ink">{name}</span>
        {showProvider && <span className="text-faint ml-1.5 text-tiny">{p.provider}</span>}
      </div>
      <div className="space-y-0.5 text-tiny">
        {fact("Quality", <><QualityCell p={p} lead={lead.best === p.model} />{lead.best === p.model && <LeadMark title="highest quality" />}</>)}
        {fact("Cost", <CostCell p={p} />)}
        {fact("Per run", <span className="text-muted tabular-nums">{p.costUnknown || p.succeeded === 0 ? "—" : fmtCost(p.costPerRunUsd ?? 0)}{lead.cheapest === p.model && <LeadMark title="cheapest per run" />}</span>)}
        {fact("p50 · p95", <span className="text-muted tabular-nums">{fmtLatency(p.latencyP50Ms)} · {fmtLatency(p.latencyP95Ms)}{lead.fastest === p.model && <LeadMark title="fastest" />}</span>)}
        {(p.checked ?? 0) > 0 && fact("Matches", <MatchCell p={p} />)}
        {fact("Ran OK", <RanOk p={p} />)}
        {/* WHAT IT ACTUALLY COST AND USED — every attempt, failed ones included — which the server
            sent for each model and nothing drew. */}
        {fact("Spent", <span className="text-muted tabular-nums">{fmtCost(p.spentUsd)}</span>)}
        {fact("Tokens", <span className="text-muted tabular-nums">{fmtTokens(p.tokens)}</span>)}
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
  const figures: MetricFigureProps[] = [
    {
      Mark: Icon.trace.metricCost,
      label: "Spent",
      value: `${floor ? "≥ " : ""}${fmtCost(totals.trueSpendUsd)}`,
      tone: over ? "text-err" : "text-ink",
      note: totals.budgetUsd !== null ? `of ${fmtBudget(totals.budgetUsd)} budget${over ? " — ceiling reached" : ""}` : "no ceiling",
      title: `${fmtCost(totals.agentSpendUsd)} on agent runs and ${fmtCost(totals.judgeCostUsd)} on the judge, failed attempts included — the comparison below leaves those out`
        + (floor ? ". Some steps could not be priced, so this is a floor" : ""),
    },
    {
      Mark: Icon.trace.metricSteps,
      label: "Ran OK",
      value: `${ok}/${ran}`,
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
    <div className={`${FIGURE_STRIP} mb-4`} style={{ gridTemplateColumns: `repeat(${figures.length}, minmax(0, 1fr))` }}>
      {figures.map((f) => <MetricFigure key={f.label} {...f} />)}
    </div>
  );
}

/**
 * Narrower than this, the table's columns are clipped; the rows become cards. 640 since quality is a
 * bar and models go by their names: at 560 the table cut "Ran OK" in half at the panel's default
 * width, with nothing to say so but a sideways scroll macOS does not draw.
 */
const STACK_BELOW_PX = 640;

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
  // The models by the names the run bar uses — "Haiku 4.5" — with the id where the catalogue has none.
  const providerModels = useProviderStore((s) => s.models);
  const name = (model: string): string => modelName(providerModels, model);
  // THE PROVIDER ONLY WHERE IT TELLS THE ROWS APART — an eval across Anthropic and OpenAI. With one
  // provider it was the same word on every row, in the column the table could least spare.
  const mixed = new Set(results.providers.map((p) => p.provider)).size > 1;
  // HOW WIDE THE PANEL ACTUALLY IS. Below about 600px the columns were clipped with nothing to say so.
  const [box, narrow] = useNarrowerThan<HTMLDivElement>(STACK_BELOW_PX);
  const cell = (first: boolean): string => `py-2 ${first ? "" : "border-t border-hair"}`;

  return (
    <div ref={box}>
      <EvalFigures results={results} />
      {/* THE COMPARISON AS A SECTION OF ITS OWN — its word over it and the table in the trace's card —
          rather than a bare table under a line of text. */}
      <section aria-label="Models">
        <div className="mb-1.5 flex min-h-8 items-center gap-2">
          <span className={TYPE.sectionLabel}>Models</span>
        </div>
        {narrow ? (
          <div className="space-y-2">
            {results.providers.map((p) => <ProviderCard key={`${p.provider} ${p.model}`} p={p} lead={lead} name={name(p.model)} showProvider={mixed} />)}
          </div>
        ) : (
        <div className="overflow-x-auto rounded-card border border-hair bg-panel">
          <table className="w-full text-caption border-separate border-spacing-0">
            <thead>
              <tr className={TYPE.sectionLabel}>
                <th className="text-left font-normal pb-1.5 pt-2.5 pl-3 pr-3">Model</th>
                <th className="text-right font-normal pb-1.5 pt-2.5 px-2">Quality</th>
                <th className="text-right font-normal pb-1.5 pt-2.5 px-2">Cost</th>
                <th className="text-right font-normal pb-1.5 pt-2.5 px-2">Per run</th>
                <th className="text-right font-normal pb-1.5 pt-2.5 px-2">p50</th>
                <th className="text-right font-normal pb-1.5 pt-2.5 px-2">p95</th>
                {checking && (
                  <th className="text-right font-normal pb-1.5 pt-2.5 px-2" title={`Answers that met the case's expected output (${results.checkMode ?? "checked"})`}>Matches</th>
                )}
                <th className="text-right font-normal pb-1.5 pt-2.5 pl-2 pr-3" title="Of the jobs that ran, how many finished without failing. Not a judgement of the answer.">Ran OK</th>
              </tr>
            </thead>
            <tbody>
              {results.providers.map((p, i) => (
                <tr
                  key={`${p.provider} ${p.model}`}
                  onClick={() => onSelectProvider?.(p)}
                  title={`${p.provider} · ${p.model} — ${fmtCost(p.spentUsd)} spent and ${fmtTokens(p.tokens)} used, failed attempts included`}
                  className={`${onSelectProvider ? "cursor-pointer hover:bg-active/40" : ""} transition-colors`}
                >
                  {/* A model's name breaks as a unit or not at all. While the judge is still scoring, the
                      quality column carries an extra "· N unscored" and squeezes this one — which was
                      enough to wrap "claude-haiku-4-5" after the hyphen, leaving a row headed
                      "claude-haiku-4-" over a lone "5". The name of the thing being compared is the last
                      text in a comparison table that should be guessable. */}
                  <td className={`${cell(i === 0)} pl-3 pr-3`}>
                    <span className="whitespace-nowrap text-label text-ink">{name(p.model)}</span>
                    {mixed && <span className="text-faint ml-1.5 text-tiny">{p.provider}</span>}
                  </td>
                  <td className={`${cell(i === 0)} px-2 text-right whitespace-nowrap`}>
                    <QualityCell p={p} lead={lead.best === p.model} />
                    {lead.best === p.model && p.qualityScore !== null && (
                      <LeadMark title="highest quality" />
                    )}
                  </td>
                  <td className={`${cell(i === 0)} px-2 text-right`}><CostCell p={p} /></td>
                  <td className={`${cell(i === 0)} px-2 text-right whitespace-nowrap`}>
                    <span className="text-muted tabular-nums">
                      {p.costUnknown || p.succeeded === 0 ? "—" : fmtCost(p.costPerRunUsd ?? 0)}
                    </span>
                    {lead.cheapest === p.model && !p.costUnknown && (
                      <LeadMark title="cheapest per run" />
                    )}
                  </td>
                  <td className={`${cell(i === 0)} px-2 text-right text-muted tabular-nums whitespace-nowrap`}>
                    {fmtLatency(p.latencyP50Ms)}
                    {lead.fastest === p.model && p.latencyP50Ms !== null && (
                      <LeadMark title="fastest" />
                    )}
                  </td>
                  <td className={`${cell(i === 0)} px-2 text-right text-muted tabular-nums`}>{fmtLatency(p.latencyP95Ms)}</td>
                  {checking && (
                    <td className={`${cell(i === 0)} px-2 text-right whitespace-nowrap tabular-nums`}>
                      <MatchCell p={p} />
                    </td>
                  )}
                  <td className={`${cell(i === 0)} pl-2 pr-3 text-right`}>
                    <RanOk p={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </div>
  );
}
