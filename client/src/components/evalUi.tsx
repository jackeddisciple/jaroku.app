// The small pieces every view of the Evals tab is built from, so its five files draw a status, a
// model and a fact one way rather than five.

import type { ReactNode } from "react";
import { ProviderMark } from "../lib/icons.tsx";
import type { IconComponent } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { modelName, useProviderStore } from "../store/providerStore.ts";

export type PillTone = "neutral" | "ink" | "ok" | "err" | "info";

/**
 * Each tone's ground and ink. The three status colours are spent on what they mean — a match, a
 * failure, a caution — and everything that is only a label stays in the neutral greys.
 */
const PILL_TONE: Record<PillTone, string> = {
  neutral: "bg-active text-muted",
  ink: "bg-chrome text-ink",
  ok: "bg-ok/10 text-ok",
  err: "bg-err/10 text-err",
  info: "bg-warn/10 text-warn",
};

/** A label in a pill: a mark and a word or a figure, never a sentence. */
export function Pill({
  icon: Mark,
  tone = "neutral",
  title,
  children,
  className = "",
}: {
  icon?: IconComponent;
  tone?: PillTone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-pill px-1.5 text-tiny tabular-nums ${PILL_TONE[tone]} ${className}`}
    >
      {Mark && <Mark size={ICON.badge} />}
      {children}
    </span>
  );
}

/**
 * A model as every eval view names it: its provider's mark, then the name the run bar uses — "Haiku
 * 4.5" — with the id kept in the tooltip. The mark is what tells two providers' rows apart at a
 * glance, so the provider's name is never spelled out beside it.
 */
export function ModelLabel({
  provider,
  model,
  effort,
  className = "",
}: {
  provider: string;
  model: string;
  /** How hard this leg thought, when it was asked to — said after the name. */
  effort?: string | null;
  className?: string;
}) {
  const providerModels = useProviderStore((s) => s.models);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={`${provider} · ${model}`}>
      <span aria-hidden className="inline-flex shrink-0"><ProviderMark provider={provider} size={ICON.xs} /></span>
      <span className="min-w-0 truncate">{modelName(providerModels, model)}</span>
      {effort && <span className="shrink-0 text-faint">({effort})</span>}
    </span>
  );
}
