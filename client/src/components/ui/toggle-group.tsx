// The toggle group — shadcn/ui's ToggleGroup, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its
// `components/ui/toggle-group.tsx` (over `@radix-ui/react-toggle-group`), drawn as an editor's
// segmented filter — a hairline track on the panel's ground, the chosen item lifted onto the elevated
// ground with its own edge, the rest muted until reached for.
//
// ONE OF SEVERAL, AND ALWAYS ONE. With `type="single"` Radix gives each item `role="radio"` and
// `aria-checked`, and arrow keys between them; the root is a `radiogroup` here rather than Radix's
// plain `group`, because "2 of 3, selected" is the whole state in one phrase (the same reason
// `Segmented.tsx` is one). Radix also lets a pressed item be pressed OFF, leaving nothing chosen —
// `onValueChange` ignores that, so a filter is never empty.

import type { ComponentProps, Ref } from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "../../lib/utils.ts";

type SingleProps = Omit<ToggleGroupPrimitive.ToggleGroupSingleProps, "type" | "onValueChange"> & {
  onValueChange: (value: string) => void;
  ref?: Ref<HTMLDivElement>;
};

export function ToggleGroup({ className, onValueChange, ...props }: SingleProps) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      role="radiogroup"
      {...props}
      type="single"
      onValueChange={(v: string) => { if (v) onValueChange(v); }}
      className={cn("inline-flex items-center gap-0.5 rounded-control border border-edge bg-panel p-0.5", className)}
    />
  );
}

export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-tiny tabular-nums text-muted outline-none transition-colors duration-fast",
        "hover:bg-active hover:text-ink focus-visible:shadow-focusring",
        "data-[state=on]:bg-elevated data-[state=on]:text-ink data-[state=on]:ring-1 data-[state=on]:ring-edge",
        "disabled:cursor-default disabled:text-disabled disabled:opacity-60 disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}
