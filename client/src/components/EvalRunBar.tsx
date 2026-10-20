// Provider picker, pre-run cost estimate, and the run control.
//
// An eval multiplies cost by examples × providers, and the judge adds one more paid call
// per cell. Three examples on two providers is eight calls; fifty on three is three
// hundred. So an eval cannot be started from a single click:
//
//   pick models → see an estimate → set a ceiling → confirm
//
// EVERY EVAL GOES THIS WAY. There used to be a free dry-run leg that skipped all of it; there is no
// such model any more, so every run of this bar spends money, and every one asks first.
//
// The estimate informs; the CEILING enforces. An estimate that reads low must never be the
// only thing between a user and a large bill, so the confirm step requires a ceiling and
// the server aborts on true spend regardless of what was predicted.

import { useEffect, useMemo, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { examplesOf, liveEvalOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { isRunnable, modelName, runProviders, useProviderStore } from "../store/providerStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendCancelEval, sendEstimateEval, sendStartEval } from "../lib/socket.ts";
import { fmtCost } from "../lib/format.ts";
import { Chip } from "./Chip.tsx";
import { primaryBtn } from "./buttons.ts";
import type { EvalEstimate, EvalTarget } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";

const key = (t: EvalTarget) => `${t.provider}/${t.model}`;

/**
 * Default ceiling offered alongside an estimate: comfortably above the high end, in whole cents.
 *
 * IN CENTS, AS INTEGERS. `Math.ceil(padded / magnitude) * magnitude` in dollars put float error into
 * the field as typed text — "0.30000000000000004". Rounded up to something legible, because a
 * ceiling of $0.1837 invites nobody to think about it.
 */
export function suggestedCeiling(high: number): string {
  // Trimmed before rounding up: 0.2 × 150 is 30.000000000000004, which would round up to 31¢.
  const cents = Math.max(Math.ceil(Number((high * 150).toFixed(6))), 5);
  const step = 10 ** Math.max(0, Math.floor(Math.log10(cents)));
  return (Math.ceil(cents / step) * step / 100).toFixed(2);
}

/** The smallest ceiling worth setting: below a cent, no run starts at all. */
export const MIN_CEILING_USD = 0.01;

/**
 * What was typed into Stop at, as a ceiling — or the sentence saying why it is not one.
 *
 * Invalid values used to just disable Run for real, with nothing to say why, and `1e-9` was accepted.
 */
export function parseCeiling(text: string): { usd: number } | { error: string } {
  const t = text.trim().replace(/^\$/, "");
  if (!t) return { error: "Set a ceiling to run — it is what stops the spending." };
  if (!/^\d*\.?\d+$/.test(t)) return { error: "Type the ceiling as dollars, like 0.50." };
  const usd = Number(t);
  if (usd < MIN_CEILING_USD) return { error: `The smallest ceiling is $${MIN_CEILING_USD.toFixed(2)}.` };
  return { usd };
}

/**
 * What a ceiling means against this estimate, when it means trouble.
 *
 * BELOW THE LOW END, the eval will stop part-way — and nothing said so, so "Run for real" started an
 * eval guaranteed not to finish. BELOW ONE RUN, the ceiling is checked before each dispatch, so every
 * slot a provider has starts before any cost lands: a $0.001 ceiling spent $0.0048.
 */
export function ceilingWarning(usd: number, estimate: EvalEstimate): string | null {
  const perRun = Math.max(0, ...estimate.perTarget.map((t) => (t.highUsd !== null && t.runs > 0 ? t.highUsd / t.runs : 0)));
  if (perRun > 0 && usd < perRun) {
    return "This is less than one run is likely to cost. The first runs start before any cost lands, so the eval can spend several times this before it stops.";
  }
  if (usd < estimate.totalLowUsd) {
    return "This is below even the low end of the estimate, so the eval will stop part-way and the comparison will be incomplete.";
  }
  return null;
}

export function EvalRunBar() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const selectedDatasetId = useEvalStore((s) => (activeAgentId ? (s.selectedDatasetByAgent[activeAgentId] ?? null) : null));
  const examplesByDataset = useEvalStore((s) => s.examplesByDataset);
  // THIS AGENT'S eval in flight. Cancel stops the eval shown here, never another agent's.
  const progress = useEvalStore((s) => liveEvalOf(s.progressByEval, activeAgentId));
  const estimate = useEvalStore((s) => s.estimate);
  const setEstimate = useEvalStore((s) => s.setEstimate);
  // The legs somebody can compare are every model the price sheet knows — see providerStore. It was
  // a constant in the client, four models behind, so a priced model could not be added as a leg.
  const providerModels = useProviderStore((s) => s.models);
  const catalogue = useMemo(() => runProviders(providerModels), [providerModels]);
  const providerStatuses = useProviderStore((s) => s.providers);

  // THE COMPOSER'S MODEL, when it can run: "how does this agent do on what I already run it on" is
  // the common question, so it starts as one chosen leg rather than an empty row of chips.
  const [targets, setTargets] = useState<EvalTarget[]>(() => {
    const { provider, model } = useUiStore.getState();
    const runnable = isRunnable(useProviderStore.getState().providers, provider);
    return provider && model && runnable ? [{ provider, model }] : [];
  });
  const [confirming, setConfirming] = useState(false);
  const [ceiling, setCeiling] = useState<string>("");
  /** Whether somebody typed the ceiling. Until they do, each estimate suggests its own. */
  const [ceilingTyped, setCeilingTyped] = useState(false);

  const examples = examplesOf(examplesByDataset, selectedDatasetId);
  const running = progress !== null && progress.status === undefined;

  // Changing the selection invalidates any estimate on screen — a stale number next to a
  // different set of providers is worse than none. So does a case added or removed: the box said
  // "14 examples" while Run for real started fifteen.
  useEffect(() => {
    setEstimate(null);
    setConfirming(false);
  }, [targets.map(key).join(","), selectedDatasetId, examples.length]);

  // EVERY ESTIMATE SUGGESTS ITS OWN, unless somebody typed one. It was set once and kept, so adding
  // two frontier models left a $0.30 ceiling beside a $0.71–$1.18 estimate.
  useEffect(() => {
    if (estimate && !ceilingTyped) setCeiling(suggestedCeiling(estimate.totalHighUsd));
  }, [estimate]);

  if (!selectedDatasetId) return null;

  const toggle = (t: EvalTarget) =>
    setTargets((cur) =>
      cur.some((x) => key(x) === key(t)) ? cur.filter((x) => key(x) !== key(t)) : [...cur, t],
    );

  const beginRun = () => {
    if (!activeAgentId || !examples.length || !targets.length) return;
    sendEstimateEval(selectedDatasetId, activeAgentId, targets);
    setConfirming(true);
  };

  const parsedCeiling = parseCeiling(ceiling);
  const warning = estimate && "usd" in parsedCeiling ? ceilingWarning(parsedCeiling.usd, estimate) : null;

  const confirmRun = () => {
    if (!activeAgentId || !("usd" in parsedCeiling)) return;
    sendStartEval(selectedDatasetId, activeAgentId, targets, parsedCeiling.usd);
    setConfirming(false);
    setEstimate(null);
  };

  return (
    <div className="px-4 py-3 shrink-0 space-y-2">
      {/* provider selection */}
      <div className="flex flex-wrap items-center gap-1.5 text-caption">
        {catalogue.flatMap((p) =>
          p.models.map((m) => {
            const t: EvalTarget = { provider: p.id, model: m };
            const on = targets.some((x) => key(x) === key(t));
            // DISABLED WITH A STATED REASON, the composer's rule: a model that vanishes because a
            // key is missing reads as one the product does not support. A leg already chosen stays
            // pressable, so it can always be taken back off.
            const usable = isRunnable(providerStatuses, p.id);
            return (
              <Chip
                key={key(t)}
                onClick={() => toggle(t)}
                selected={on}
                disabled={running || (!usable && !on)}
                // The model's name, in Sans: §04 lists model labels as prose, and §05 is explicit
                // that looking technical is not the test.
                title={usable ? `${p.label} · billed per token` : `No ${p.label} API key in this workspace`}
                className="whitespace-nowrap"
              >
                {modelName(providerModels, m)}
              </Chip>
            );
          }),
        )}
      </div>

      {/* the estimate — shown only when money is involved, and always as a range */}
      {confirming && (
        <div className="rounded-card border border-edge bg-panel px-3 py-2 space-y-1.5">
          {!estimate ? (
            <div className="text-tiny text-muted">estimating…</div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-tiny">
                <span className="text-ink">
                  {estimate.examples} example{estimate.examples === 1 ? "" : "s"} ×{" "}
                  {estimate.targets} provider{estimate.targets === 1 ? "" : "s"} ={" "}
                  {estimate.totalRuns} run{estimate.totalRuns === 1 ? "" : "s"}
                </span>
                {/* A RANGE, never a point value — this is a projection, not a quote. */}
                <span className="text-run">
                  roughly {fmtCost(estimate.totalLowUsd)}–{fmtCost(estimate.totalHighUsd)}
                </span>
                {estimate.judgeHighUsd > 0 && (
                  <span className="text-faint">
                    incl. {fmtCost(estimate.judgeLowUsd)}–{fmtCost(estimate.judgeHighUsd)} judge
                  </span>
                )}
              </div>

              {estimate.notes.map((n, i) => (
                <div key={i} className="text-tiny text-faint">· {n}</div>
              ))}

              {/* STOP AT, ON ONE LINE. The explanation that wrapped between the field and the buttons
                  moved under them, with whatever this ceiling means against this estimate. */}
              <div className="flex items-center gap-2 pt-1">
                <label className="whitespace-nowrap text-tiny text-muted" htmlFor="eval-ceiling">Stop at</label>
                <span className="text-muted text-tiny">$</span>
                <input
                  id="eval-ceiling"
                  value={ceiling}
                  onChange={(e) => { setCeiling(e.target.value); setCeilingTyped(true); }}
                  aria-label="Stop at, in dollars"
                  aria-invalid={"error" in parsedCeiling}
                  inputMode="decimal"
                  className={`w-20 bg-elevated text-ink rounded-input border px-2 py-1 text-tiny tabular-nums outline-none focus:shadow-focusring ${
                    "error" in parsedCeiling ? "border-err" : "border-edge"
                  }`}
                />
                <button
                  onClick={() => { setConfirming(false); setEstimate(null); }}
                  className="ml-auto text-tiny text-faint hover:text-ink transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRun}
                  disabled={"error" in parsedCeiling}
                  title={"error" in parsedCeiling ? parsedCeiling.error : undefined}
                  className={`${primaryBtn} whitespace-nowrap`}
                >
                  Run for real
                </button>
              </div>
              {"error" in parsedCeiling && <div className="text-tiny text-err" role="alert">{parsedCeiling.error}</div>}
              {warning && <div className="text-tiny text-run" role="status">{warning}</div>}
              {/* Says what the ceiling actually does. It is checked against real spend
                  before anything is DISPATCHED, so runs already in flight finish and pay
                  out — with providers running two at a time, a small eval can dispatch
                  every cell before the first cost lands and overshoot several times over.
                  "hard ceiling" alone read as a cap on the bill, which it is not. */}
              <div className="text-tiny text-faint">
                Checked against real spend before each dispatch — runs already started still finish,
                so the total can overshoot.
              </div>
            </>
          )}
        </div>
      )}

      {/* run control */}
      {!confirming && (
        <div className="flex items-center gap-2.5 text-caption">
          <span className="text-faint tabular-nums whitespace-nowrap">
            {examples.length} × {targets.length} = {examples.length * targets.length} run
            {examples.length * targets.length === 1 ? "" : "s"}
          </span>
          {targets.length > 0 && (
            <span className="text-run text-tiny whitespace-nowrap">billed per token</span>
          )}
          <span className="ml-auto" />
          {running ? (
            <IconButton
              icon={Icon.evals.cancel}
              // One eval per workspace, so this agent's running eval may be a teammate's. Say so before
              // somebody stops it.
              label={progress?.startedHere ? "Cancel this eval" : "Cancel this eval — it was started elsewhere in this workspace"}
              danger
              onClick={() => progress && sendCancelEval(progress.evalId)}
            />
          ) : (
            <IconButton
              icon={Icon.evals.run}
              // §8: A GATE'S LABEL NAMES WHAT THE PRESS DOES. Every eval sits behind a spend
              // ceiling, so this opens the estimate rather than dispatching, and "Run eval" would
              // promise money moving that the next screen has not asked about yet.
              label="Estimate the cost of this eval"
              disabledReason={
                !connected ? "Not connected"
                  : !examples.length ? "Add an example first"
                  : !targets.length ? "Choose a model to run against"
                  : null
              }
              onClick={beginRun}
            />
          )}
        </div>
      )}
    </div>
  );
}
