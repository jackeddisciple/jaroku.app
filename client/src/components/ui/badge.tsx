// The badge — shadcn/ui's Badge, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/badge.tsx`
// (class-variance-authority over a `<span>`) with its variants swapped for this palette's. A badge
// is a label in a pill — a mark and a word or a figure, never a sentence.
//
// THE TONES ARE new-theme.pdf's, AND ONLY ITS. The four status colours mean what they mean
// everywhere: green a success or a match, red a failure, the info blue a caution or a stop, and
// amber ONLY what is in flight right now (`run`). The four hues after them are the palette's other
// colours, for facts that are not statuses — an agent, a dataset, a judge, a count of runs — so a
// row of them is told apart by colour before it is read. `colourSystem.test.ts` caps those four at
// 2% of the client's coloured classes, which is why they are spelled once, here.
//
// The Evals panel is the one surface that uses this (2026-10-31, the product owner's call); every
// other panel keeps its own pills until it moves.

import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

export const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-pill tabular-nums transition-colors focus-visible:outline-none focus-visible:shadow-focusring",
  {
    variants: {
      tone: {
        /** A label and nothing more. */
        neutral: "bg-active text-muted",
        /** A label that is the subject of its line. */
        ink: "bg-chrome text-ink",
        ok: "bg-ok/10 text-ok",
        err: "bg-err/10 text-err",
        /** A caution or a stop — the trace's stopped blue. */
        info: "bg-warn/10 text-warn",
        /** In flight. Nothing else is amber. */
        run: "bg-run/10 text-run",
        teal: "bg-reviewed/10 text-reviewed",
        purple: "bg-bespoke/10 text-bespoke",
        indigo: "bg-stateful/10 text-stateful",
        pink: "bg-runssoft text-runsink",
      },
      size: {
        sm: "h-5 px-1.5 text-tiny",
        md: "h-6 px-2 text-tiny",
      },
    },
    defaultVariants: { tone: "neutral", size: "sm" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({ className, tone, size, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
