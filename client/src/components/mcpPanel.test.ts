import React from "react";
import { McpPanel } from "./McpPanel.tsx";
import { DISCOVERY_STALE_MS, isDiscovering, useMcpStore } from "../store/mcpStore.ts";
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
  seed(useMcpStore, { servers, discovering: {}, addingEndpoint: null, error: null, notice: null });
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
  seed(useMcpStore, { servers: [alpha, beta], discovering: {}, addingEndpoint: null, error: null, notice: null });
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

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
