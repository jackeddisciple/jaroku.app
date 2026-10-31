// The separator — shadcn/ui's Separator, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/separator.tsx`
// (over `@radix-ui/react-separator`). A hairline between groups of a toolbar, as an editor's action bar
// divides its groups. Decorative by default — a screen reader is not told about a line it cannot see
// the point of — and `decorative={false}` makes it a real `role="separator"`.

import type { ComponentProps } from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "../../lib/utils.ts";

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn("shrink-0 bg-hair", orientation === "horizontal" ? "h-px w-full" : "h-4 w-px", className)}
      {...props}
    />
  );
}
