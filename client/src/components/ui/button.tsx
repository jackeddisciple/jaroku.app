// The button — shadcn/ui's Button, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/button.tsx`
// (class-variance-authority, and Radix's Slot for `asChild`) with its variants swapped for this app's
// weights. `buttons.ts` still holds the class strings the rest of the app uses; the Evals panel is
// drawn with these (2026-10-31), and the two agree on the weights that both have — `default` is
// `primaryBtn`'s ink fill, `ghost` is `quietBtn`'s.
//
// `soft` IS THE ONE THIS FILE WAS COPIED IN FOR. An icon button that shows its square only under the
// pointer reads, at rest, as a loose glyph on the page, and a row of six of them as decoration; the
// product owner asked for the square to stay. A soft button sits on its grey ground permanently and
// darkens under the pointer — the trace header's `markBtn`, as a variant rather than a string.
//
// `type="button"` BY DEFAULT, unlike shadcn's: a button inside the rename form that forgot its type
// submitted the form.

import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        /** The decision — ink fill. One per surface. */
        default: "bg-ink text-bg hover:bg-ink/90 active:bg-ink/80",
        /** A real action that is not *the* action. */
        secondary: "bg-active text-ink hover:bg-chrome active:bg-edge",
        /** A field-like box: a hairline on the elevated ground. */
        outline: "border border-grip bg-elevated text-ink hover:bg-panel data-[state=open]:bg-panel",
        /** The other answer, no ground until it is reached for. */
        ghost: "text-muted hover:bg-active hover:text-ink",
        /** A ground that stays — see above. */
        soft: "bg-active text-muted hover:bg-chrome hover:text-ink active:bg-edge data-[state=open]:bg-chrome data-[state=open]:text-ink disabled:hover:bg-active disabled:hover:text-muted",
        /** A removal, on the same ground, red on approach — never amber, which means running. */
        destructive: "bg-active text-faint hover:bg-err/10 hover:text-err active:bg-err/15 disabled:hover:bg-active disabled:hover:text-faint",
      },
      size: {
        default: "h-8 px-3 text-label",
        sm: "h-7 px-2.5 text-caption",
        xs: "h-6 px-2 text-tiny",
        icon: "h-8 w-8",
        "icon-sm": "h-7 w-7",
        "icon-xs": "h-6 w-6",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
