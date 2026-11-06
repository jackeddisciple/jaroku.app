import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { CONFIRM_ACTIONS } from "./InboxActions.tsx";
import { ConfirmRemoveServer } from "./InboxCardActions.tsx";
import { markup, seed } from "../lib/testRender.ts";
import { useMcpStore } from "../store/mcpStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import type { InboxItemView } from "../types.ts";

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

console.log("\nthe Inbox's server credential form sets that server's credential");
{
  const CARD = readFileSync(`${HERE}InboxCardActions.tsx`, "utf8");
  const form = /function McpCredentialForm\([\s\S]*?\n\}/.exec(CARD)?.[0] ?? "";
  check("it has a form of its own", form.length > 0);
  check("it uses the same command the panel does", /sendSetMcpServerAuth\(item\.subject_id \?\? "", value\.trim\(\)\)/.test(form));
  check("it does not ask for a credential name nobody was shown", /Bearer token or API key/.test(form) && !/credential"\]/.test(form));
  check("it is not held behind the Secrets passcode, which that command does not use", !/elevated|createSecret|submitCredential/.test(form));
  check("a dropped send is said rather than reported as done", /that could not be sent/.test(form));
  check("the card routes that action to it", /primary === "set_mcp_credential"[\s\S]{0,120}<McpCredentialForm/.test(CARD));
}

console.log("\nRemove this server asks first, and says what goes with it");
{
  const CARD = readFileSync(`${HERE}InboxCardActions.tsx`, "utf8");
  check("removing a server is an action that asks first", CONFIRM_ACTIONS.has("remove_server"));
  check("the card's own button asks rather than removing", /if \(CONFIRM_ACTIONS\.has\(primary\)\) \{\s*setConfirming\(primary\);\s*return;/.test(CARD));
  check("...and so does the overflow", /if \(CONFIRM_ACTIONS\.has\(action\)\) \{\s*onConfirm\(action\);/.test(CARD));
  seed(useMcpStore, {
    servers: [{
      id: "linear", label: "Linear", endpoint: "https://mcp.linear.app/mcp", transport: "http", auth_env_key: null,
      server_name: null, server_version: null, protocol_version: null, status: "auth_required", last_error: null,
      discovered_at: null, created_at: "2026-11-07T00:00:00.000Z", configured: true, tools: [],
    }],
  });
  seed(useBuildStore, { agents: [{ agent_id: "triage", name: "triage", description: "", connectors: [], mcp_tools: ["linear/create_issue"], required_env: [], default_provider: "anthropic" }] });
  const item = { id: "i1", type: "mcp_auth_required", subject_type: "mcp_server", subject_id: "linear", subject: "Linear", payload: { server_name: "Linear" } } as unknown as InboxItemView;
  const html = markup(React.createElement(ConfirmRemoveServer, { item, onKeep: () => {} }));
  check("the question names the server", /aria-label="Remove Linear\?"/.test(html));
  check("...the agents that will lose its tools", /1 agent granted its tools \(triage\)/.test(html));
  check("...and what is deleted with it", /its stored credential/.test(html));
  check("Keep it is offered beside Remove", /Keep it/.test(html) && /Remove Linear/.test(html));
  seed(useMcpStore, { servers: [] });
  seed(useBuildStore, { agents: [] });
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
