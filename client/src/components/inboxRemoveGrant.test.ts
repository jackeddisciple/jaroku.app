import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` | ${detail}` : ""}`);
  }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS = readFileSync(`${HERE}InboxActions.tsx`, "utf8");
const SOCKET = readFileSync(`${HERE}../lib/socket.ts`, "utf8");

const body = /case "remove_grant": \{[\s\S]*?\n {4}\}/.exec(ACTIONS)?.[0] ?? "";

console.log("\nRemove the grant removes the grant");
{
  check("the action exists to be read", body.length > 0);
  check("it never touches a tool's impact, which is workspace wide", !/sendSetMcpToolImpact/.test(body));
  check("it sends the agent and every listed tool", /sendRevokeAgentTools\(agentId, tools\)/.test(body));
  check("it reports a send that was dropped", /return sendRevokeAgentTools/.test(body));
  check("it is gated as a change to that agent", /remove_grant: "setAgentTools"/.test(ACTIONS));
  check("the wire command is the agent's own grant", /cmd: "setAgentTools", agentId, revoke: \[\.\.\.revoke\]/.test(SOCKET));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
