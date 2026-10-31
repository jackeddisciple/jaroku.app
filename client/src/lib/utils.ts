// shadcn/ui's `cn()` — clsx to join class names, tailwind-merge to settle the ones that conflict.
//
// The shadcn components under `components/ui/` that are written with class-variance-authority build
// their classes with this, so a caller's `className` REPLACES a variant's class rather than sitting
// beside it. Two classes for one property on one element paint whichever Tailwind happened to emit
// last — `dropdown-menu.tsx` records the Delete row that came out grey that way.
//
// TAUGHT THIS APP'S OWN SCALES, OR IT MERGES THE WRONG THINGS. tailwind-merge knows Tailwind's
// default theme, and this one renames all three of the scales it would get wrong:
//
//   * the type ladder (`text-tiny` … `text-display`, typography.pdf) — unknown names read as colours,
//     so `cn("text-tiny text-muted", "text-ok")` would have dropped the SIZE along with the colour;
//   * the radius rungs (`rounded-control`, `rounded-input`, `rounded-card`, `rounded-pill`, …);
//   * the elevation levels and rings (`shadow-raised`, `shadow-floating`, `shadow-focusring`, …).
//
// The lists are the ones `tailwind.config.js` declares; `utils.test.ts` holds them to it.
//
//   npm run test:cn

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The type ladder's eight rungs, as `tailwind.config.js` names them. */
export const TEXT_RUNGS = ["display", "page", "section", "title", "body", "label", "caption", "tiny"] as const;
/** The radius rungs Tailwind's defaults do not already have. */
export const RADIUS_RUNGS = ["control", "input", "card", "hero", "pill"] as const;
/** The elevation levels, the glows and the focus ring. */
export const SHADOWS = ["raised", "floating", "overlay", "focusring", "glow", "glow-cta"] as const;

const merge = extendTailwindMerge({
  extend: {
    theme: { borderRadius: [...RADIUS_RUNGS] },
    classGroups: {
      "font-size": [{ text: [...TEXT_RUNGS] }],
      shadow: [{ shadow: [...SHADOWS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
