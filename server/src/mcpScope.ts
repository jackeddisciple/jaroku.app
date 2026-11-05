import type { Manifest } from "./mcpManifest.ts";
import type { McpServerView, McpToolView } from "./mcpRegistry.ts";

export const SCOPE_ENV = "JAROKU_MCP_SCOPE";

export interface ScopedTool {
  impact: "high" | "low";
  reason?: string;
}

export interface ScopedServer {
  tools: Record<string, ScopedTool>;
}

export interface RunScope {
  servers: Record<string, ScopedServer>;
}

function scopedTool(frozen: { impact: "high" | "low" }, live: McpToolView | undefined): ScopedTool {
  if (!live) return { impact: frozen.impact };
  if (live.overridden) {
    return live.impact === "high"
      ? { impact: "high", reason: "you marked it high impact" }
      : { impact: "low" };
  }
  if (live.computed_impact === "high" && frozen.impact !== "high") {
    return { impact: "high", reason: live.impact_reason };
  }
  return { impact: frozen.impact };
}

export function runScope(manifest: Manifest, servers: readonly McpServerView[]): RunScope {
  const live = new Map(servers.map((server) => [server.id, server]));
  const scope: RunScope = { servers: {} };
  for (const entry of manifest.servers) {
    const tools = new Map((live.get(entry.id)?.tools ?? []).map((tool) => [tool.name, tool]));
    const scoped: Record<string, ScopedTool> = {};
    for (const tool of entry.tools) scoped[tool.name] = scopedTool(tool, tools.get(tool.name));
    scope.servers[entry.id] = { tools: scoped };
  }
  return scope;
}
