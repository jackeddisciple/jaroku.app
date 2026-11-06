import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConnectForm, McpPanel, startAdd } from "./McpPanel.tsx";
import { ADD_INTERRUPTED, DISCOVERY_STALE_MS, isDiscovering, useMcpStore } from "../store/mcpStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { markup, seed, sessionAs } from "../lib/testRender.ts";
import type { McpServer, McpTool } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` | ${detail}` : ""}`);
  }
};

const tool = (name: string, patch: Partial<McpTool> = {}): McpTool => ({
  server_id: "alpha",
  name,
  description: null,
  input_schema: { type: "object", properties: {} },
  schema_hash: "h",
  impact: "low",
  computed_impact: "low",
  impact_reason: "its name begins with a read verb",
  overridden: false,
  override_voided: false,
  annotations: null,
  ...patch,
});

const server = (patch: Partial<McpServer> = {}): McpServer => ({
  id: "alpha",
  label: "Alpha",
  endpoint: "https://alpha.example/mcp",
  transport: "http",
  auth_env_key: null,
  server_name: null,
  server_version: null,
  protocol_version: null,
  status: "connected",
  last_error: null,
  discovered_at: "2026-11-07T10:00:00.000Z",
  created_at: "2026-11-07T09:00:00.000Z",
  configured: false,
  tools: [],
  ...patch,
});

const render = (servers: McpServer[], role = "admin"): string => {
  seed(useSessionStore, sessionAs(role));
  seed(useMcpStore, { servers, discovering: {}, error: null, notice: null });
  return markup(React.createElement(McpPanel));
};

console.log("\nrefused tools are said on the server, not only in a toast");
{
  const refused = "2 advertised tools were refused as unusable";
  const none = render([server({ discovery_note: refused })]);
  check("a server whose every tool was refused does not say it offered nothing", !/offered nothing to call/.test(none));
  check("...it says no tool was usable", /No usable tools/.test(none));
  check("...and why", none.includes(refused));

  const some = render([server({ tools: [tool("read_page")], discovery_note: "1 advertised tool was refused as unusable" })]);
  check("a server with some tools refused lists the rest", />read_page</.test(some));
  check("...and still says what was dropped", some.includes("1 advertised tool was refused as unusable"));

  const plain = render([server()]);
  check("a server that offered nothing still says so", /offered nothing to call/.test(plain));
  const listed = render([server({ tools: [tool("read_page")] })]);
  check("and a clean list carries no note", !/refused|truncated/.test(listed));
}

console.log("\nlast checked moves with every check, not only a successful one");
{
  const found = "2026-11-07T10:00:00.000Z";
  const checked = "2026-11-07T11:30:00.000Z";
  const failed = render([server({ status: "unreachable", discovered_at: found, checked_at: checked, tools: [tool("read_page")] })]);
  check("a failed check moves last checked", failed.includes(`last checked ${new Date(checked).toLocaleString()}`));
  check("...and says which check the tools came from", failed.includes(`tools from ${new Date(found).toLocaleString()}`));
  const healthy = render([server({ discovered_at: found, checked_at: checked, tools: [tool("read_page")] })]);
  check("a healthy server shows only when it was checked", healthy.includes(`last checked ${new Date(checked).toLocaleString()}`) && !healthy.includes("tools from"));
  const older = render([server({ discovered_at: found, tools: [tool("read_page")] })]);
  check("a row from before checks were stamped still reads its discovery time", older.includes(`last checked ${new Date(found).toLocaleString()}`));
}

console.log("\na server named after an object's own property is not stuck checking");
{
  for (const id of ["constructor", "tostring", "hasownproperty", "valueof", "isprototypeof"]) {
    check(`${id} is not being checked when nothing is`, !isDiscovering({}, id));
  }
  const held: Record<string, number> = {};
  held["constructor"] = Date.now();
  check("a server that is being checked still says so", isDiscovering(held, "constructor"));
  const row = render([server({ id: "constructor", label: "constructor" })]);
  const recheck = /<button[^>]*>(?:(?!<\/button>).)*re-check<\/button>/s.exec(row)?.[0] ?? "";
  check("its re-check button reads re-check", recheck.length > 0, row.slice(0, 200));
  check("...and can be pressed", !/disabled=""/.test(recheck), recheck);
}

console.log("\nan add in flight shows as a server connecting");
{
  const pending = render([server({ id: "pending", label: "Pending", status: "connecting", discovered_at: null })]);
  check("the reserved row has its own chip", />Pending</.test(pending));
  check("...marked as connecting", /title="connecting…"/.test(pending));
  check("...and its detail says so", /connecting…<\/span>/.test(pending));
}

console.log("\nchecking lasts until that check ends, and no longer");
{
  const store = useMcpStore.getState();
  const alpha = server();
  const beta = server({ id: "beta", label: "Beta" });
  seed(useMcpStore, { servers: [alpha, beta], discovering: {}, error: null, notice: null });
  store.setDiscovering("alpha", alpha.endpoint);
  store.setServers([alpha, beta]);
  check("a snapshot about something else does not end a check", isDiscovering(useMcpStore.getState().discovering, "alpha"));
  seed(useMcpStore, { servers: useMcpStore.getState().servers, discovering: useMcpStore.getState().discovering });
  const checking = markup(React.createElement(McpPanel));
  check("...so the button still reads checking", /checking…/.test(checking));
  store.setDiscovered("beta");
  check("the end of another server's check does not end this one", isDiscovering(useMcpStore.getState().discovering, "alpha"));
  store.setDiscovered("alpha");
  check("its own end does", !isDiscovering(useMcpStore.getState().discovering, "alpha"));

  store.setDiscovering("beta", beta.endpoint);
  store.setServers([alpha]);
  check("a server that has gone is no longer being checked", !isDiscovering(useMcpStore.getState().discovering, "beta"));

  store.setDiscovering("alpha", alpha.endpoint);
  store.forgetDiscovering();
  check("a socket that reconnects forgets checks whose end it may have missed", !isDiscovering(useMcpStore.getState().discovering, "alpha"));

  const realTimeout = globalThis.setTimeout;
  let fire: (() => void) | null = null;
  let waited = 0;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    fire = fn;
    waited = ms;
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    store.setDiscovering("alpha", alpha.endpoint);
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  check("a check whose end never arrives is given up on", waited === DISCOVERY_STALE_MS && fire !== null, String(waited));
  (fire as (() => void) | null)?.();
  check("...and then stops reading as checking", !isDiscovering(useMcpStore.getState().discovering, "alpha"));
}

console.log("\nconnecting keeps what was typed until the server answers");
{
  const store = useMcpStore.getState();
  store.clearAdd();
  const sent: unknown[][] = [];
  const offline = startAdd({ endpoint: "https://a.example/mcp", label: "", token: "" }, () => false);
  check("with the socket down nothing is begun", offline === "offline" && useMcpStore.getState().pendingAdd === null);
  const ok = startAdd({ endpoint: " https://a.example/mcp ", label: "A", token: "t" }, (...args) => (sent.push(args), true));
  const pending = useMcpStore.getState().pendingAdd;
  check("a sent add waits for its answer", ok === "sent" && pending?.state === "sending" && pending.endpoint === "https://a.example/mcp");
  check("...carrying a reference the answer can name", typeof sent[0]?.[3] === "string" && sent[0]?.[3] === pending?.ref);
  const again = startAdd({ endpoint: "https://b.example/mcp", label: "", token: "" }, (...args) => (sent.push(args), true));
  check("a second add while one is waiting is not sent", again === "busy" && sent.length === 1);
  check("an empty endpoint is not sent either", (store.clearAdd(), startAdd({ endpoint: "  ", label: "", token: "" }, () => true)) === "empty");

  startAdd({ endpoint: "https://a.example/mcp", label: "", token: "" }, () => true);
  const ref = useMcpStore.getState().pendingAdd?.ref ?? "";
  store.settleAdd("another-tab", { message: "no" });
  check("an answer to another tab's add changes nothing", useMcpStore.getState().pendingAdd?.state === "sending");
  store.settleAdd(ref, { message: "this endpoint has no scheme" });
  const refused = useMcpStore.getState().pendingAdd;
  check("a refusal keeps the add open with its reason", refused?.state === "refused" && refused.message === "this endpoint has no scheme");
  store.settleAdd(ref, { serverId: "late" });
  check("...and a later answer cannot overwrite it", useMcpStore.getState().pendingAdd?.state === "refused");

  store.clearAdd();
  startAdd({ endpoint: "https://c.example/mcp", label: "", token: "" }, () => true);
  store.settleAdd(useMcpStore.getState().pendingAdd?.ref ?? "", { serverId: "c_example" });
  const accepted = useMcpStore.getState().pendingAdd;
  check("an acceptance names the row it reserved", accepted?.state === "accepted" && accepted.serverId === "c_example");

  store.clearAdd();
  startAdd({ endpoint: "https://d.example/mcp", label: "", token: "" }, () => true);
  store.interruptAdd();
  const dropped = useMcpStore.getState().pendingAdd;
  check("a socket that drops while waiting says the outcome is unknown", dropped?.state === "refused" && dropped.message === ADD_INTERRUPTED);
  store.clearAdd();
  store.interruptAdd();
  check("...and a reconnect with nothing waiting leaves nothing behind", useMcpStore.getState().pendingAdd === null);

  seed(useMcpStore, { pendingAdd: { ref: "r", endpoint: "https://e.example/mcp", state: "sending", serverId: null, message: null } });
  const form = markup(React.createElement(ConnectForm, { onDone: () => {} }));
  check("while waiting the button reads connecting and cannot be pressed", /<button[^>]*disabled=""[^>]*>connecting\u2026<\/button>/.test(form), form.slice(0, 300));
  check("...and what was typed cannot change under it", (form.match(/readOnly=""/gi) ?? []).length === 3);
  seed(useMcpStore, { pendingAdd: null });

  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  check("the add reports whether it left the tab", /export function sendAddMcpServer\([^)]*\): boolean \{\s*return send\(/.test(socket));
  check("an accepted add is matched to the form that sent it", /type === "discovering"\) \{[\s\S]{0,160}settleAdd\(msg\.clientRef, \{ serverId: msg\.serverId \}\)/.test(socket));
  check("...and so is a refusal", /type === "error"\) \{\s*if \(msg\.clientRef\) m\.settleAdd\(msg\.clientRef, \{ message: msg\.message \}\)/.test(socket));
  check("a reconnect settles an add left waiting", /forgetDiscovering\(\);\s*useMcpStore\.getState\(\)\.interruptAdd\(\);/.test(socket));
}

console.log("\nEnter submits a form only as its button would");
{
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("no field in the panel handles Enter by itself", !/onKeyDown/.test(source));
  const form = markup(React.createElement(ConnectForm, { onDone: () => {} }));
  check("the connect form is a form", /^<div[^>]*><form/.test(form));
  check("...whose Connect is its submit button", /<button type="submit"[^>]*disabled=""[^>]*>Connect<\/button>/.test(form), form.slice(0, 400));
  check("...and submitting it goes through the guarded start", /onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*submit\(\);/.test(source) && /const started = startAdd\(/.test(source));
  check("the credential form is a form too", /onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*saveCredential\(\);/.test(source));
  check("...whose Save submits and whose Remove does not", /<button type="submit" className=\{primaryBtn\} disabled=\{!token\.trim\(\)\}>\s*Save/.test(source) && /<button type="button" className=\{quietBtn\}[\s\S]{0,120}Remove/.test(source));
  check("...and a credential the socket did not send is kept, with the reason", /if \(!sendSetMcpServerAuth\(server\.id, value\)\) \{\s*setCredentialError\(NOT_SENT\);\s*return;/.test(source));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
