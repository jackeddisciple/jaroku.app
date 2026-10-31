// The table — shadcn/ui's Table, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: this is its `components/ui/table.tsx`,
// plain elements with its theme variables swapped for ours, drawn as an editor's grid: a header row
// on the panel's ground in the section label's caps, a hairline under every row but the last, and a
// wash under the row the pointer is on. It scrolls sideways inside its own box rather than pushing the
// panel wider.

import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full border-separate border-spacing-0 text-caption", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-panel", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("transition-colors duration-fast hover:bg-active/40", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn("h-8 whitespace-nowrap border-b border-hair px-2 text-left align-middle text-tiny font-normal uppercase tracking-wider text-muted", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("border-b border-hair px-2 py-2 align-middle [tr:last-child>&]:border-b-0", className)} {...props} />;
}
