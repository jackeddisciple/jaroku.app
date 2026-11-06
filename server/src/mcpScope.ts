import type { Manifest } from "./mcpManifest.ts";
import { withoutEndpointCredential } from "./mcpUrl.ts";
import type { McpServerView, McpToolView } from "./mcpRegistry.ts";

export const SCOPE_ENV = "JAROKU_MCP_SCOPE";

export function isConfirmNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(nonce);
}

export interface ScopedTool {
  impact: "high" | "low";
  reason?: string;
}

export interface ScopedServer {
  auth: string | null;
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

export function scopeCredentials(env: Record<string, string> | undefined): Record<string, string | null> {
  try {
    const scope = JSON.parse(env?.[SCOPE_ENV] ?? "{}") as Partial<RunScope>;
    return Object.fromEntries(Object.entries(scope.servers ?? {}).map(([id, server]) => [id, server.auth ?? null]));
  } catch {
    return {};
  }
}

export function mcpRunCredentials(
  required: readonly string[],
  granted: readonly string[],
  servers: readonly { id: string; auth_env_key: string | null }[],
): string[] {
  const grantedServers = new Set(granted.map((ref) => ref.slice(0, ref.indexOf("/"))));
  const live = servers.filter((server) => grantedServers.has(server.id) && server.auth_env_key).map((server) => server.auth_env_key as string);
  return [...new Set([...required.filter((name) => !name.startsWith("JAROKU_MCP_")), ...live])];
}

export function runScope(manifest: Manifest, granted: readonly string[], servers: readonly McpServerView[]): RunScope {
  const grant = new Set(granted);
  const live = new Map(servers.map((server) => [server.id, server]));
  const scope: RunScope = { servers: {} };
  for (const entry of manifest.servers) {
    const server = live.get(entry.id);
    if (!server || server.endpoint !== withoutEndpointCredential(entry.endpoint)) continue;
    const tools = new Map(server.tools.map((tool) => [tool.name, tool]));
    const scoped: Record<string, ScopedTool> = {};
    for (const tool of entry.tools) {
      if (grant.has(`${entry.id}/${tool.name}`)) scoped[tool.name] = scopedTool(tool, tools.get(tool.name));
    }
    if (Object.keys(scoped).length > 0) scope.servers[entry.id] = { auth: server.auth_env_key, tools: scoped };
  }
  return scope;
}
