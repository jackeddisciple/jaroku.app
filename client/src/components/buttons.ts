// The app's button weights, in one place.
//
// The plan card and the diff card ask the same shape of question — here is what would happen, do
// you want it — and they were answering it with two byte-identical copies of the same two class
// strings. Two copies is how "Apply" and "Generate" end up a pixel apart after somebody adjusts one
// of them, which is the sort of difference nobody can name and everybody notices.
//
// Nine weights, because the app has nine kinds of control:
//
//   primary    the decision the card exists to ask — Generate, Apply
//   outline    a real action that is not *the* action — the second button in a pair
//   quiet      the other answer, which must be available without being urged — Discard
//   secondary  not a decision at all: a way back, or a thing to look at — Undo, the version picker
//   icon       a glyph on its own, sized to the glyph rather than to a word
//   tab        one of a set of destinations, where the set is the control
//   mark       a surface's own action as a glyph on a grey ground — the trace's, the eval's
//   text       a word that acts, small — Stop comparing, Cancel beside a field
//   fact       a pressable fact on a header's metadata line
//
// The last two were the gap. This file opened saying it covered three weights and the app had
// five more spellings of them scattered across components — a tab recipe in RightPanel, a second
// in AgentTabs, a third in the sidebar's filter row, a dismiss button in GitHubPanel, a restore
// button in the sidebar. Five padding-and-height combinations for one emphasis level is exactly
// how two adjacent buttons end up a pixel apart, which is the problem this file was opened to fix
// and had only half-fixed.
//
// Class strings rather than a Button component on purpose. These call sites need their own
// disabled logic, titles, icons and layout, and a component that took all of that as props would be
// a worse way of saying the same thing. `tabBtn` is a function only because its one variable is
// binary and the alternative is every call site concatenating the same ternary.

/**
 * The decision. Ink fill, background-coloured text — the one control on a card that is
 * unmistakably the thing being asked.
 *
 * IT USED TO BE `bg-panel text-ink`, one surface step off the page it sat on — under the near-black
 * palette that was #18181b on #0d0d0f, a four percent lightness step, and it is a comparably small
 * step on §01's light ladder — and therefore the *least* visible control on the card it appeared on
 * either way. The weight named
 * "primary" was quieter than the muted-text "Discard" beside it, which inverts the whole hierarchy
 * — a card asking "apply this, or not?" was drawing the yes softer than the no. That recipe is
 * still here, correctly named, as `outlineBtn`.
 *
 * Ink rather than an accent because the accent is spent on interaction — selection, links, focus,
 * live iconography — and a filled button is not any of those. Ink fill is the app's loudest
 * treatment and this is the one weight allowed to use it.
 *
 * `inline-flex items-center gap-1.5` for the same reason `secondaryBtn` has it: several call sites
 * pass an icon *and* a label, and without a flex context the glyph is a block that stacks above the
 * words. That was visible on the GitHub tab, where the primary call to action rendered the mark on
 * one line and "Connect GitHub" on the next.
 */
export const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-label bg-ink text-bg hover:bg-ink/90 active:bg-ink/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * The primary, compact: the same ink fill at a 28px height and caption-size words, for a pane where a
 * full-size primary is the loudest thing in view — Step details' re-run pair, which the product owner
 * found "huge" (2026-10-14).
 */
export const primaryBtnSm =
  "inline-flex h-7 items-center gap-1.5 rounded-control px-2.5 text-caption bg-ink text-bg hover:bg-ink/90 active:bg-ink/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * A real action that is not *the* action — the second button in a pair, or the primary of a card
 * that is not the screen's centre. Filled one surface step, ink text.
 *
 * This is the recipe `primaryBtn` used to be. It was never a bad button; it was a bad *primary*.
 */
export const outlineBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-label bg-panel text-ink hover:bg-active active:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * The other answer. Same box as primary so the two sit level, but no surface until you hover —
 * declining should be one step away, never one step *down*.
 *
 * It had no surface at *any* state before this, only a text-colour shift, which meant "Discard"
 * beside "Apply" read as a caption rather than as the other half of a real decision. A ghost
 * button still has to show its hit area on approach; that is what makes it a button rather than
 * a word somebody happened to make clickable.
 */
export const quietBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-label text-muted hover:bg-active hover:text-ink active:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * Not a decision. Same surface and radius as primary, one size down and muted until you reach for
 * it. `inline-flex` because everything at this weight carries an icon.
 */
export const secondaryBtn =
  "inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-tiny bg-panel text-muted hover:text-ink hover:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * A glyph on its own — a dismiss, a disclosure chevron, a row's edit or archive.
 *
 * Padded to the glyph, not to a word. `quietBtn`'s `px-3 py-1.5` is sized for text, so wrapping a
 * 12px chevron in it produced a ~44px control to hold a 12px mark and broke the row rhythm around
 * it. Square, so a row of these forms an even column.
 *
 * Every use of this needs a `title` — a glyph with no tooltip is not dense, it is unusable.
 */
export const iconBtn =
  "inline-flex items-center justify-center rounded-control p-1 text-muted hover:bg-active hover:text-ink active:bg-active transition-colors focus-visible:outline-none focus-visible:shadow-focusring disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * One destination in a set. The app had four spellings of this — the right panel's ten, the
 * evals sub-tabs, the agent detail's four, the sidebar's six filters — each with its own padding
 * and its own idea of what "active" looks like.
 *
 * Active is an accent label plus a 2px underline rather than a background fill. `bg-active` is
 * also the row-hover colour everywhere else in the app, so a filled tab and a hovered tab were
 * the same colour: the weakest possible indicator, spelled the same way as a different idea.
 */
export const tabBtn = (active: boolean, size: "sm" | "md" = "md"): string =>
  [
    "relative inline-flex items-center gap-1.5 rounded-control transition-colors",
    size === "sm" ? "px-2 py-1 text-tiny" : "px-3 py-1.5 text-label",
    "focus-visible:outline-none focus-visible:shadow-focusring",
    active
      ? "text-accent after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent"
      : "text-muted hover:bg-active/40 hover:text-ink",
  ].join(" ");

/**
 * A surface's own action as a mark on a grey ground, 32px square — copy the run's id, run it again.
 *
 * THE TRACE HEADER'S, MOVED HERE when the Evals panel took its header from it: two panels spelling
 * one button is how they end up a pixel apart. It fades with its ground when it cannot be pressed,
 * so a disabled mark still reads as the same button rather than as a lighter one.
 */
export const markBtn =
  "inline-flex h-8 w-8 items-center justify-center rounded-control bg-active text-muted transition-colors hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-active disabled:hover:text-muted";

/**
 * A word that acts, small — Stop comparing, Cancel beside a field, + Criterion. The trace's own
 * spelling of it (its result card's Show more), with the hit area shown on approach so it reads as a
 * button rather than as a word somebody happened to make clickable.
 */
/**
 * A trigger that opens a list to choose from — which eval, which dataset, which models — drawn as an
 * editor's select is: a hairline box on the card's ground, what is chosen in ink, and a chevron after
 * it. A `secondaryBtn` read as an action, and pressing one of these changes nothing until something in
 * its list is picked. It stays pressed-looking while its list is open.
 */
export const selectBtn =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control border border-edge bg-panel px-2 text-caption text-ink transition-colors hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-active";

export const textBtn =
  "rounded-control px-2 py-1 text-tiny text-muted transition-colors hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * A fact on a header's metadata line, as a round pill in the darker grey, darker still on hover — a
 * run's id, when it started, the eval it belongs to. Square, faint chips read as background (the
 * product owner's call, 2026-10-14). Moved here from the trace header with `markBtn`.
 */
export const factChip =
  "rounded-full bg-chrome px-2 py-px text-tiny text-muted transition-colors hover:bg-edge hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring";
