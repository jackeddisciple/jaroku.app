// The tabs — shadcn/ui's Tabs, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: these are its `components/ui/tabs.tsx`
// (over `@radix-ui/react-tabs`) with its theme variables swapped for ours, and its look swapped for an
// editor's panel tabs — VS Code's PROBLEMS · OUTPUT · TERMINAL row — rather than shadcn's pill track:
// words on the panel's ground, the chosen one in ink with a 2px bar under it, the rest muted.
//
// What Radix brings is what a row of `role="tab"` buttons had to be told one attribute at a time:
// `aria-selected` and `aria-controls` paired with a `tabpanel`, arrow keys between the tabs with only
// the chosen one in the Tab order, and Home and End.
//
// A PANEL THAT IS NOT CHOSEN IS `hidden`, AND THAT IS NOT ENOUGH ON ITS OWN. Radix keeps the inactive
// panel in the tree with the `hidden` attribute, and a `flex` class outranks the attribute's
// `display: none` — so the content carries `data-[state=inactive]:hidden` to keep the class honest.

import type { ComponentProps } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils.ts";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex items-center gap-1 border-b border-hair", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative -mb-px inline-flex h-9 items-center gap-1.5 rounded-t-control px-2.5 text-caption text-muted outline-none transition-colors duration-fast",
        "hover:text-ink focus-visible:shadow-focusring",
        "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors",
        "data-[state=active]:text-ink data-[state=active]:after:bg-ink",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none data-[state=inactive]:hidden", className)} {...props} />;
}
