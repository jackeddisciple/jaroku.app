// The small pieces every view of the Evals tab is built from, so its five files draw a status, a
// model and a fact one way rather than five.
//
// BUILT ON shadcn/ui's components (`components/ui/`), restyled to this app's tokens — the Evals panel
// is the first surface drawn with them (2026-10-31), and these are the eval-only variants of them.

import type { ReactNode } from "react";
import { ProviderMark } from "../lib/icons.tsx";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { cn } from "../lib/utils.ts";
import { modelName, useProviderStore } from "../store/providerStore.ts";
import { Badge, type BadgeTone } from "./ui/badge.tsx";
import { buttonVariants } from "./ui/button.tsx";

export type PillTone = BadgeTone;

/**
 * An icon-only button's square, KEPT AT REST — shadcn's `soft` button — for the ones that cannot be an
 * `IconButton` (`variant="soft"`): a menu's trigger, which Radix needs to be the plain `<button>` under
 * `DropdownMenuTrigger asChild`, and the small marks inside a chip or a field. 32, 28 and 24 pixels.
 */
export const SOFT_ICON = buttonVariants({ variant: "soft", size: "icon" });
export const SOFT_ICON_SM = buttonVariants({ variant: "soft", size: "icon-sm" });
export const SOFT_ICON_XS = buttonVariants({ variant: "soft", size: "icon-xs" });
/** A removal's square, at 28px — red on approach, never amber. */
export const SOFT_DANGER_SM = buttonVariants({ variant: "destructive", size: "icon-sm" });

/**
 * A trigger that opens a list to choose from — which eval, which dataset, which models — as an
 * editor's select box: shadcn's `outline` button, the field's white ground, and §01's STRONG border.
 * The default border sat too faintly on the panel (the product owner, 2026-10-31); held down while
 * its list is open.
 */
export const EVAL_SELECT = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  // `shrink`: shadcn's button never shrinks, and a select is the one thing in a toolbar that must.
  "min-w-0 shrink justify-start gap-1.5 px-2 text-caption hover:border-muted/60 data-[state=open]:border-muted/60 data-[state=open]:shadow-focusring",
);

/**
 * The tick beside the chosen row of a menu — ALWAYS GREEN (the product owner, 2026-10-31). Unchosen
 * rows keep the space, invisibly, so the words of every row start and end in one column.
 */
export function Chosen({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 ${on ? "text-ok" : "text-transparent"}`}>
      <Icon.evals.chosen size={ICON.xs} />
    </span>
  );
}

/**
 * WHICH COLOUR EACH KIND OF FACT WEARS, everywhere in the tab — so an agent is the same indigo in the
 * header, the picker and the comparison, and colour reads as a kind before the word is read. The
 * status colours are not here: they are spent on outcomes (`ok`, `err`, `info`, `run`) and nothing
 * else. Time is neutral, because every row has one.
 */
export const FACT_TONE = {
  /** Whose eval: the agent, and its version. */
  agent: "indigo",
  /** What it ran on: the dataset, its cases, how answers are checked. */
  dataset: "teal",
  /** How it was scored: the judge, the rubric, a criterion, a model's effort. */
  judge: "purple",
  /** How much ran: runs, retries, attempts, how long it took. */
  runs: "pink",
  /** When. */
  when: "neutral",
} as const satisfies Record<string, PillTone>;

/** A label in a pill: a mark and a word or a figure, never a sentence. shadcn's Badge underneath. */
export function Pill({
  icon: Mark,
  tone = "neutral",
  size = "sm",
  title,
  children,
  className = "",
}: {
  icon?: IconComponent;
  tone?: PillTone;
  size?: "sm" | "md";
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={tone} size={size} title={title} className={className}>
      {Mark && <Mark size={ICON.badge} />}
      {children}
    </Badge>
  );
}

/**
 * A fact on a header's line — whose eval, when, how long — as a coloured pill that can be focused, so
 * its tooltip is reachable by keyboard as well as by pointer.
 */
export function FactPill({
  icon: Mark,
  tone,
  children,
  className = "",
}: {
  icon: IconComponent;
  tone: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={tone} tabIndex={0} className={cn("cursor-default", className)}>
      <Mark size={ICON.badge} className="shrink-0" />
      {children}
    </Badge>
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
  /** How hard this leg thought, when it was asked to — a judge-coloured pill after the name. */
  effort?: string | null;
  className?: string;
}) {
  const providerModels = useProviderStore((s) => s.models);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={`${provider} · ${model}`}>
      <span aria-hidden className="inline-flex shrink-0"><ProviderMark provider={provider} size={ICON.xs} /></span>
      <span className="min-w-0 truncate">{modelName(providerModels, model)}</span>
      {effort && <Pill tone={FACT_TONE.judge} className="h-4 px-1">{effort}</Pill>}
    </span>
  );
}
