// The collapsible — shadcn/ui's Collapsible, copied in.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/collapsible.tsx`
// (over `@radix-ui/react-collapsible`), which has no look of its own — the trigger is whatever it is
// given `asChild`, and the content is a region that is present only while open. What Radix brings is
// the pairing: `aria-expanded` and `aria-controls` on the trigger, an id on the region, and
// `data-state` on both for a chevron to turn by.

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;
