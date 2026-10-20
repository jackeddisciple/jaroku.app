// Exporting eval results (doc §6.4: "export results (CSV/JSON)").
//
// The one rule that matters here: AN EXPORT MUST NOT LAUNDER AN UNCERTAIN NUMBER INTO A
// CLEAN ONE. Everything the dashboard qualifies on screen — cost unknown, cost incomplete,
// unscored — has to survive the trip into a spreadsheet, because that is exactly where the
// caveat gets lost and a "0" starts being quoted as fact.
//
// So: unknown cost is an empty cell WITH a `cost_known` column beside it, never a 0. An
// unscored run is an empty score WITH the judge's reason. Both are machine-readable and
// neither can be mistaken for a measurement.

import type { EvalResults, UsageSnapshot } from "../types.ts";

/** RFC-4180 field: quote when the value contains a delimiter, quote, or newline. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rows(rows: unknown[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/** What an export is about that the results alone name only by id. */
export interface ExportContext {
  /** The agent's display name. The results carry only its slug. */
  agentName?: string;
}

/** A job that never ran — waiting, or stopped by a ceiling or a Cancel before it started. */
const DID_NOT_RUN = new Set(["queued", "running", "cancelled"]);

/**
 * Per-cell CSV: one row per (example × provider). The analyzable shape — a provider
 * summary is a pivot away, but the reverse isn't recoverable.
 *
 * READABLE ON ITS OWN. It carried ids and no answer: what each model said, which agent, which
 * dataset were all somewhere else. And a job that never ran exported as `attempt 1`, `cost_complete
 * yes`, `not scored` — three claims about a run that did not happen.
 */
export function resultsToCsv(results: EvalResults, context: ExportContext = {}): string {
  const header = [
    "example", "input", "expected", "output",
    "provider", "model", "status", "attempt",
    "score", "score_known", "score_note",
    "cost_usd", "cost_known", "cost_complete",
    "latency_ms", "run_id", "error",
    "agent", "dataset", "eval_id",
  ];

  const body: unknown[][] = [];
  results.rows.forEach((row, i) => {
    for (const c of row.cells) {
      const ran = !DID_NOT_RUN.has(c.status);
      const scoreKnown = c.score !== null;
      const costKnown = c.costUsd !== null;
      body.push([
        i + 1,
        row.input,
        row.expected ?? "",
        // What the agent answered. Empty when nothing was kept — the run_id beside it has all of it.
        c.output ?? "",
        c.provider,
        c.model,
        c.status,
        ran ? c.attempt + 1 : "",
        // Empty, not 0 — and the flag beside it says which.
        scoreKnown ? c.score : "",
        scoreKnown ? "yes" : "no",
        scoreKnown ? "" : ran ? (c.scoreError ?? "not scored") : `did not run${c.error ? ` — ${c.error}` : ""}`,
        costKnown ? c.costUsd : "",
        costKnown ? "yes" : "no",
        // A THIRD state, and it is not a refinement of the other two. `cost_known: no` means we
        // could not price this cell at all; `cost_complete: no` means we priced SOME of it and
        // the number beside it is a floor. Without this column that second case exported as a
        // clean measurement — the exact laundering this file exists to prevent, and it was
        // happening on the per-cell export for as long as the per-leg rollup has flagged it.
        ran ? (c.costComplete ? "yes" : "no") : "",
        c.latencyMs ?? "",
        c.runId ?? "",
        c.error ?? "",
        context.agentName ?? results.agentId,
        results.datasetName ?? results.datasetId,
        results.evalId,
      ]);
    }
  });

  return rows([header, ...body]);
}

/** Provider-summary CSV: the comparison table as it appears on screen, caveats intact. */
export function summaryToCsv(results: EvalResults, context: ExportContext = {}): string {
  const header = [
    "provider", "model",
    "quality_mean", "scored", "unscored",
    "comparison_cost_usd", "cost_per_run_usd", "cost_known", "cost_complete",
    "spent_usd", "tokens",
    "latency_p50_ms", "latency_p95_ms",
    // `success_rate` is of the jobs that RAN; `cancelled` ones never did, and are counted apart.
    "succeeded", "failed", "total", "success_rate", "cancelled",
  ];
  const body = results.providers.map((p) => [
    p.provider, p.model,
    p.qualityScore ?? "", p.scored, p.unscored,
    p.costUnknown ? "" : (p.comparisonCostUsd ?? ""),
    p.costUnknown ? "" : (p.costPerRunUsd ?? ""),
    p.costUnknown ? "no" : "yes",
    // A floor is not a total; the flag is the only thing carrying that once the ≥ is gone.
    p.costIncomplete ? "no" : "yes",
    p.spentUsd, p.tokens,
    p.latencyP50Ms ?? "", p.latencyP95Ms ?? "",
    p.succeeded, p.failed, p.total, p.successRate.toFixed(4), p.cancelled ?? "",
  ]);

  // Totals as a trailing block: true spend and judge cost are properties of the eval, not
  // of any provider, and folding them into a provider row would misattribute them.
  // And what the eval was: whose, on what, how it ended, and the rubric its quality was scored on —
  // so a file read a month later says what it is about without the app open beside it.
  const totals: unknown[][] = [
    [],
    ["eval_id", results.evalId],
    ["agent", context.agentName ?? results.agentId],
    ["agent_version", results.agentVersion ?? ""],
    ["dataset", results.datasetName ?? results.datasetId],
    ["status", results.status],
    ["stop_reason", results.stopReason ?? ""],
    ["started_at", results.startedAt],
    ["agent_spend_usd", results.totals.agentSpendUsd],
    ["judge_cost_usd", results.totals.judgeCostUsd],
    ["true_spend_usd", results.totals.trueSpendUsd],
    ["budget_usd", results.totals.budgetUsd ?? ""],
  ];
  const rubric: unknown[][] = results.rubric?.length
    ? [[], ["criterion", "label", "weight", "description"], ...results.rubric.map((c) => [c.id, c.label, c.weight, c.description])]
    : [];

  return rows([header, ...body, ...totals, ...rubric]);
}

/**
 * The usage dashboard, as a spreadsheet, with every caveat intact.
 *
 * Same rule as the eval exports and the same reason it needs restating: a spend figure lands in
 * a spreadsheet and is quoted as fact, and the qualification that made it honest on screen is
 * the first thing to fall off. So `cost_known` rides beside every total here too, at every level
 * — the period, each agent, each run, each kind — and an unpriced row is an EMPTY cell rather
 * than a zero.
 *
 * Sections rather than one wide table. An agent, a run and a kind are different units and a
 * single flat sheet would need a `type` column and a lot of empty ones; a spreadsheet reader
 * splits on the blank line, and a human reads it top to bottom.
 */
export function usageToCsv(usage: UsageSnapshot): string {
  const out: unknown[][] = [
    ["period_start", usage.periodStart],
    ["period_end", usage.periodEnd],
    ["plan", usage.plan.id],
    // Empty, not zero, when nothing could be priced at all. `cost_known` beside it is what
    // distinguishes "we spent nothing" from "we cannot tell you what we spent".
    ["spent_usd", usage.spentUsd],
    ["cost_known", usage.costKnown ? "yes" : "no"],
    ["ceiling_usd", usage.ceilingUsd ?? ""],
    ["headroom_usd", usage.headroomUsd ?? ""],
    ["over_ceiling", usage.overCeiling ? "yes" : "no"],
    ["platform_spent_usd", usage.platformSpentUsd],
    ["platform_ceiling_usd", usage.platformCeilingUsd ?? ""],
    ["credit_available_usd", usage.availableUsd],
    ["credit_reserved_usd", usage.reservedUsd],
    [],
    ["agent", "runs", "tokens", "cost_usd", "cost_known"],
    ...usage.byAgent.map((a) => [
      a.label, a.runs, a.tokens, a.costKnown ? a.usd : "", a.costKnown ? "yes" : "no",
    ]),
    [],
    ["run_id", "agent", "tokens", "cost_usd", "cost_known"],
    ...usage.byRun.map((r) => [
      r.runId, r.label ?? "", r.tokens, r.costKnown ? r.usd : "", r.costKnown ? "yes" : "no",
    ]),
    [],
    ["kind", "payer", "tokens", "cost_usd", "cost_known"],
    ...usage.byKind.map((k) => [
      k.kind, k.payer, k.tokens, k.costKnown ? k.usd : "", k.costKnown ? "yes" : "no",
    ]),
  ];
  return rows(out);
}

/** Short, sortable filename stem for a usage export. */
export function usageStem(usage: UsageSnapshot): string {
  return `jaroku-usage-${usage.periodStart.slice(0, 10)}`;
}

/** Everything, unmodified — the lossless form — with the agent's name when it is known. */
export function resultsToJson(results: EvalResults, context: ExportContext = {}): string {
  return JSON.stringify(context.agentName ? { ...results, agentName: context.agentName } : results, null, 2);
}

/** Trigger a client-side download. No server round trip; the data is already here. */
export function download(filename: string, contents: string | Blob, mime: string): void {
  // A Blob is binary already (an image) and carries its own type; text is labelled as UTF-8.
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Not at once: the desktop webview reads the blob after the click returns, from its download
  // delegate, and a URL already revoked is a download that fails.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Short, sortable filename stem for an eval's exports — in LOCAL time.
 *
 * It was the UTC timestamp's digits, so an eval started at 15:57 downloaded as `…10-27-11`, which
 * matched nothing on the person's clock.
 */
export function exportStem(results: EvalResults): string {
  const t = new Date(results.startedAt ?? "");
  if (Number.isNaN(t.getTime())) return `jaroku-eval-${results.evalId.slice(0, 8)}`;
  const two = (n: number): string => String(n).padStart(2, "0");
  const when = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}-${two(t.getHours())}-${two(t.getMinutes())}-${two(t.getSeconds())}`;
  return `jaroku-eval-${when}`;
}
