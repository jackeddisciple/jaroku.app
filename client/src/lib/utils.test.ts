// `cn()`: what it merges, and — the half that fails silently — what it must keep.
//
//   npm run test:cn

import { readFileSync } from "node:fs";
import { cn, RADIUS_RUNGS, SHADOWS, TEXT_RUNGS } from "./utils.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\na caller's class replaces the variant's, one property at a time");
{
  check(cn("text-muted", "text-ok") === "text-ok", "the later colour wins", cn("text-muted", "text-ok"));
  check(cn("border-edge", "border-grip") === "border-grip", "and the later border colour", cn("border-edge", "border-grip"));
  check(cn("bg-active", "bg-ok/10") === "bg-ok/10", "and the later fill", cn("bg-active", "bg-ok/10"));
  check(cn("px-1.5", "px-2") === "px-2", "and the later padding", cn("px-1.5", "px-2"));
}

console.log("\nthe app's own scales are scales, not colours");
{
  // THE FAILURE THIS FILE EXISTS FOR: untaught, `text-tiny` reads as a colour and is dropped.
  const sized = cn("text-tiny text-muted", "text-ok");
  check(sized === "text-tiny text-ok", "a size survives a colour change", sized);
  check(cn("text-caption", "text-tiny") === "text-tiny", "and two sizes are one property", cn("text-caption", "text-tiny"));
  check(cn("rounded-control", "rounded-pill") === "rounded-pill", "a radius rung replaces another", cn("rounded-control", "rounded-pill"));
  check(cn("rounded-card", "border") === "rounded-card border", "and is not mistaken for anything else", cn("rounded-card", "border"));
  check(cn("shadow-floating", "shadow-overlay") === "shadow-overlay", "an elevation replaces another", cn("shadow-floating", "shadow-overlay"));
  check(cn("shadow-focusring", "text-ink") === "shadow-focusring text-ink", "and a ring is not a colour", cn("shadow-focusring", "text-ink"));
  check(cn("text-tiny", "tabular-nums", "text-faint") === "text-tiny tabular-nums text-faint", "nothing unrelated is touched");
}

console.log("\nthe scales it was taught are the ones the config declares");
{
  const config = readFileSync("tailwind.config.js", "utf8");
  const block = (name: string): string => config.match(new RegExp(`${name}: \\{[\\s\\S]*?\\n {6}\\}`))?.[0] ?? "";
  const keys = (text: string): string[] => [...text.matchAll(/^\s{8}"?([a-z-]+)"?:/gm)].map((m) => m[1]!);
  const sizes = keys(block("fontSize"));
  const radii = keys(block("borderRadius"));
  const shadows = keys(block("boxShadow"));
  check(sizes.join() === TEXT_RUNGS.join(), `the eight rungs (${sizes.join(", ")})`);
  check(RADIUS_RUNGS.every((r) => radii.includes(r)), `every taught radius exists (${radii.join(", ")})`);
  check(radii.every((r) => (RADIUS_RUNGS as readonly string[]).includes(r) || ["xs", "sm", "lg", "xl"].includes(r)),
    "and every radius the config adds is taught or is one Tailwind already knows");
  check(shadows.join() === SHADOWS.join(), `every shadow is taught (${shadows.join(", ")})`);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
