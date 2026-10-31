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

import { Fragment, useEffect, useMemo, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { examplesOf, liveEvalOf, useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { isRunnable, modelName, runProviders, useProviderStore, type RunProvider } from "../store/providerStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendCancelEval, sendEstimateEval, sendStartEval } from "../lib/socket.ts";
import { fmtCost } from "../lib/format.ts";
import { effortName, effortStops } from "../lib/effortLevels.ts";
import { ProviderMark } from "../lib/icons.tsx";
import type { EvalEstimate, EvalTarget, ProviderModel, ProviderStatus } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { IconButton } from "./IconButton.tsx";
import { Chosen, EVAL_SELECT, FACT_TONE, ModelLabel, Pill, SOFT_ICON_XS } from "./evalUi.tsx";
import { badgeVariants } from "./ui/badge.tsx";
import { cn } from "../lib/utils.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

const key = (t: EvalTarget) => `${t.provider}/${t.model}`;

/** What each estimate basis means, for the line that names it. */
const BASIS: Record<string, string> = {
  measured: "projected from this agent's past runs on this model",
  "other-model": "projected from this agent's runs on a different model — tokenizers differ",
  default: "no past runs to learn from — a built-in default, so the range is wide",
};

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

/** Whether pressing Run would be refused, in the refusal's own words — or null. */
export function refusalOf(estimate: EvalEstimate | null): string | null {
  // The plan first: a workspace out of eval runs is refused whatever its budget says.
  if (estimate?.planRefusal) return estimate.planRefusal;
  return estimate?.affordability?.wouldRefuse ? (estimate.affordability.refusalMessage ?? "This workspace cannot start an eval right now.") : null;
}

/**
 * The catalogue as the models menu lists it — GROUPED BY PROVIDER, and only the providers that can run
 * spelled out. Three groups of greyed models for providers with no key said nothing a single link
 * could not; a leg already chosen stays listed, so it can always be taken off. What is left out is
 * counted, for the one link to Secrets that stands in for it.
 */
export function modelGroups(
  catalogue: RunProvider[],
  statuses: ProviderStatus[],
  targets: EvalTarget[],
): { groups: (RunProvider & { usable: boolean })[]; missing: { labels: string[]; count: number; first: string | null } } {
  const groups = catalogue
    .map((p) => {
      const usable = isRunnable(statuses, p.id);
      return { ...p, usable, models: p.models.filter((m) => usable || targets.some((x) => key(x) === key({ provider: p.id, model: m }))) };
    })
    .filter((p) => p.models.length > 0);
  const missing = catalogue.filter((p) => !isRunnable(statuses, p.id));
  return {
    groups,
    missing: { labels: missing.map((p) => p.label), count: missing.reduce((n, p) => n + p.models.length, 0), first: missing[0]?.id ?? null },
  };
}

/**
 * How hard a model can be asked to think, as its effort menu offers it: the model's own default
 * first, then its levels in the runtime's order — or nothing, for a model with no reasoning control.
 */
export function effortChoices(model: ProviderModel | undefined): { value: string | null; label: string }[] {
  const stops = effortStops(model);
  if (!stops.length) return [];
  return [{ value: null, label: "Default" }, ...stops.map((level) => ({ value: level as string, label: effortName(model, level) }))];
}

/** The estimate's detail: each model's share, the server's caveats, and a refusal before it happens. */
export function EstimateDetail({ estimate }: { estimate: EvalEstimate }) {
  const refusal = refusalOf(estimate);
  return (
    <>
      {/* EACH MODEL'S SHARE, and what it was projected from. The server worked this out per model and
          the box showed only the total, so which leg made an eval expensive was a guess. */}
      {estimate.perTarget.length > 1 && (
        <div className="space-y-1 text-tiny">
          {estimate.perTarget.map((t) => (
            <div key={`${t.provider}/${t.model}`} className="flex items-center gap-2">
              <ModelLabel provider={t.provider} model={t.model} className="text-muted" />
              <span className="ml-auto whitespace-nowrap tabular-nums text-ink">
                {t.priced && t.lowUsd !== null && t.highUsd !== null ? `${fmtCost(t.lowUsd)}–${fmtCost(t.highUsd)}` : "unknown"}
              </span>
              {/* MEASURED IS DATA, a borrowed model is a judgement call, a default is a caution. */}
              <Pill title={BASIS[t.basis]} tone={t.basis === "default" ? "info" : t.basis === "measured" ? FACT_TONE.dataset : FACT_TONE.judge}>
                {t.basis === "measured" ? `from ${t.sampleSize} run${t.sampleSize === 1 ? "" : "s"}` : t.basis === "other-model" ? "other model" : "default"}
              </Pill>
            </div>
          ))}
        </div>
      )}

      {estimate.notes.map((n, i) => (
        <div key={i} className="flex items-start gap-1.5 text-tiny text-faint">
          <Icon.evals.caveat size={ICON.xs} className="mt-px shrink-0" />
          <span>{n}</span>
        </div>
      ))}

      {/* WOULD IT BE REFUSED. Said here, before Run, in the words the refusal would use. */}
      {refusal && (
        <Alert tone="destructive" role="alert" className="items-start">
          <Icon.evals.refused size={ICON.xs} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{refusal}</span>
        </Alert>
      )}
    </>
  );
}

export function EvalRunBar() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  // A DRAFT HAS NO CODE: every job of an eval on it would fail on load. Said here, before an estimate.
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const unbuilt = agent?.draft === true ? `Build ${agent.name} before running an eval on it — it has no code yet.` : null;
  const error = useEvalStore((s) => s.error);
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
  // the common question, so it starts as one chosen leg rather than an empty row of chips — and after
  // that it is whatever was chosen for this agent, kept in the store so a remount does not reset it.
  const [initial] = useState<EvalTarget[]>(() => {
    const { provider, model } = useUiStore.getState();
    const runnable = isRunnable(useProviderStore.getState().providers, provider);
    return provider && model && runnable ? [{ provider, model }] : [];
  });
  const stored = useEvalStore((s) => (activeAgentId ? s.targetsByAgent[activeAgentId] : undefined));
  const targets = stored ?? initial;
  const setTargets = (update: (cur: EvalTarget[]) => EvalTarget[]): void => {
    if (activeAgentId) useEvalStore.getState().setTargets(activeAgentId, update(targets));
  };
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

  // RUN AGAIN'S HAND-OFF: the same models are already chosen; open their estimate, as a click would.
  // ABOVE THE EARLY RETURN, like every hook: below it, the panel's first render (no dataset chosen
  // yet) ran fewer hooks than the next, and React threw #310 and blanked the app.
  const estimateRequest = useEvalStore((s) => s.estimateRequest);
  useEffect(() => {
    if (!estimateRequest || estimateRequest !== activeAgentId || !selectedDatasetId) return;
    useEvalStore.getState().requestEstimate(null);
    if (!running && !unbuilt && examples.length && targets.length) {
      sendEstimateEval(selectedDatasetId, activeAgentId, targets);
      setConfirming(true);
    }
  }, [estimateRequest, selectedDatasetId, examples.length]);

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
  /** Why the estimate cannot be asked for yet, in the words its tooltip uses — or null when it can. */
  const estimateBlocked =
    !connected ? "Not connected"
      : unbuilt ? unbuilt
      : !examples.length ? "Add an example first"
      : !targets.length ? "Choose a model to run against"
      : null;
  const refusal = refusalOf(estimate);
  const warning = estimate && "usd" in parsedCeiling ? ceilingWarning(parsedCeiling.usd, estimate) : null;
  const { groups, missing } = modelGroups(catalogue, providerStatuses, targets);
  /** LOCKED, AND SAID SO, while an eval runs: the models would not change under a running eval. */
  const locked = running ? "Locked while this eval runs — choose the next eval's models when it finishes" : null;
  const openSecrets = (): void => { if (missing.first) useUiStore.getState().openSecretsForProvider(missing.first); };

  const confirmRun = () => {
    if (!activeAgentId || !("usd" in parsedCeiling)) return;
    sendStartEval(selectedDatasetId, activeAgentId, targets, parsedCeiling.usd);
    setConfirming(false);
    setEstimate(null);
  };

  return (
    // THE RUN AS THE TAB'S FOOTER: its own surface under a hairline, so what will run and what it
    // will cost read as one place rather than as more rows of the dataset above them.
    <div className="shrink-0 space-y-2.5 border-t border-hair bg-panel px-4 py-3">
      {/* WHICH MODELS, AS A PICKER AND THE ONES PICKED. The catalogue is a menu of checks grouped by
          provider, each behind its mark; what is chosen sits beside it as pills, each with its effort
          and a way off. It was every model as a chip, provider by provider, two or three rows deep. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={running}
              className={EVAL_SELECT}
              aria-label="Choose the models to compare"
              title={locked ?? "Choose the models to compare — each is billed per token"}
            >
              <Icon.evals.models size={ICON.xs} className="shrink-0 text-faint" />
              Models
              <Pill tone={targets.length ? "ink" : "neutral"} className="h-4 px-1.5">{targets.length}</Pill>
              <Icon.evals.menu size={ICON.xs} className="shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent edge="strong" align="start" side="top" aria-label="Models" className="max-h-[380px] w-[260px] overflow-y-auto">
            {groups.map((g, i) => (
              <Fragment key={g.id}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <ProviderMark provider={g.id} size={ICON.badge} />
                  {g.label}
                </DropdownMenuLabel>
                {g.models.map((m) => {
                  const t: EvalTarget = { provider: g.id, model: m };
                  const on = targets.some((x) => key(x) === key(t));
                  return (
                    <DropdownMenuCheckboxItem
                      tick="ok"
                      key={key(t)}
                      checked={on}
                      disabled={!g.usable && !on}
                      onCheckedChange={() => toggle(t)}
                      // THE MENU STAYS OPEN, because choosing three models is three presses, not three trips.
                      onSelect={(e) => e.preventDefault()}
                      title={g.usable ? `${g.label} · billed per token` : `No ${g.label} API key in this workspace`}
                    >
                      {modelName(providerModels, m)}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </Fragment>
            ))}
            {missing.count > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem size="compact" onSelect={openSecrets}>
                  <Icon.evals.needKey size={ICON.xs} />
                  +{missing.count} model{missing.count === 1 ? "" : "s"} need an API key →
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {targets.map((t) => {
          const model = providerModels.find((m) => m.id === t.model);
          const name = modelName(providerModels, t.model);
          // HOW HARD EACH CHOSEN MODEL THINKS, as Test mode lets you choose. An eval ran every model at
          // its default — Liven failed six of six on Sonnet 5 at a level Test mode would not have used.
          // Only the models that have levels get the menu; never a native select.
          const choices = effortChoices(model);
          const pick = (effort: string | null) =>
            setTargets((cur) => cur.map((x) => (key(x) === key(t) ? { ...x, effort } : x)));
          return (
            // A CHOSEN MODEL AS A TAG: its mark and name, its effort, and its own way off.
            <span key={key(t)} className="inline-flex h-7 max-w-full items-center gap-1 rounded-control border border-edge bg-elevated pl-2 pr-1 text-caption text-ink">
              <ModelLabel provider={t.provider} model={t.model} />
              {choices.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={running}
                      aria-label={`Reasoning effort for ${name}`}
                      title={locked ?? `How hard ${name} thinks on every case of this eval`}
                      // HOW HARD IT THINKS IS PART OF HOW IT IS SCORED, so it wears the judge's colour.
                      className={cn(badgeVariants({ tone: FACT_TONE.judge }), "hover:bg-bespoke/20 disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:bg-bespoke/20")}
                    >
                      <Icon.evals.effort size={ICON.badge} />
                      {choices.find((c) => c.value === (t.effort ?? null))?.label ?? "Default"}
                      <Icon.evals.menu size={ICON.badge} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent edge="strong" align="start" side="top" aria-label={`Effort for ${name}`}>
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                      <Icon.evals.effort size={ICON.badge} />
                      Effort
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={t.effort ?? "default"} onValueChange={(v) => pick(v === "default" ? null : v)}>
                      {choices.map((c) => (
                        <DropdownMenuRadioItem key={c.value ?? "default"} value={c.value ?? "default"} title={c.value ? undefined : "The model's own default"}>
                          <span className="flex-1 text-caption">{c.label}</span>
                          <Chosen on={(t.effort ?? null) === c.value} />
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button
                type="button"
                onClick={() => toggle(t)}
                disabled={running}
                aria-label={`Take ${name} off this eval`}
                title={locked ?? `Take ${name} off this eval`}
                className={cn(SOFT_ICON_XS, "h-5 w-5 rounded-sm")}
              >
                <Icon.evals.removeModel size={ICON.xs} />
              </button>
            </span>
          );
        })}

        {/* THE MODELS NO KEY RUNS, as one mark and a count that leads to Secrets — said in the bar too,
            so nobody has to open the menu to learn that more of the catalogue is there. */}
        {missing.count > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={openSecrets}
            title={`Add a key for ${missing.labels.join(", ")} in Secrets — ${missing.count} more model${missing.count === 1 ? "" : "s"} to compare on`}
          >
            <Icon.evals.needKey size={ICON.xs} />
            +{missing.count}
          </Button>
        )}
      </div>

      {/* the estimate — shown only when money is involved, and always as a range */}
      {confirming && (
        // THE ESTIMATE AS A CARD OVER THE BAR — the question the next press asks, with its own edge.
        <div className="space-y-2 rounded-card border border-edge bg-elevated px-3 py-2.5">
          {!estimate ? (
            // A refusal in place of the estimate, rather than "estimating…" for ever.
            error ? (
              <Alert tone="destructive" role="alert" className="items-start">
                <Icon.evals.refused size={ICON.xs} className="mt-px shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
              </Alert>
            ) : (
              <div className="flex items-center gap-1.5 text-tiny text-muted">
                <Icon.evals.estimate size={ICON.xs} className="shrink-0 animate-stream-pulse text-faint motion-reduce:animate-none" />
                estimating…
              </div>
            )
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-tiny">
                <span className={`inline-flex items-center gap-1.5 ${TYPE.sectionLabel}`}>
                  <Icon.evals.estimate size={ICON.xs} className="text-faint" />
                  Estimate
                </span>
                <Pill icon={Icon.evals.runs} tone={FACT_TONE.runs} title="Cases × models — one run of the agent each">
                  {estimate.examples} example{estimate.examples === 1 ? "" : "s"} ×{" "}
                  {estimate.targets} provider{estimate.targets === 1 ? "" : "s"} ={" "}
                  {estimate.totalRuns} run{estimate.totalRuns === 1 ? "" : "s"}
                </Pill>
              </div>
              {/* A RANGE, never a point value — this is a projection, not a quote. The figure the box
                  is opened for, so it is the largest type in the bar; it was amber, which means running. */}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-section tabular-nums text-ink">
                  {fmtCost(estimate.totalLowUsd)}–{fmtCost(estimate.totalHighUsd)}
                </span>
                <span className="text-tiny text-faint">roughly</span>
                {estimate.judgeHighUsd > 0 && (
                  <Pill icon={Icon.evals.judge} tone={FACT_TONE.judge} title="What scoring the answers is expected to cost — included in the range">
                    incl. {fmtCost(estimate.judgeLowUsd)}–{fmtCost(estimate.judgeHighUsd)} judge
                  </Pill>
                )}
              </div>

              <EstimateDetail estimate={estimate} />

              {/* STOP AT, ON ONE LINE. The explanation that wrapped between the field and the buttons
                  moved under them, with whatever this ceiling means against this estimate. */}
              <div className="flex flex-wrap items-center gap-2 border-t border-hair pt-2">
                <Icon.evals.ceiling size={ICON.xs} className="shrink-0 text-faint" />
                <label className="whitespace-nowrap text-tiny text-muted" htmlFor="eval-ceiling">Stop at</label>
                <span className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tiny text-faint">$</span>
                  <Input
                    id="eval-ceiling"
                    value={ceiling}
                    onChange={(e) => { setCeiling(e.target.value); setCeilingTyped(true); }}
                    aria-label="Stop at, in dollars"
                    aria-invalid={"error" in parsedCeiling}
                    inputMode="decimal"
                    className="w-24 pl-5 text-tiny tabular-nums"
                  />
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => { setConfirming(false); setEstimate(null); }}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={confirmRun}
                    disabled={"error" in parsedCeiling || refusal !== null}
                    title={refusal ?? ("error" in parsedCeiling ? parsedCeiling.error : undefined)}
                  >
                    <Icon.evals.run size={ICON.sm} />
                    Run for real
                  </Button>
                </span>
              </div>
              {"error" in parsedCeiling && <div className="text-tiny text-err" role="alert">{parsedCeiling.error}</div>}
              {/* A CAUTION, in the info blue: amber is spent only on what is running. */}
              {warning && (
                <Alert tone="info" role="status" className="items-start">
                  <Icon.evals.caveat size={ICON.xs} className="mt-px shrink-0" />
                  <span className="min-w-0 flex-1">{warning}</span>
                </Alert>
              )}
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
        // A STATUS BAR'S ROW: what will run and what it is billed by on the left, the one decision at
        // the right — and it WRAPS, so on a narrow panel the button drops under the facts rather than
        // being cut off at the panel's edge.
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-caption">
          <Pill icon={Icon.evals.runs} tone={FACT_TONE.runs} size="md" title="Cases × models — one run of the agent each">
            {examples.length} × {targets.length} = {examples.length * targets.length} run
            {examples.length * targets.length === 1 ? "" : "s"}
          </Pill>
          {unbuilt ? (
            <span className="min-w-0 text-tiny text-muted">{unbuilt}</span>
          ) : targets.length > 0 && (
            // A FACT ABOUT THE BILL, NOT SOMETHING RUNNING — it was amber, the colour of in flight.
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-tiny text-muted">
              <Icon.evals.cost size={ICON.xs} className="shrink-0 text-faint" />
              billed per token
            </span>
          )}
          {running ? (
            <IconButton variant="soft"
              className="ml-auto"
              icon={Icon.evals.cancel}
              // One eval per workspace, so this agent's running eval may be a teammate's. Say so before
              // somebody stops it.
              label={progress?.startedHere ? "Cancel this eval" : "Cancel this eval — it was started elsewhere in this workspace"}
              danger
              onClick={() => progress && sendCancelEval(progress.evalId)}
            />
          ) : (
            // THE TAB'S PRIMARY ACTION, AS THE ONE FILLED BUTTON WITH ITS WORD — the trace's own
            // construction for the next thing to do. §8: A GATE'S LABEL NAMES WHAT THE PRESS DOES. Every
            // eval sits behind a spend ceiling, so this opens the estimate rather than dispatching, and
            // "Run eval" would promise money moving that the next screen has not asked about yet.
            <Button
              size="sm"
              className="ml-auto"
              onClick={beginRun}
              disabled={estimateBlocked !== null}
              title={estimateBlocked ? `Estimate the cost of this eval — ${estimateBlocked}` : "Estimate the cost of this eval"}
            >
              <Icon.evals.estimate size={ICON.sm} />
              Estimate cost
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
