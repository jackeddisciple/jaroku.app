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
import type { McpConfirmRequest, McpImpact, McpServer, McpTool } from "../types.ts";

/** A tool plus the server it came from, for the flat lists the selection UI needs. */
export interface McpToolRef extends McpTool {
  serverLabel: string;
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
  settleAdd: (ref: string, outcome: { serverId: string | null } | { message: string }) => void;
  interruptAdd: () => void;
  clearAdd: () => void;
  /** Server ids with a handshake in flight, plus null for an add that has no id yet. */
  discovering: Record<string, number>;
  /** The last error, shown as a dismissible strip rather than swallowed. */
  error: string | null;
  notice: string | null;

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
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

const CONFIRM_GRACE_MS = 5_000;
export const DISCOVERY_STALE_MS = 3 * 60_000;

function without(discovering: Record<string, number>, serverId: string): Record<string, number> {
  return Object.fromEntries(Object.entries(discovering).filter(([id]) => id !== serverId));
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
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
  confirms: [],
  revealNonce: null,
  discovering: {},
  error: null,
  notice: null,

  setServers: (servers) =>
    set((s) => {
      const live = new Set(servers.map((server) => server.id));
      return {
        servers,
        discovering: Object.fromEntries(Object.entries(s.discovering).filter(([id]) => live.has(id))),
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
    set((s) => (isDiscovering(s.discovering, serverId) ? { discovering: without(s.discovering, serverId) } : s)),

  forgetDiscovering: () => set((s) => (Object.keys(s.discovering).length === 0 ? s : { discovering: {} })),

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

  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
}));

// --- selectors ---------------------------------------------------------------
// Exported as pure functions so no component re-derives them differently.

export function isDiscovering(discovering: Record<string, number>, serverId: string): boolean {
  return Object.prototype.hasOwnProperty.call(discovering, serverId);
}

/** Every discovered tool across every connected server, flattened for selection. */
export function allMcpTools(servers: McpServer[]): McpToolRef[] {
  return servers.flatMap((s) =>
    s.tools.map((t) => ({ ...t, serverLabel: s.label, ref: `${s.id}/${t.name}` })),
  );
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

/** Resolve `"server/tool"` refs to tools, dropping any that no longer exist. */
export function resolveMcpRefs(servers: McpServer[], refs: string[]): McpToolRef[] {
  const byRef = new Map(allMcpTools(servers).map((t) => [t.ref, t]));
  return refs.map((r) => byRef.get(r)).filter((t): t is McpToolRef => t !== undefined);
}

/**
 * The tool names an agent could be calling through MCP, for the trace and graph badges.
 *
 * Keyed by NAME rather than ref because that is all a trace step carries: the frozen Step
 * schema has no provenance field and must not grow one, so MCP-ness is derived from agent
 * metadata joined on the tool name. Collisions across servers are possible in principle and
 * would only ever over-mark, never under-mark, which is the safe direction for a badge that
 * says "this came from unreviewed code".
 */
export function mcpToolNames(servers: McpServer[]): Set<string> {
  return new Set(allMcpTools(servers).map((t) => t.name));
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

export const IMPACT_LABEL: Record<McpImpact, string> = {
  high: "high impact",
  low: "read-only",
};
