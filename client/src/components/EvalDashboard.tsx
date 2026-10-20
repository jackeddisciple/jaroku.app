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

import { useEffect, useRef, useState } from "react";
import { fmtBudget, fmtCost, fmtLatency, fmtPercent } from "../lib/format.ts";
import {
  download,
  exportStem,
  resultsToCsv,
  resultsToJson,
  summaryToCsv,
} from "../lib/evalExport.ts";
import { ICON } from "../lib/tokens.ts";
import { TYPE } from "../lib/tokens.ts";
import { CheckIcon, ChevronDownIcon } from "./panelIcons.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { useBuildStore } from "../store/buildStore.ts";
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
      {p.costIncomplete && <span className="text-run">≥</span>}
      {fmtCost(p.comparisonCostUsd ?? 0)}
    </span>
  );
}

function QualityCell({ p }: { p: ProviderMetrics }) {
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
    <span className={`${tone} tabular-nums`}>
      {(p.qualityScore * 100).toFixed(0)}
      <span className="text-faint text-tiny ml-0.5">
        /100{p.unscored > 0 && ` · ${p.unscored} unscored`}
      </span>
    </span>
  );
}

/**
 * The best (lowest cost / highest quality / fastest) leg, for a subtle lead marker.
 *
 * ONLY WHERE THERE IS A COMPARISON. With one model holding a figure, "cheapest" and "fastest" were
 * drawn beside it anyway — a lead over nobody.
 */
export function leaders(providers: ProviderMetrics[]) {
  const priced = providers.filter((p) => !p.costUnknown && p.comparisonCostUsd !== null && p.succeeded > 0);
  const scored = providers.filter((p) => p.qualityScore !== null);
  const timed = providers.filter((p) => p.latencyP50Ms !== null);
  return {
    // Cheapest is per-run, not total: totals differ if some legs had more failures.
    cheapest: priced.length > 1
      ? priced.reduce((a, b) => ((a.costPerRunUsd ?? Infinity) <= (b.costPerRunUsd ?? Infinity) ? a : b)).model
      : null,
    best: scored.length > 1
      ? scored.reduce((a, b) => ((a.qualityScore ?? 0) >= (b.qualityScore ?? 0) ? a : b)).model
      : null,
    fastest: timed.length > 1
      ? timed.reduce((a, b) => ((a.latencyP50Ms ?? Infinity) <= (b.latencyP50Ms ?? Infinity) ? a : b)).model
      : null,
  };
}

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
function ProviderCard({ p, lead }: { p: ProviderMetrics; lead: ReturnType<typeof leaders> }) {
  const fact = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-faint">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
  return (
    <div className="rounded-card border border-hair px-3 py-2 text-caption">
      <div className="pb-1">
        <span className="text-ink">{p.model}</span>
        <span className="text-faint ml-1.5 text-tiny">{p.provider}</span>
      </div>
      <div className="space-y-0.5 text-tiny">
        {fact("Quality", <><QualityCell p={p} />{lead.best === p.model && <LeadMark title="highest quality" />}</>)}
        {fact("Cost", <CostCell p={p} />)}
        {fact("Per run", <span className="text-muted tabular-nums">{p.costUnknown || p.succeeded === 0 ? "—" : fmtCost(p.costPerRunUsd ?? 0)}{lead.cheapest === p.model && <LeadMark title="cheapest per run" />}</span>)}
        {fact("p50 · p95", <span className="text-muted tabular-nums">{fmtLatency(p.latencyP50Ms)} · {fmtLatency(p.latencyP95Ms)}{lead.fastest === p.model && <LeadMark title="fastest" />}</span>)}
        {(p.checked ?? 0) > 0 && fact("Matches", <MatchCell p={p} />)}
        {fact("Ran OK", <RanOk p={p} />)}
      </div>
    </div>
  );
}

/** Narrower than this, the table's seven columns are clipped; the rows become cards. */
const STACK_BELOW_PX = 560;

/** The three files an eval exports, each with what it holds. */
const EXPORTS = [
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
  const agentName = useBuildStore((s) => s.agents.find((a) => a.agent_id === results.agentId)?.name);
  const { totals } = results;
  const overBudget = totals.budgetUsd !== null && totals.trueSpendUsd >= totals.budgetUsd;
  // HOW WIDE THE PANEL ACTUALLY IS. Below about 600px the columns were clipped with nothing to say so.
  const box = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? Infinity) < STACK_BELOW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="space-y-3" ref={box}>
      {narrow ? (
        <div className="space-y-2">
          {results.providers.map((p) => <ProviderCard key={`${p.provider} ${p.model}`} p={p} lead={lead} />)}
        </div>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-caption border-separate border-spacing-0">
          <thead>
            <tr className={TYPE.sectionLabel}>
              <th className="text-left font-normal pb-1.5 pr-3">Provider</th>
              <th className="text-right font-normal pb-1.5 px-2">Quality</th>
              <th className="text-right font-normal pb-1.5 px-2">Cost</th>
              <th className="text-right font-normal pb-1.5 px-2">Per run</th>
              <th className="text-right font-normal pb-1.5 px-2">p50</th>
              <th className="text-right font-normal pb-1.5 px-2">p95</th>
              {checking && (
                <th className="text-right font-normal pb-1.5 px-2" title={`Answers that met the case's expected output (${results.checkMode ?? "checked"})`}>Matches</th>
              )}
              <th className="text-right font-normal pb-1.5 pl-2" title="Of the jobs that ran, how many finished without failing. Not a judgement of the answer.">Ran OK</th>
            </tr>
          </thead>
          <tbody>
            {results.providers.map((p) => (
              <tr
                key={`${p.provider} ${p.model}`}
                onClick={() => onSelectProvider?.(p)}
                className={`${onSelectProvider ? "cursor-pointer hover:bg-active/40" : ""} transition-colors`}
              >
                {/* A model id is an identifier, so it breaks as a unit or not at all. While the
                    judge is still scoring, the quality column carries an extra "· N unscored" and
                    squeezes this one — which was enough to wrap "claude-haiku-4-5" after the
                    hyphen, leaving a row headed "claude-haiku-4-" over a lone "5". The name of the
                    thing being compared is the last text in a comparison table that should be
                    guessable. */}
                <td className="py-1.5 pr-3">
                  <span className="whitespace-nowrap text-ink">{p.model}</span>
                  <span className="text-faint ml-1.5 text-tiny">{p.provider}</span>
                </td>
                <td className="py-1.5 px-2 text-right whitespace-nowrap">
                  <QualityCell p={p} />
                  {lead.best === p.model && p.qualityScore !== null && (
                    <LeadMark title="highest quality" />
                  )}
                </td>
                <td className="py-1.5 px-2 text-right"><CostCell p={p} /></td>
                <td className="py-1.5 px-2 text-right whitespace-nowrap">
                  <span className="text-muted tabular-nums">
                    {p.costUnknown || p.succeeded === 0 ? "—" : fmtCost(p.costPerRunUsd ?? 0)}
                  </span>
                  {lead.cheapest === p.model && !p.costUnknown && (
                    <LeadMark title="cheapest per run" />
                  )}
                </td>
                <td className="py-1.5 px-2 text-right text-muted tabular-nums whitespace-nowrap">
                  {fmtLatency(p.latencyP50Ms)}
                  {lead.fastest === p.model && p.latencyP50Ms !== null && (
                    <LeadMark title="fastest" />
                  )}
                </td>
                <td className="py-1.5 px-2 text-right text-muted tabular-nums">{fmtLatency(p.latencyP95Ms)}</td>
                {checking && (
                  <td className="py-1.5 px-2 text-right whitespace-nowrap tabular-nums">
                    <MatchCell p={p} />
                  </td>
                )}
                <td className="py-1.5 pl-2 text-right">
                  <RanOk p={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {/* Spend, kept deliberately apart from the comparison figures above. The table answers
          "which provider is cheaper per run"; this answers "what did this eval cost me" —
          and includes the failed attempts and the judge, which the comparison excludes. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-tiny pt-1">
        <span className={TYPE.sectionLabel}>Spent</span>
        <span className={overBudget ? "text-err" : "text-ink"}>
          {fmtCost(totals.trueSpendUsd)} total
        </span>
        <span className="text-muted">{fmtCost(totals.agentSpendUsd)} agent runs</span>
        <span className="text-muted">{fmtCost(totals.judgeCostUsd)} judge</span>
        {totals.budgetUsd !== null && (
          <span className={overBudget ? "text-err" : "text-faint"}>
            of {fmtBudget(totals.budgetUsd)} budget{overBudget ? " — ceiling reached" : ""}
          </span>
        )}
        {results.providers.some((p) => p.costIncomplete) && (
          <span className="text-run">≥ some steps could not be priced</span>
        )}

        {/* Export. Every caveat above survives the trip — unknown cost is an empty cell with a
            cost_known flag beside it, never a 0 a spreadsheet would happily sum. ONE MENU rather
            than three words in a row, and the download SAYS WHERE IT WENT: it used to finish
            without a word, and the desktop app saves to ~/Downloads, which nothing on screen said. */}
        <span className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-1 text-faint transition-colors hover:text-ink" aria-label="Export these results">
                Export
                <ChevronDownIcon size={ICON.xs} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {EXPORTS.map((x) => (
                <DropdownMenuItem key={x.label} onSelect={() => saveExport(results, x, agentName)}>
                  {x.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
    </div>
  );
}
