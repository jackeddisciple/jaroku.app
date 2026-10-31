// A tick as a badge: `BadgeCheckIcon` with its badge filled green and its tick white.
//
// THE PRODUCT OWNER'S TICK (2026-10-31), first for every tick in the Evals panel and then for the run
// header's finished pill. Its own file because two panels draw it, and a panel reaching into another
// panel's kit for one mark is how the two end up a size apart.
//
// TWO LAYERS OF ONE MARK, because the mark draws its tick BEFORE its badge: filled, the badge would
// paint over the tick. So the lower copy fills every path green — the tick's own stroke vanishes into
// the badge — and the upper copy hides the badge and strokes only the tick, in white.

import type { IconComponent } from "../lib/icons/registry.ts";
import { cn } from "../lib/utils.ts";

export function BadgeTick({
  mark: Mark,
  size = 15,
  title,
  className,
}: {
  /** The registry key that draws it — each place's own `BadgeCheckIcon` key, so every key keeps a call site. */
  mark: IconComponent;
  /** The badge's size; the tick is drawn inside it. */
  size?: number;
  /** An accessible name, when the tick is the only thing saying what it says. Decorative otherwise. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      {...(title ? { role: "img", "aria-label": title, title } : { "aria-hidden": true })}
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <Mark size={size} className="absolute inset-0 text-ok [&_path]:fill-current" />
      <Mark size={size} className="absolute inset-0 text-elevated [&_path:nth-child(2)]:hidden" />
    </span>
  );
}
