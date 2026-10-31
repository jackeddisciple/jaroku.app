// The alert — shadcn/ui's Alert, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/alert.tsx`
// (class-variance-authority over a `<div>`), laid out as an editor's notification is — a mark, the
// sentence, and whatever can be done about it at the end of the line — rather than shadcn's title
// over a description. The tone is the whole card's: a refusal is red on a red wash with a red edge, a
// notice is the panel's own ground, and the info blue is a caution. Never amber, which means running.

import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

export const alertVariants = cva("flex flex-wrap items-center gap-2 rounded-card border px-3 py-2 text-tiny", {
  variants: {
    tone: {
      default: "border-hair bg-panel text-muted",
      destructive: "border-err/25 bg-err/5 text-err",
      info: "border-warn/25 bg-warn/5 text-warn",
    },
  },
  defaultVariants: { tone: "default" },
});

export function Alert({ className, tone, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}
