// The key — shadcn/ui's Kbd, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/kbd.tsx`. A
// key a person presses, drawn as a keycap — a raised hairline box with its lower edge a shade darker —
// the way an editor's command palette shows a shortcut beside the command.

import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-xs border border-edge bg-panel px-1 font-sans text-tiny text-muted shadow-[inset_0_-1px_0] shadow-edge",
        className,
      )}
      {...props}
    />
  );
}
