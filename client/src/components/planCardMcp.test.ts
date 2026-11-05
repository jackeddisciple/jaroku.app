import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planMcpTool } from "../store/mcpStore.ts";
import type { McpServer, McpTool } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` | ${detail}` : ""}`);
  }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CARD = readFileSync(`${HERE}PlanCard.tsx`, "utf8");

const tool = (name: string, impact: "high" | "low"): McpTool =>
  ({ name, impact, impact_reason: `${impact} because`, description: null, input_schema: {}, schema_hash: "h", computed_impact: impact, overridden: false, override_voided: false, annotations: null, server_id: "x" }) as unknown as McpTool;
const server = (id: string, label: string, tools: McpTool[]): McpServer => ({ id, label, tools }) as unknown as McpServer;

const servers = [
  server("alpha", "Alpha", [tool("send_message", "high"), tool("read_page", "low")]),
  server("zeta", "Zeta", [tool("send_message", "low"), tool("read_page", "low")]),
];

console.log("\nthe plan card describes the tool that was selected");
{
  const selected = ["alpha/send_message", "alpha/read_page"];
  const known = planMcpTool(servers, selected, { name: "send_message" });
  check("it names the selected server, not the last one holding that name", known?.serverLabel === "Alpha", String(known?.serverLabel));
  check("and shows that server's gate", known?.impact === "high", String(known?.impact));
  const other = planMcpTool(servers, ["zeta/send_message"], { name: "send_message" });
  check("the other selection gets the other answer", other?.serverLabel === "Zeta" && other?.impact === "low");
  const declared = planMcpTool(servers, [], { name: "send_message", mcpServerId: "zeta" });
  check("a server the plan named is honoured when nothing was selected", declared?.serverLabel === "Zeta", String(declared?.serverLabel));
  const worst = planMcpTool(servers, [], { name: "send_message" });
  check("with nothing to go on the card assumes the higher impact", worst?.impact === "high", String(worst?.impact));
  check("the card uses it", /planMcpTool\(mcpServers, turn\.mcpRefs \?\? \[\], t\)/.test(CARD));
  check("and no longer keys tools by name", !/allMcpTools\(mcpServers\)\.map\(\(t\) => \[t\.name, t\]/.test(CARD));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
