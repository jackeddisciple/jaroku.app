import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARM_MS, askArmed } from "./McpConfirmModal.tsx";
import { useMcpStore } from "../store/mcpStore.ts";

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

console.log("\nthe tray never holds an ask the server has closed");
{
  const ask = (nonce: string, secondsAgo = 0, timeoutS = 120, skewMs = 0) => ({
    runId: "run", nonce, server: "s", tool: "t", impactReason: null, args: "{}", timeoutS,
    requestedAt: new Date(Date.now() - secondsAgo * 1000 - skewMs).toISOString(),
    serverNow: Date.now() - skewMs,
  });
  const store = useMcpStore.getState();
  store.addConfirm(ask("ghost", 10));
  store.addConfirm(ask("live", 5));
  store.reconcileConfirms(["live"]);
  check("a reconnect drops what the server no longer holds, and keeps what it does", useMcpStore.getState().confirms.map((c) => c.nonce).join() === "live");
  store.reconcileConfirms([]);
  check("a server that restarted leaves nothing behind", useMcpStore.getState().confirms.length === 0);

  store.addConfirm(ask("expired", 130));
  store.expireConfirms(Date.now());
  check("an ask well past its deadline leaves the tray", useMcpStore.getState().confirms.length === 0);
  store.addConfirm(ask("skewed", 5, 120, 10 * 60 * 1000));
  store.expireConfirms(Date.now());
  const skewed = useMcpStore.getState().confirms[0];
  check("a server ten minutes behind this machine does not expire a fresh ask", skewed?.nonce === "skewed");
  const left = (skewed?.deadlineAt ?? 0) - Date.now();
  check("...and its clock reads what the server's does", left > 110_000 && left < 120_000, String(left));
  store.reconcileConfirms([]);

  store.addConfirm(ask("answered-elsewhere", 5));
  const socket = readFileSync(`${HERE}../lib/socket.ts`, "utf8");
  check("a refused answer closes the ask it was about", /msg\.runId && msg\.nonce[\s\S]{0,120}resolveConfirm\(msg\.runId, msg\.nonce\)/.test(socket));
  check("...and tells the person on whatever tab they are on", /msg\.runId && msg\.nonce[\s\S]{0,200}showToast\(msg\.message, "err"\)/.test(socket));
  check("the socket reconciles after a replay", /confirmsReplayed"\) m\.reconcileConfirms/.test(socket));
  check("the tray's clock expires asks", /expireConfirms\(tick\)/.test(TRAY));
  store.reconcileConfirms([]);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
