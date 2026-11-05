import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARM_MS, askArmed } from "./McpConfirmModal.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` | ${detail}` : ""}`);
  }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRAY = readFileSync(`${HERE}McpConfirmModal.tsx`, "utf8");
const APP = readFileSync(`${HERE}../App.tsx`, "utf8");

console.log("\nthe tray exists wherever a run can be waiting");
{
  const onboarding = /if \(onboardingNeeded\) return \([\s\S]*?\);/.exec(APP)?.[0] ?? "";
  check("the onboarding screen renders", /<AccountOnboarding \/>/.test(onboarding));
  check("...with the tray mounted beside it", /\{confirmTray\}/.test(onboarding));
}

console.log("\nan ask is not armed the moment it moves under the cursor");
{
  const shown = 10_000;
  check("a long waiting ask that has just taken the slot is not armed", !askArmed(shown + 60_000, shown, shown + 60_000 - 150));
  check("...nor just under the arming time", !askArmed(shown + 60_000, shown, shown + 60_000 - (ARM_MS - 1)));
  check("...and is once that time has passed", askArmed(shown + 60_000, shown, shown + 60_000 - ARM_MS));
  check("a brand new ask is not armed", !askArmed(shown + 100, shown, shown));
  check("the clock measures from whichever came later", askArmed(shown + ARM_MS, shown, shown));
  check("the tray measures an ask from when it took the slot", /movedAt/.test(TRAY) && /askArmed\(now, shownAt\.current\.get\(request\.nonce\) \?\? now, movedAt\.current\.at\)/.test(TRAY));
  check("an ask the tray has not seen yet is never armed", /\?\? now/.test(TRAY));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
