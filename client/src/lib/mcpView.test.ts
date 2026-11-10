import { asksFirstCount, attentionSummary, endpointHint, endpointProblem, needsAttention, needsReviewCount, orderServers, typingScheme } from "./mcpView.ts";
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

const server = (id: string, patch: Partial<McpServer> = {}): McpServer => ({
  id,
  label: id,
  endpoint: `https://${id}.example/mcp`,
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

console.log("\nservers that need somebody are listed first");
{
  const healthy = server("alpha", { tools: [tool("read_page"), tool("send_message", { impact: "high", computed_impact: "high" })] });
  const down = server("beta", { status: "unreachable" });
  const locked = server("gamma", { status: "auth_required" });
  const broken = server("delta", { status: "error" });
  const stale = server("epsilon", { tools: [tool("search", { override_voided: true }), tool("read_page")] });
  const joining = server("zeta", { status: "connecting" });
  check("a connected server with nothing wrong needs nobody", !needsAttention(healthy));
  check("...nor does one still connecting", !needsAttention(joining));
  for (const s of [down, locked, broken]) check(`a server that is ${s.status} does`, needsAttention(s));
  check("...and so does one whose override no longer applies", needsAttention(stale));
  const ordered = orderServers([healthy, down, joining, stale, locked, broken]).map((s) => s.id);
  check("those come first, each group in the order it was given", ordered.join() === "beta,epsilon,gamma,delta,alpha,zeta", ordered.join());
  check("the list it was given is left as it was", orderServers([healthy, down]).length === 2 && [healthy, down][0] === healthy);
  check("one server needing attention is said in the singular", attentionSummary([healthy, down]) === "1 server needs attention");
  check("...several in the plural", attentionSummary([down, locked, healthy]) === "2 servers need attention");
  check("...and none is said as nothing", attentionSummary([healthy, joining]) === null);
  check("the tools that ask first are counted by the impact that governs", asksFirstCount(healthy) === 1 && asksFirstCount(down) === 0);
  check("...and the ones needing review by their voided overrides", needsReviewCount(stale) === 1 && needsReviewCount(healthy) === 0);
}

console.log("\nan address is checked before it is sent");
{
  check("an https address passes", endpointProblem("https://mcp.example.com/mcp") === null);
  check("...and so does a local http one", endpointProblem("  http://127.0.0.1:8931/mcp  ") === null);
  check("nothing typed is not a problem yet", endpointProblem("   ") === null);

  const bare = endpointProblem("mcp.example.com/mcp");
  check("an address with no scheme is named as one", bare !== null && /no scheme/.test(bare.message), bare?.message);
  check("...with https offered for a public host", bare?.suggestion === "https://mcp.example.com/mcp", String(bare?.suggestion));
  const local = endpointProblem("127.0.0.1:8931/mcp");
  check("...and http for this machine", local?.suggestion === "http://127.0.0.1:8931/mcp", String(local?.suggestion));
  check("...by name as well as by number", endpointProblem("localhost:8931/mcp")?.suggestion === "http://localhost:8931/mcp");

  const ftp = endpointProblem("ftp://example.com/mcp");
  check("another scheme is refused by name", ftp !== null && ftp.message.includes("ftp://") && ftp.suggestion === null, ftp?.message);
  const stdio = endpointProblem("stdio:///usr/local/bin/server");
  check("stdio is refused with its reason", stdio !== null && /someone else's program/.test(stdio.message), stdio?.message);
  check("an address with a space in it is refused", /space/.test(endpointProblem("https://exa mple.com")?.message ?? ""));
  check("every refusal says nothing was sent", [bare, local, ftp, endpointProblem("https://exa mple.com")].every((p) => /not sent/.test(p?.message ?? "")));
}

console.log("\nthe form does not interrupt somebody who is still typing");
{
  for (const typed of ["h", "ht", "http", "https", "https:", "https:/", "https://"]) {
    check(`"${typed}" is the start of a scheme`, typingScheme(typed) && endpointHint(typed) === null);
  }
  check("a single word is left alone", endpointHint("exam") === null);
  check("a host is worth a hint", endpointHint("example.com")?.suggestion === "https://example.com");
  check("...and so is a host with a port", endpointHint("localhost:8931")?.suggestion === "http://localhost:8931");
  check("a full address needs no hint", endpointHint("https://example.com/mcp") === null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
