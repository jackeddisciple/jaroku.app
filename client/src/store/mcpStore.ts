// The MCP store — connected MCP servers and the tools they advertise.
//
// Separate from buildStore for the reason the others are separate: a different invariant.
// Everything here describes UNREVIEWED THIRD-PARTY CODE, and the store's job is to never let
// that fact get lost on the way to a component. Reviewed connectors are a hardcoded list
// that cannot change at runtime; MCP servers appear, go unreachable, and rewrite their own
// tool lists between one snapshot and the next.
//
// Every server message on this channel is a FULL SNAPSHOT, so every reducer below is a
// replace, never a merge — the same discipline as evalStore. Merging deltas would let the
// client hold a view assembled from two different moments of what a third party said, which
// is exactly the state a confirmation prompt must never be rendered from.

import { create } from "zustand";
import type { AgentSummary, McpConfirmRequest, McpServer, McpTool } from "../types.ts";

/** A tool plus the server it came from, for the flat lists the selection UI needs. */
export interface McpToolRef extends McpTool {
  serverLabel: string;
  serverStatus: McpServer["status"];
  /** `"linear/create_issue"` — how a scoped tool is named on the wire and in a manifest. */
  ref: string;
}

export interface PendingAdd {
  ref: string;
  endpoint: string;
  state: "sending" | "refused";
  serverId: string | null;
  message: string | null;
}

export const ADD_INTERRUPTED =
  "the connection to Jaroku dropped before it answered, so the server may or may not have been added. " +
  "Check the list of servers before connecting it again.";

export interface AddFormDraft {
  endpoint: string;
  label: string;
}

export interface AwaitedServer {
  id: string;
  endpoint: string;
}

const EMPTY_DRAFT: AddFormDraft = { endpoint: "", label: "" };

interface McpState {
  servers: McpServer[];
  selectedId: string | null;
  select: (serverId: string | null) => void;
  formOpen: boolean;
  setFormOpen: (open: boolean) => void;
  draft: AddFormDraft;
  setDraft: (patch: Partial<AddFormDraft>) => void;
  tokenDropped: boolean;
  setTokenDropped: (dropped: boolean) => void;
  pendingAdd: PendingAdd | null;
  beginAdd: (ref: string, endpoint: string) => void;
  settleAdd: (ref: string, outcome: { serverId: string | null } | { message: string | null }) => void;
  interruptAdd: () => void;
  clearAdd: () => void;
  awaited: AwaitedServer | null;
  departing: { id: string; at: number } | null;
  noteDeparting: (serverId: string | null) => void;
  /** Server ids with a handshake in flight, plus null for an add that has no id yet. */
  discovering: Record<string, number>;

  /**
   * Confirmations a run is blocked on, oldest first.
   *
   * A queue rather than a single slot: a graph node can fire several tool calls in one turn,
   * and each high-impact one blocks independently. Answering them one at a time is the point
   * — a combined "approve all of these" prompt is a prompt nobody reads.
   */
  confirms: McpConfirmRequest[];
  /**
   * The ask somebody asked to see — a waiting row's "waiting on …" control sets it, and the tray
   * opens on that ask and takes focus. Null once the tray has done so.
   */
  revealNonce: string | null;

  setServers: (servers: McpServer[]) => void;
  /** Open the tray on one ask, by its nonce. */
  revealConfirm: (nonce: string | null) => void;
  addConfirm: (req: McpConfirmRequest) => void;
  resolveConfirm: (runId: string, nonce: string) => void;
  reconcileConfirms: (nonces: readonly string[]) => void;
  expireConfirms: (now: number) => void;
  setDiscovering: (serverId: string | null, endpoint: string) => void;
  setDiscovered: (serverId: string) => void;
  forgetDiscovering: () => void;
}

const CONFIRM_GRACE_MS = 5_000;
export const DISCOVERY_STALE_MS = 3 * 60_000;

function without(discovering: Record<string, number>, serverId: string): Record<string, number> {
  return Object.fromEntries(Object.entries(discovering).filter(([id]) => id !== serverId));
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  selectedId: null,
  select: (selectedId) => set((s) => ({ selectedId, awaited: s.awaited?.id === selectedId ? s.awaited : null })),
  formOpen: false,
  setFormOpen: (formOpen) => set({ formOpen }),
  draft: EMPTY_DRAFT,
  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  tokenDropped: false,
  setTokenDropped: (tokenDropped) => set({ tokenDropped }),
  pendingAdd: null,
  beginAdd: (ref, endpoint) => set({ pendingAdd: { ref, endpoint, state: "sending", serverId: null, message: null } }),
  settleAdd: (ref, outcome) =>
    set((s) =>
      s.pendingAdd?.ref !== ref || s.pendingAdd.state !== "sending"
        ? s
        : {
            ...("message" in outcome
              ? { pendingAdd: { ...s.pendingAdd, state: "refused" as const, message: outcome.message } }
              : {
                  pendingAdd: null,
                  selectedId: outcome.serverId ?? s.selectedId,
                  awaited:
                    outcome.serverId && !s.servers.some((server) => server.id === outcome.serverId)
                      ? { id: outcome.serverId, endpoint: s.pendingAdd.endpoint }
                      : null,
                  formOpen: false,
                  draft: EMPTY_DRAFT,
                  tokenDropped: false,
                }),
          },
    ),
  interruptAdd: () =>
    set((s) =>
      s.pendingAdd?.state === "sending" ? { pendingAdd: { ...s.pendingAdd, state: "refused", message: ADD_INTERRUPTED } } : s,
    ),
  clearAdd: () => set({ pendingAdd: null }),
  awaited: null,
  departing: null,
  noteDeparting: (serverId) => set({ departing: serverId === null ? null : { id: serverId, at: Date.now() } }),
  confirms: [],
  revealNonce: null,
  discovering: {},

  setServers: (servers) =>
    set((s) => {
      const live = new Set(servers.map((server) => server.id));
      return {
        servers,
        discovering: Object.fromEntries(Object.entries(s.discovering).filter(([id]) => live.has(id))),
        awaited: s.awaited && live.has(s.awaited.id) ? null : s.awaited,
      };
    }),

  setDiscovering: (serverId) => {
    if (serverId === null) return;
    const at = Date.now();
    set((s) => ({ discovering: { ...s.discovering, [serverId]: at } }));
    const stale = setTimeout(() => {
      if (isDiscovering(get().discovering, serverId) && get().discovering[serverId] === at) {
        set((s) => ({ discovering: without(s.discovering, serverId) }));
      }
    }, DISCOVERY_STALE_MS);
    (stale as { unref?: () => void }).unref?.();
  },

  setDiscovered: (serverId) =>
    set((s) => {
      const awaited = s.awaited?.id === serverId ? null : s.awaited;
      if (isDiscovering(s.discovering, serverId)) return { discovering: without(s.discovering, serverId), awaited };
      return awaited === s.awaited ? s : { awaited };
    }),

  forgetDiscovering: () =>
    set((s) => (Object.keys(s.discovering).length === 0 && s.awaited === null ? s : { discovering: {}, awaited: null })),

  addConfirm: (req) =>
    set((s) =>
      // Deduplicated by nonce: a reconnecting client re-reads what it may already hold, and
      // showing the same question twice would let one of them be answered into a void.
      s.confirms.some((c) => c.nonce === req.nonce)
        ? s
        : {
            confirms: [
              ...s.confirms,
              {
                ...req,
                deadlineAt:
                  new Date(req.requestedAt).getTime() + req.timeoutS * 1000 + (Date.now() - (req.serverNow ?? Date.now())),
              },
            ],
          },
    ),

  reconcileConfirms: (nonces) =>
    set((s) => {
      const live = new Set(nonces);
      const kept = s.confirms.filter((c) => live.has(c.nonce));
      return kept.length === s.confirms.length ? s : { confirms: kept };
    }),

  expireConfirms: (now) =>
    set((s) => {
      const kept = s.confirms.filter((c) => (c.deadlineAt ?? Number.POSITIVE_INFINITY) + CONFIRM_GRACE_MS > now);
      return kept.length === s.confirms.length ? s : { confirms: kept };
    }),

  resolveConfirm: (runId, nonce) =>
    set((s) => ({ confirms: s.confirms.filter((c) => !(c.runId === runId && c.nonce === nonce)) })),

  revealConfirm: (revealNonce) => set({ revealNonce }),

}));

// --- selectors ---------------------------------------------------------------
// Exported as pure functions so no component re-derives them differently.

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function agentsUsing(serverId: string, agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter((agent) => (agent.mcp_tools ?? []).some((ref) => ref.startsWith(`${serverId}/`)));
}

export function removalConsequences(server: McpServer, agents: readonly AgentSummary[]): string {
  const overridden = server.tools.filter((tool) => tool.overridden || tool.override_voided).length;
  const losing = [
    plural(server.tools.length, "discovered tool"),
    ...(overridden > 0 ? [`the impact you set on ${plural(overridden, "of them", "of them")}`] : []),
    ...(server.configured ? ["its stored credential"] : []),
  ];
  const lost = losing.length === 1 ? losing[0] : `${losing.slice(0, -1).join(", ")} and ${losing[losing.length - 1]}`;
  const using = agentsUsing(server.id, agents);
  const named = using.slice(0, 3).map((agent) => agent.name).join(", ") + (using.length > 3 ? ` and ${using.length - 3} more` : "");
  if (server.discovered_at === null && server.tools.length === 0) {
    return (
      `Remove ${server.label}? It never connected, so it has no tools to lose` +
      (server.configured ? ", and its stored credential is deleted with it." : ".") +
      (using.length > 0 ? ` ${plural(using.length, "agent")} granted its tools (${named}) will no longer be able to call them.` : "")
    );
  }
  return (
    `Disconnecting ${server.label} removes ${lost}. Nothing brings them back except connecting it again.` +
    (using.length > 0
      ? ` ${plural(using.length, "agent")} granted its tools (${named}) will no longer be able to call them.`
      : " No agent is granted its tools.")
  );
}

export const DEPARTURE_FOCUS_MS = 15_000;

export function hasDeparted(state: Pick<McpState, "departing" | "servers">, now: number): boolean {
  const { departing } = state;
  if (!departing || now - departing.at > DEPARTURE_FOCUS_MS) return false;
  return !state.servers.some((server) => server.id === departing.id);
}

export function awaitedServer(state: Pick<McpState, "awaited" | "selectedId" | "servers">): AwaitedServer | null {
  const { awaited } = state;
  if (!awaited || awaited.id !== state.selectedId) return null;
  return state.servers.some((server) => server.id === awaited.id) ? null : awaited;
}

export function isDiscovering(discovering: Record<string, number>, serverId: string): boolean {
  return Object.prototype.hasOwnProperty.call(discovering, serverId);
}

/** Every discovered tool across every connected server, flattened for selection. */
export function allMcpTools(servers: McpServer[]): McpToolRef[] {
  return servers.flatMap((s) =>
    s.tools.map((t) => ({ ...t, serverLabel: s.label, serverStatus: s.status, ref: `${s.id}/${t.name}` })),
  );
}

export function mcpToolSearchText(tool: McpToolRef): string {
  return `${tool.name} ${tool.serverLabel} ${tool.description ?? ""}`;
}

export function liveSelection(selected: readonly string[], servers: McpServer[]): string[] {
  const live = new Set(allMcpTools(servers).map((tool) => tool.ref));
  return selected.filter((ref) => live.has(ref));
}

export function planMcpTool(
  servers: McpServer[],
  selected: readonly string[],
  planned: { name: string; mcpServerId?: string },
): McpToolRef | undefined {
  const named = allMcpTools(servers).filter((tool) => tool.name === planned.name);
  return (
    named.find((tool) => selected.includes(tool.ref)) ??
    named.find((tool) => tool.ref === `${planned.mcpServerId}/${planned.name}`) ??
    named.find((tool) => tool.impact === "high") ??
    named[0]
  );
}

/**
 * The MCP tool names an AGENT was granted, from its own manifest refs.
 *
 * This is the join the trace and graph badges rely on. A step carries a tool NAME and
 * nothing else — the frozen Step schema has no provenance field and must not grow one — so
 * "did this come from MCP" is answered from the agent's metadata rather than from the event.
 *
 * Uses the agent's own refs rather than the live registry, which matters: an agent keeps the
 * grant it was generated with even if the server has since been disconnected, and its old
 * traces should still say where those calls went.
 */
export function agentMcpToolNames(refs: string[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const ref of refs ?? []) {
    const slash = ref.indexOf("/");
    if (slash > 0 && slash < ref.length - 1) names.add(ref.slice(slash + 1));
  }
  return names;
}
