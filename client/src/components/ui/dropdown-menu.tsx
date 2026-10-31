// The dropdown menu — shadcn/ui's DropdownMenu, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: these are its
// `components/ui/dropdown-menu.tsx` (manual install, over `@radix-ui/react-dropdown-menu`) with its
// theme variables swapped for ours. What Radix brings is the part every hand-built menu here had to
// grow one bug at a time — focus moving into the menu and back to its trigger (the old
// lib/menuFocus.ts), arrow keys and typeahead, a portal so a scrolling list cannot clip it (the old
// lib/anchoredMenu.ts; both deleted once nothing used them),
// flipping to open upward at the bottom of the window, and a press outside that closes the menu
// without also landing on whatever was under it.
//
// THE MENUS MOVE ONE SURFACE AT A TIME (2026-10-09, the product owner's call, the same rule the
// tooltip followed). The sidebar's three came first; the rest still use the hook.
//
// The surface is the one the sidebar's menus already drew: an elevated card with the default
// border, `shadow-floating`, and rows that fill on hover. Radix highlights a row by FOCUSING it, for
// the pointer and the keyboard alike, so the fill is `data-[highlighted]` rather than `hover:` —
// one state, whichever way somebody got there.

import type { ComponentProps } from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ICON } from "../../lib/tokens.ts";
import { CheckIcon } from "../panelIcons.tsx";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

/**
 * The row every menu item wears. Spelled once so the menus cannot drift apart.
 *
 * A DISABLED ROW STILL TAKES THE POINTER, unlike shadcn's, because here a disabled control carries
 * its reason in its tooltip (§8) — "Reconnecting — this needs a connection" — and a row the pointer
 * passes through never shows one. Radix already skips it for the keyboard and refuses its select.
 */
const ROW =
  "flex w-full cursor-default select-none items-center gap-2.5 px-2.5 py-1.5 text-left outline-none transition-colors duration-fast data-[highlighted]:bg-active data-[disabled]:text-disabled data-[disabled]:data-[highlighted]:bg-transparent";
/** The two type sizes a menu row comes in: the sidebar's, and the chat header's compact one. */
const ROW_SIZE = { normal: "text-body", compact: "rounded-control text-caption" } as const;
/**
 * THE INK IS A PROP, NOT A CLASS ON TOP. A `text-err` added beside the row's own `text-muted` is two
 * colours on one element, and which one paints is decided by the order Tailwind happens to emit them
 * in — Delete came out grey. A tone picks exactly one.
 */
const ROW_TONE = {
  default: "text-muted data-[highlighted]:text-ink",
  danger: "text-err",
} as const;

/**
 * The menu's edge. `default` is the border every card draws; `strong` is §01's strongest border, for
 * a surface whose menus sat too faintly on the page (the Evals panel's, 2026-10-31 — the product
 * owner found their edge "very light"). A prop rather than a class on top, for `ROW_TONE`'s reason.
 */
const EDGE = { default: "border-edge", strong: "border-grip" } as const;

export function DropdownMenuContent({
  className = "",
  sideOffset = 4,
  edge = "default",
  ...props
}: ComponentProps<typeof MenuPrimitive.Content> & { edge?: keyof typeof EDGE }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        // THE MENU GROWS OUT OF ITS TRIGGER: `menu-in` when it opens downward and `menu-in-up` when
        // Radix flips it upward, from the origin Radix computes rather than a fixed edge.
        className={`z-50 min-w-[170px] origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden rounded-card border ${EDGE[edge]} bg-elevated p-1 shadow-floating data-[side=bottom]:animate-menu-in data-[side=top]:animate-menu-in-up motion-reduce:animate-none ${className}`}
        {...props}
        // A NAME GIVEN IS THE NAME USED. Radix labels a menu by its trigger, and `aria-labelledby`
        // outranks `aria-label` — so the account menu was announced as the person's own name rather
        // than "Account". Given an explicit label, the trigger's text stops overriding it.
        {...(props["aria-label"] ? { "aria-labelledby": undefined } : {})}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className = "",
  size = "normal",
  tone = "default",
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { size?: keyof typeof ROW_SIZE; tone?: keyof typeof ROW_TONE }) {
  return <MenuPrimitive.Item className={`${ROW} ${ROW_SIZE[size]} ${ROW_TONE[tone]} ${className}`} {...props} />;
}

/**
 * An item that brings its own look — the admin toggle's banner and its Enable/Cancel pair, which are
 * buttons in a menu rather than rows. Still an item, so the arrow keys reach it: a menu moves
 * between items and keeps Tab to itself, and a plain button inside one is a control the keyboard
 * cannot get to.
 */
export function DropdownMenuPlainItem({ className = "", ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item className={`cursor-default select-none outline-none ${className}`} {...props} />;
}

/**
 * One of several, with exactly one in force — the agent filter. `aria-checked` comes from Radix, and
 * the chosen row sits on the selected fill the way a chosen row does everywhere else.
 */
export function DropdownMenuRadioItem({ className = "", ...props }: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return <MenuPrimitive.RadioItem className={`${ROW} ${ROW_SIZE.normal} ${ROW_TONE.default} data-[state=checked]:bg-chrome data-[state=checked]:text-ink ${className}`} {...props} />;
}

/**
 * One of several that are each on or off — the eval case list's view options. shadcn's, with its
 * indicator drawn as this app's `Checkbox` draws one, so a check in a menu and a check in a list are
 * the same mark. `aria-checked` comes from Radix; the row keeps the menu open when `onSelect` says so.
 */
/**
 * The box a checked row draws. `ink` is the app's `Checkbox`; `ok` is a GREEN tick on a firmer empty
 * box — the Evals panel's, where the product owner asked that a tick always read green (2026-10-31).
 */
const TICK = {
  ink: { on: "border-accent bg-accent text-bg", off: "border-edge text-transparent" },
  ok: { on: "border-ok bg-ok text-bg", off: "border-grip text-transparent" },
} as const;

export function DropdownMenuCheckboxItem({
  className = "",
  children,
  checked,
  tick = "ink",
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem> & { tick?: keyof typeof TICK }) {
  const on = checked === true;
  return (
    <MenuPrimitive.CheckboxItem className={`${ROW} ${ROW_SIZE.compact} ${ROW_TONE.default} ${className}`} checked={checked} {...props}>
      <span
        aria-hidden
        className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-xs border transition-colors duration-fast ${
          on ? TICK[tick].on : TICK[tick].off
        }`}
      >
        <CheckIcon size={ICON.badge} />
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuSeparator({ className = "", ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={`my-1 h-px bg-edge ${className}`} {...props} />;
}

export function DropdownMenuLabel({ className = "", ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={`px-2.5 py-1 text-tiny uppercase tracking-wider text-faint ${className}`} {...props} />;
}
