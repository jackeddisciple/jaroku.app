// Two evals side by side: each model's figures then and now, and each case whose outcome moved.
// See lib/evalCompare.ts for what counts as a change.

import { useMemo, type ReactNode } from "react";
import { compareEvals, type ModelDelta } from "../lib/evalCompare.ts";
import { fmtCost, fmtLatency, fmtPercent, relTime } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { useNarrowerThan } from "../lib/useNarrower.ts";
import { IconButton } from "./IconButton.tsx";
import { FACT_TONE, ModelLabel, Pill } from "./evalUi.tsx";
import type { EvalResults, ProviderMetrics } from "../types.ts";

/**
 * One figure, then and now — and which way it moved, as a mark in the colour of whether that is
 * better. `higher` says which direction is the good one: quality up is good, cost per run up is not.
 */
function Then({ before, after, fmt, higher }: { before: number | null; after: number | null; fmt: (n: number) => string; higher: boolean }) {
  if (before === null && after === null) return <span className="text-faint">—</span>;
  const moved = before !== null && after !== null && fmt(before) !== fmt(after);
  const better = moved && (higher ? after! > before! : after! < before!);
  const Mark = moved ? (after! > before! ? Icon.evals.rose : Icon.evals.fell) : null;
  return (
    <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap tabular-nums">
      <span className="text-faint">{before === null ? "—" : fmt(before)}</span>
      <span className="text-faint">→</span>
      <span className="text-ink">{after === null ? "—" : fmt(after)}</span>
      {Mark && (
        <span className={better ? "text-ok" : "text-err"} role="img" aria-label={better ? "better" : "worse"}>
          <Mark size={ICON.xs} />
        </span>
      )}
    </span>
  );
}

const ranRate = (p: ProviderMetrics | null): number | null => (p && p.succeeded + p.failed > 0 ? p.successRate : null);
const matchRate = (p: ProviderMetrics | null): number | null => (p && (p.checked ?? 0) > 0 ? (p.matched ?? 0) / (p.checked ?? 1) : null);
const share = (n: number) => fmtPercent(n, "share");

/** Each model's figures, then and now, in the order both layouts show them — each behind its column's mark. */
function figures(m: ModelDelta): [string, IconComponent, ReactNode][] {
  return [
    ["Quality", Icon.evals.quality, <Then before={m.before?.qualityScore ?? null} after={m.after?.qualityScore ?? null} fmt={(n) => String(Math.round(n * 100))} higher />],
    ["Ran OK", Icon.evals.ranOk, <Then before={ranRate(m.before)} after={ranRate(m.after)} fmt={share} higher />],
    ["Matches", Icon.evals.matches, <Then before={matchRate(m.before)} after={matchRate(m.after)} fmt={share} higher />],
    ["Per run", Icon.evals.perRun, <Then before={m.before?.costPerRunUsd ?? null} after={m.after?.costPerRunUsd ?? null} fmt={fmtCost} higher={false} />],
    ["p50", Icon.evals.latency, <Then before={m.before?.latencyP50Ms ?? null} after={m.after?.latencyP50Ms ?? null} fmt={fmtLatency} higher={false} />],
  ];
}

function ModelName({ m }: { m: ModelDelta }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ModelLabel provider={m.provider} model={m.model} />
      {!m.before && <Pill tone="info">new</Pill>}
      {!m.after && <Pill>not in this eval</Pill>}
    </span>
  );
}

/**
 * The models as cards, for a panel too narrow for six columns.
 *
 * THE TABLE WAS CLIPPED THERE, with nothing to say so: "Per run" cut in half and p50 off the edge,
 * reachable only by a sideways scroll macOS does not draw a bar for. The comparison table above it
 * already stacks below the same width.
 */
export function CompareCards({ models }: { models: ModelDelta[] }) {
  return (
    <div className="space-y-2">
      {models.map((m) => (
        <div key={`${m.provider} ${m.model}`} className="rounded-control border border-hair bg-elevated px-2.5 py-2">
          <div className="pb-1.5 text-caption text-ink"><ModelName m={m} /></div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-tiny">
            {figures(m).map(([label, Mark, value]) => (
              <div key={label} className="contents">
                <span className="inline-flex items-center gap-1.5 text-faint"><Mark size={ICON.xs} />{label}</span>
                <span className="text-right">{value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Narrower than this, the six columns are clipped; the models become cards — as in EvalDashboard. */
const STACK_BELOW_PX = 640;

export function EvalCompare({
  before,
  after,
  against = before,
  onClose,
  onPickCase,
}: {
  before: EvalResults;
  after: EvalResults;
  /**
   * The eval picked to compare with — what the header names. NOT ALWAYS `before`: the pair is laid
   * out older first whichever was picked, and a later eval picked from an earlier one's Results was
   * announced as the eval already on screen.
   */
  against?: EvalResults;
  onClose: () => void;
  /**
   * Open a changed case's answer in the cases below. "case 3" WAS A LABEL: the regression it named
   * was a scroll and a search away, in a list that did not say which of its cases had moved.
   */
  onPickCase?: (exampleId: string, model: string) => void;
}) {
  const diff = useMemo(() => compareEvals(before, after), [before, after]);
  const [box, narrow] = useNarrowerThan<HTMLElement>(STACK_BELOW_PX);
  const better = diff.changes.filter((c) => c.better === true).length;
  const worse = diff.changes.filter((c) => c.better === false).length;
  return (
    <section ref={box} className="mb-4 rounded-card border border-hair bg-panel" aria-label="Compared with an earlier eval">
      <div className="flex min-h-10 items-center gap-2 border-b border-hair px-3 py-1.5">
        <Icon.evals.compare size={ICON.sm} className="shrink-0 text-faint" />
        <span className={`shrink-0 ${TYPE.sectionLabel}`}>Compared with</span>
        {/* WHICH EVAL, not only when: two from the same afternoon both read "4d ago". */}
        <span className="min-w-0 truncate text-tiny text-muted" title={`The eval ${relTime(against.startedAt)} on ${against.datasetName ?? "a deleted dataset"}`}>
          <Pill icon={Icon.evals.when} tone={FACT_TONE.when} className="mr-1.5 align-middle">{relTime(against.startedAt)}</Pill>
          <span className="text-faint">on </span>
          {against.datasetName ?? "a deleted dataset"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {better > 0 && <Pill icon={Icon.evals.rose} tone="ok" title={`${better} case${better === 1 ? "" : "s"} did better`}>{better}</Pill>}
          {worse > 0 && <Pill icon={Icon.evals.fell} tone="err" title={`${worse} case${worse === 1 ? "" : "s"} did worse`}>{worse}</Pill>}
          <IconButton icon={Icon.evals.clearComparison} label="Stop comparing" size={ICON.xs} onClick={onClose} />
        </span>
      </div>
      <div className="space-y-3 px-3 py-2.5">
        {/* A CAVEAT IS A CAUTION, said in the info blue — amber is spent only on what is running. */}
        {diff.caveats.length > 0 && (
          <div className="space-y-1">
            {diff.caveats.map((c) => (
              <div key={c} className="flex items-start gap-1.5 text-tiny text-warn">
                <Icon.evals.caveat size={ICON.xs} className="mt-px shrink-0" />
                <span>{c}</span>
              </div>
            ))}
          </div>
        )}
        {narrow ? <CompareCards models={diff.models} /> : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-caption">
            <thead>
              <tr className={TYPE.sectionLabel}>
                <th className="pb-1.5 pr-3 text-left font-normal">
                  <span className="inline-flex items-center gap-1"><Icon.evals.models size={ICON.badge} />Model</span>
                </th>
                {figures(diff.models[0] ?? { provider: "", model: "", before: null, after: null } as ModelDelta).map(([label, Mark], i, all) => (
                  <th key={label} className={`${i === all.length - 1 ? "pl-2" : "px-2"} pb-1.5 text-right font-normal`}>
                    <span className="inline-flex items-center justify-end gap-1"><Mark size={ICON.badge} />{label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {diff.models.map((m, r) => (
                <tr key={`${m.provider} ${m.model}`}>
                  <td className={`py-1.5 pr-3 whitespace-nowrap text-ink ${r ? "border-t border-hair" : ""}`}><ModelName m={m} /></td>
                  {figures(m).map(([label, , value], i, all) => (
                    <td key={label} className={`${i === all.length - 1 ? "pl-2" : "px-2"} py-1.5 text-right ${r ? "border-t border-hair" : ""}`}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        <div>
          <div className={`flex items-center gap-1.5 pb-1 ${TYPE.sectionLabel}`}>
            <Icon.evals.facetChanged size={ICON.xs} className="text-faint" />
            What changed
            <span className="text-tiny tabular-nums normal-case tracking-normal text-faint">{diff.changes.length}</span>
          </div>
          {diff.changes.length === 0 ? (
            <div className="text-tiny text-faint">No case changed its outcome.</div>
          ) : (
            <ul className="space-y-0.5 text-tiny">
              {diff.changes.map((c) => {
                // UP, DOWN OR ACROSS, in the colour of whether that is better: the list is read by its marks.
                const Mark = c.better === null ? Icon.evals.moved : c.better ? Icon.evals.rose : Icon.evals.fell;
                return (
                  <li key={`${c.exampleId}-${c.model}`}>
                    <button
                      type="button"
                      onClick={() => onPickCase?.(c.exampleId, c.model)}
                      disabled={!onPickCase}
                      title={onPickCase ? "Open this case's answer in the cases below" : undefined}
                      className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-control px-1 py-1 text-left transition-colors hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className={`shrink-0 ${c.better === null ? "text-muted" : c.better ? "text-ok" : "text-err"}`}><Mark size={ICON.xs} /></span>
                      <span className="w-12 shrink-0 tabular-nums text-faint">case {c.index}</span>
                      <ModelLabel provider={diff.models.find((m) => m.model === c.model)?.provider ?? ""} model={c.model} className="shrink-0 text-muted" />
                      <span className={`shrink-0 ${c.better === null ? "text-muted" : c.better ? "text-ok" : "text-err"}`}>{c.what}</span>
                      <span className="min-w-0 truncate text-faint" title={c.input}>{c.input.split("\n")[0]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
