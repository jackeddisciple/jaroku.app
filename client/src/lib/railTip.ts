// The right rail's tooltip for one of its cells.
//
// The cell already showing hides the panel when pressed again — the rail's toggle, in another place —
// and it says so: pressing Evals on Evals used to take the whole panel away with no word that it would.
// Apart from RightPanel so it can be read without the panels it imports.

export function railTip(label: string, shown: boolean): string {
  return shown ? `${label} · Press again to hide the panel` : label;
}
