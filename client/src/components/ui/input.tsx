// The text field — shadcn/ui's Input and Textarea, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: these are its `components/ui/input.tsx`
// and `textarea.tsx`, with its theme variables swapped for ours. §11: a text field is on the INPUT
// rung (`rounded-input`, 10px) and never on the button's, which `surfaceSystem.test.ts` holds every
// `<input>` and `<textarea>` in the client to.
//
// AN EDITOR'S FIELD: the elevated ground, §01's strongest border — the same edge as the select boxes
// beside it, so a row of fields and pickers reads as one row — and the focus ring, never a second
// border colour. `aria-invalid` turns the edge red, so a field says it is wrong without a class.

import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const FIELD =
  "w-full min-w-0 rounded-input border border-grip bg-elevated text-ink outline-none transition-[box-shadow,border-color] duration-fast placeholder:text-faint focus-visible:shadow-focusring aria-[invalid=true]:border-err disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(FIELD, "h-7 px-2 text-caption", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "resize-none px-2 py-1 text-caption", className)} {...props} />;
}
