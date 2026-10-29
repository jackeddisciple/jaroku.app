// Two evals side by side: each model's figures then and now, and each case whose outcome moved.
// See lib/evalCompare.ts for what counts as a change.

import { useMemo, type ReactNode } from "react";
import { compareEvals, type ModelDelta } from "../lib/evalCompare.ts";
import { fmtCost, fmtLatency, fmtPercent, relTime } from "../lib/format.ts";
import { TYPE } from "../lib/tokens.ts";
import { useNarrowerThan } from "../lib/useNarrower.ts";
import type { EvalResults, ProviderMetrics } from "../types.ts";

/** One figure, then and now. */
function Then({ before, after, fmt }: { before: number | null; after: number | null; fmt: (n: number) => string }) {
  if (before === null && after === null) return <span className="text-faint">—</span>;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-faint">{before === null ? "—" : fmt(before)}</span>
      <span className="text-faint"> → </span>
      <span className="text-ink">{after === null ? "—" : fmt(after)}</span>
    </span>
  );
}

const ranRate = (p: ProviderMetrics | null): number | null => (p && p.succeeded + p.failed > 0 ? p.successRate : null);
const matchRate = (p: ProviderMetrics | null): number | null => (p && (p.checked ?? 0) > 0 ? (p.matched ?? 0) / (p.checked ?? 1) : null);
const share = (n: number) => fmtPercent(n, "share");

/** Each model's figures, then and now, in the order both layouts show them. */
function figures(m: ModelDelta): [string, ReactNode][] {
  return [
    ["Quality", <Then before={m.before?.qualityScore ?? null} after={m.after?.qualityScore ?? null} fmt={(n) => String(Math.round(n * 100))} />],
    ["Ran OK", <Then before={ranRate(m.before)} after={ranRate(m.after)} fmt={share} />],
    ["Matches", <Then before={matchRate(m.before)} after={matchRate(m.after)} fmt={share} />],
    ["Per run", <Then before={m.before?.costPerRunUsd ?? null} after={m.after?.costPerRunUsd ?? null} fmt={fmtCost} />],
    ["p50", <Then before={m.before?.latencyP50Ms ?? null} after={m.after?.latencyP50Ms ?? null} fmt={fmtLatency} />],
  ];
}

function ModelName({ m }: { m: ModelDelta }) {
  return (
    <>
      {m.model}
      {!m.before && <span className="ml-1 text-tiny text-faint">new</span>}
      {!m.after && <span className="ml-1 text-tiny text-faint">not in this eval</span>}
    </>
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
        <div key={`${m.provider} ${m.model}`} className="rounded-control border border-hair px-2.5 py-1.5">
          <div className="pb-1 text-caption text-ink"><ModelName m={m} /></div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-tiny">
            {figures(m).map(([label, value]) => (
              <div key={label} className="contents">
                <span className="text-faint">{label}</span>
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
const STACK_BELOW_PX = 560;

export function EvalCompare({
  before,
  after,
  against = before,
  onClose,
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
}) {
  const diff = useMemo(() => compareEvals(before, after), [before, after]);
  const [box, narrow] = useNarrowerThan<HTMLElement>(STACK_BELOW_PX);
  return (
    <section ref={box} className="mb-4 rounded-card border border-hair bg-panel px-3 py-2.5" aria-label="Compared with an earlier eval">
      <div className="flex items-baseline gap-2 pb-2">
        <span className={TYPE.sectionLabel}>Compared with</span>
        {/* WHICH EVAL, not only when: two from the same afternoon both read "4d ago". */}
        <span className="text-tiny text-muted">
          the eval {relTime(against.startedAt)} on {against.datasetName ?? "a deleted dataset"}
        </span>
        <button onClick={onClose} className="ml-auto text-tiny text-faint transition-colors hover:text-ink">Stop comparing</button>
      </div>
      {/* A CAVEAT IS A CAUTION, said in the info blue — amber is spent only on what is running. */}
      {diff.caveats.map((c) => (
        <div key={c} className="pb-1 text-tiny text-warn">· {c}</div>
      ))}
      {narrow ? <CompareCards models={diff.models} /> : (
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-caption">
          <thead>
            <tr className={TYPE.sectionLabel}>
              <th className="pb-1 pr-3 text-left font-normal">Model</th>
              <th className="px-2 pb-1 text-right font-normal">Quality</th>
              <th className="px-2 pb-1 text-right font-normal">Ran OK</th>
              <th className="px-2 pb-1 text-right font-normal">Matches</th>
              <th className="px-2 pb-1 text-right font-normal">Per run</th>
              <th className="pl-2 pb-1 text-right font-normal">p50</th>
            </tr>
          </thead>
          <tbody>
            {diff.models.map((m) => (
              <tr key={`${m.provider} ${m.model}`}>
                <td className="py-1 pr-3 whitespace-nowrap text-ink"><ModelName m={m} /></td>
                {figures(m).map(([label, value], i, all) => (
                  <td key={label} className={`${i === all.length - 1 ? "pl-2" : "px-2"} py-1 text-right`}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <div className="pt-2">
        <div className={`pb-1 ${TYPE.sectionLabel}`}>What changed</div>
        {diff.changes.length === 0 ? (
          <div className="text-tiny text-faint">No case changed its outcome.</div>
        ) : (
          <ul className="space-y-0.5 text-tiny">
            {diff.changes.map((c) => (
              <li key={`${c.exampleId}-${c.model}`} className="flex min-w-0 gap-2">
                <span className="shrink-0 tabular-nums text-faint">case {c.index}</span>
                <span className="shrink-0 text-muted">{c.model}</span>
                <span className={c.better === null ? "text-muted" : c.better ? "text-ok" : "text-err"}>{c.what}</span>
                <span className="min-w-0 truncate text-faint" title={c.input}>{c.input.split("\n")[0]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
