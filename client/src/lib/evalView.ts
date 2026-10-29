// What the Results half of the Evals tab says about an eval, worked out once and tested here.
//
// THE PANEL HAD THE FIGURES AND NOT THE ANSWER. Every number a comparison needs was on screen, and
// "which model won, and at what price" was left to whoever was reading — so the sentence the whole
// tab exists to produce was produced in somebody's head, differently each time. These are the pure
// halves of the views that say it: the verdict over the table, the facets that narrow the cases,
// and the per-criterion breakdown the judge's scores always had and nothing ever drew.
//
// NOTHING HERE MAY LAUNDER AN UNCERTAIN NUMBER, for the dashboard's own reason (EvalDashboard.tsx):
// an unpriced model is never "cheaper", a floor is never a total, and an unscored answer is never a
// zero. A claim that cannot be made honestly is left out of the sentence rather than softened.
//
//   npm run test:eval-view

import type { EvalResults, ExampleCell, ExampleRow, ProviderMetrics } from "../types.ts";
import { SCORE_STEP } from "./evalCompare.ts";
import { fmtDuration } from "./format.ts";

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

/** A ratio as the verdict says it: "2.3×", "12×". */
function times(ratio: number): string {
  return ratio < 10 ? `${ratio.toFixed(1).replace(/\.0$/, "")}×` : `${Math.round(ratio)}×`;
}

/** Below this, two figures are the same figure for the purposes of a sentence. */
const SAME_WITHIN = 1.1;

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const pct = (p: ProviderMetrics): number => Math.round((p.qualityScore ?? 0) * 100);

/**
 * One sentence saying who leads, on what, by how much — or null when there is no comparison.
 *
 * "Sonnet 5 leads quality (74 vs 69); Haiku 4.5 is 2.3× cheaper per run and fastest."
 *
 * EACH CLAIM ONLY WHERE IT CAN BE MADE. Quality needs two scored models; a tie is said as a tie,
 * because "leads 70 to 70" is a lead over nobody. Cost needs every model that produced an answer to
 * be fully priced — an unpriced or floor-priced leg could be the cheap one, and the sentence would be
 * the confident wrong answer the dashboard's cost rules exist to prevent. Speed needs two latencies,
 * and is only claimed when the gap is worth a word.
 */
export function verdict(providers: ProviderMetrics[], name: (model: string) => string = (m) => m): string | null {
  const said = new Map<string, string[]>();
  const say = (model: string, predicate: string): void => {
    said.set(model, [...(said.get(model) ?? []), predicate]);
  };
  const clauses: string[] = [];

  const scored = providers.filter((p) => p.qualityScore !== null).sort((a, b) => pct(b) - pct(a));
  const [top, next] = scored;
  if (top && next) {
    const tied = scored.filter((p) => pct(p) === pct(top));
    if (tied.length > 1) clauses.push(`${listOf(tied.map((p) => name(p.model)))} tie on quality at ${pct(top)}`);
    else say(top.model, scored.length === 2 ? `leads quality (${pct(top)} vs ${pct(next)})` : `leads quality (${pct(top)} vs ${name(next.model)} at ${pct(next)})`);
  }

  const answered = providers.filter((p) => p.succeeded > 0);
  const priced = answered.every((p) => !p.costUnknown && !p.costIncomplete && p.costPerRunUsd !== null);
  if (priced && answered.length > 1) {
    const [low, then] = [...answered].sort((a, b) => (a.costPerRunUsd ?? 0) - (b.costPerRunUsd ?? 0));
    const lowCost = low?.costPerRunUsd ?? 0;
    const thenCost = then?.costPerRunUsd ?? 0;
    if (low && then && thenCost > 0) {
      if (lowCost === 0) say(low.model, "is free per run");
      else if (thenCost / lowCost >= SAME_WITHIN) say(low.model, `is ${times(thenCost / lowCost)} cheaper per run`);
    }
  }

  const timed = providers.filter((p) => p.latencyP50Ms !== null).sort((a, b) => (a.latencyP50Ms ?? 0) - (b.latencyP50Ms ?? 0));
  const [fast, slower] = timed;
  if (fast && slower && (fast.latencyP50Ms ?? 0) > 0 && (slower.latencyP50Ms ?? 0) / (fast.latencyP50Ms ?? 1) >= SAME_WITHIN) {
    say(fast.model, "is fastest");
  }

  for (const [model, predicates] of said) {
    // "is 2.3× cheaper per run and fastest", not "is … and is fastest".
    const is = predicates.filter((p) => p.startsWith("is ")).map((p) => p.slice(3));
    const rest = predicates.filter((p) => !p.startsWith("is "));
    const parts = [...rest, ...(is.length ? [`is ${listOf(is)}`] : [])];
    clauses.push(`${name(model)} ${parts.length === 2 ? `${parts[0]}, and ${parts[1]}` : parts.join(" and ")}`);
  }
  return clauses.length ? `${clauses.join("; ")}.` : null;
}

// ── The cases, narrowed ────────────────────────────────────────────────────────────────────────

/** The ways the case list can be narrowed — the questions somebody opens an eval's cases to ask. */
export type CaseFacet = "all" | "failed" | "disagree" | "unscored" | "changed";
export const CASE_FACETS: readonly CaseFacet[] = ["all", "failed", "disagree", "unscored", "changed"];

/** Not run yet, or never going to — none of these is a result. */
const NOT_A_RESULT = new Set(["queued", "running", "cancelled"]);

/** A cell that ran and did not succeed: `failed`, `timed_out`, or any status the server adds later. */
export function cellFailed(c: Pick<ExampleCell, "status">): boolean {
  return c.status !== "succeeded" && !NOT_A_RESULT.has(c.status);
}

/**
 * Whether the models answered one case differently enough to be worth reading side by side.
 *
 * THREE WAYS, IN ORDER OF HOW PLAIN THEY ARE: one ran and another failed; one met the case's expected
 * output and another did not; or the judge's scores are further apart than its own noise
 * (`SCORE_STEP`, the step `evalCompare` uses for "a score moved"). A case only one model has run is
 * not a disagreement — there is nobody to disagree with.
 */
export function rowDisagrees(row: Pick<ExampleRow, "cells">): boolean {
  const ran = row.cells.filter((c) => c.status === "succeeded" || cellFailed(c));
  if (ran.length < 2) return false;
  const ok = ran.filter((c) => c.status === "succeeded");
  if (ok.length > 0 && ok.length < ran.length) return true;
  const verdicts = ok.map((c) => c.matches).filter((m): m is boolean => m != null);
  if (new Set(verdicts).size > 1) return true;
  const scores = ok.map((c) => c.score).filter((s): s is number => s != null);
  return scores.length > 1 && Math.max(...scores) - Math.min(...scores) >= SCORE_STEP;
}

/** Whether a case belongs under a facet. `changed` is the comparison's own list of moved cases. */
export function rowIs(row: ExampleRow, facet: CaseFacet, changed?: ReadonlySet<string>): boolean {
  switch (facet) {
    case "all": return true;
    case "failed": return row.cells.some(cellFailed);
    case "disagree": return rowDisagrees(row);
    case "unscored": return row.cells.some((c) => c.status === "succeeded" && c.score === null);
    case "changed": return changed?.has(row.exampleId) ?? false;
  }
}

/** How many cases each facet holds. The counts are totals: an eval's rows arrive whole. */
export function facetCounts(rows: readonly ExampleRow[], changed?: ReadonlySet<string>): Record<CaseFacet, number> {
  const counts = { all: 0, failed: 0, disagree: 0, unscored: 0, changed: 0 } as Record<CaseFacet, number>;
  for (const row of rows) for (const f of CASE_FACETS) if (rowIs(row, f, changed)) counts[f]++;
  return counts;
}

// ── The judge's criteria ───────────────────────────────────────────────────────────────────────

/** A criterion's display name: the rubric's label, or its id when the eval kept no rubric. */
export function criterionLabel(results: Pick<EvalResults, "rubric">, id: string): string {
  return results.rubric?.find((c) => c.id === id)?.label?.trim() || id;
}

export interface CriterionScore {
  provider: string;
  model: string;
  /** Mean of the 0–4 scores this model's answers got on the criterion, or null with none. */
  avg: number | null;
  n: number;
}

export interface CriterionRow {
  id: string;
  label: string;
  description: string | null;
  weight: number | null;
  scores: CriterionScore[];
}

/**
 * Each criterion, each model's average on it — where two models' overall scores come apart.
 *
 * THE BREAKDOWN EVERY VERDICT CARRIED AND NOTHING SUMMED. A 74 against a 69 says one model is better;
 * it does not say whether that is correctness or tone, which is the thing somebody choosing between
 * them needs. Criteria come in the rubric's order with its labels (the eval keeps the rubric it was
 * scored on); an id a verdict carries that the rubric does not name is kept, under its id, rather
 * than dropped. Empty when nothing was scored.
 */
export function criterionTable(results: Pick<EvalResults, "rubric" | "providers" | "rows">): CriterionRow[] {
  const cells = results.rows.flatMap((r) => r.cells);
  if (!cells.some((c) => c.perCriterion)) return [];
  const named = (results.rubric ?? []).map((c) => c.id);
  const ids = [...new Set([...named, ...cells.flatMap((c) => Object.keys(c.perCriterion ?? {}))])];
  return ids.map((id) => {
    const criterion = results.rubric?.find((c) => c.id === id);
    return {
      id,
      label: criterionLabel(results, id),
      description: criterion?.description ?? null,
      weight: criterion?.weight ?? null,
      scores: results.providers.map((p) => {
        const values = cells
          .filter((c) => c.provider === p.provider && c.model === p.model)
          .map((c) => c.perCriterion?.[id])
          .filter((v): v is number => typeof v === "number");
        return {
          provider: p.provider,
          model: p.model,
          avg: values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null,
          n: values.length,
        };
      }),
    };
  });
}

/** How long an eval took, start to finish — or null while it runs, or when the clock is unreadable. */
export function evalDuration(results: Pick<EvalResults, "startedAt" | "endedAt">): string | null {
  if (!results.endedAt) return null;
  const ms = Date.parse(results.endedAt) - Date.parse(results.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? fmtDuration(ms) : null;
}
