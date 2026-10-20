// What changed between two evals — the question a regression test exists to answer.
//
// HISTORY WAS A STRIP OF TIMESTAMPS. Each eval could be opened on its own, and "is the agent better
// or worse than before the edit" meant reading two tables one after the other and diffing them in
// one's head. This lines two evals up: each model's figures then and now, and each case whose
// outcome moved — failed that ran, matched that did not, a score that moved by a quarter or more.
//
// Cases are matched by the case they ran (its id) and the model; a case only one eval ran, or a
// model only one compared, is said to be new or gone rather than diffed against nothing.

import type { EvalResults, ExampleCell, ProviderMetrics } from "../types.ts";

export interface ModelDelta {
  provider: string;
  model: string;
  before: ProviderMetrics | null;
  after: ProviderMetrics | null;
}

export interface CaseChange {
  exampleId: string;
  /** 1-based position in the newer eval, for "case 3". */
  index: number;
  input: string;
  model: string;
  /** One sentence: "failed → succeeded", "matched → did not match", "score 80 → 40". */
  what: string;
  /** Whether it got better or worse — a change that is neither (new, gone) is null. */
  better: boolean | null;
}

export interface EvalComparison {
  models: ModelDelta[];
  changes: CaseChange[];
  /** Ways the two evals are not like for like, said before any number is read. */
  caveats: string[];
}

/** A score moving by less than this is the judge's own noise, not a change. */
export const SCORE_STEP = 0.25;

const ranOk = (c: ExampleCell): boolean => c.status === "succeeded";
const word = (c: ExampleCell): string => (c.status === "timed_out" ? "timed out" : c.status);

/** `before` is the older eval, `after` the newer. */
export function compareEvals(before: EvalResults, after: EvalResults): EvalComparison {
  const caveats: string[] = [];
  if (before.agentVersion != null && after.agentVersion != null && before.agentVersion !== after.agentVersion) {
    caveats.push(`the agent changed between them — v${before.agentVersion} → v${after.agentVersion}`);
  }
  if (before.datasetId !== after.datasetId) {
    caveats.push(`they ran on different datasets — ${before.datasetName ?? "one"} and ${after.datasetName ?? "another"} — so only the cases both had are compared`);
  }
  if ((before.checkMode ?? null) !== (after.checkMode ?? null)) caveats.push("their answers were checked against expected in different ways");

  const keyOf = (p: { provider: string; model: string }) => `${p.provider} ${p.model}`;
  const legs = new Map<string, ModelDelta>();
  for (const p of after.providers) legs.set(keyOf(p), { provider: p.provider, model: p.model, before: null, after: p });
  for (const p of before.providers) {
    const known = legs.get(keyOf(p));
    if (known) known.before = p;
    else legs.set(keyOf(p), { provider: p.provider, model: p.model, before: p, after: null });
  }

  const beforeCells = new Map<string, ExampleCell>();
  for (const row of before.rows) for (const c of row.cells) beforeCells.set(`${row.exampleId} ${keyOf(c)}`, c);
  const changes: CaseChange[] = [];
  after.rows.forEach((row, i) => {
    for (const c of row.cells) {
      const was = beforeCells.get(`${row.exampleId} ${keyOf(c)}`);
      if (!was) continue;
      const at = { exampleId: row.exampleId, index: i + 1, input: row.input, model: c.model };
      if (ranOk(was) !== ranOk(c) && c.status !== "cancelled" && was.status !== "cancelled") {
        changes.push({ ...at, what: `${word(was)} → ${word(c)}`, better: ranOk(c) });
      } else if (was.matches != null && c.matches != null && was.matches !== c.matches) {
        changes.push({ ...at, what: c.matches ? "did not match → matched" : "matched → did not match", better: c.matches });
      } else if (was.score !== null && c.score !== null && Math.abs(c.score - was.score) >= SCORE_STEP) {
        changes.push({ ...at, what: `score ${Math.round(was.score * 100)} → ${Math.round(c.score * 100)}`, better: c.score > was.score });
      }
    }
  });
  // Worse first: a regression is what somebody opened this to find.
  changes.sort((a, b) => Number(a.better) - Number(b.better) || a.index - b.index);
  return { models: [...legs.values()], changes, caveats };
}
