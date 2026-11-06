// Connected MCP servers: add, inspect, re-discover, remove.
//
// This panel is where the trust model becomes visible. Its organising rule is that a user
// should never be able to look at it and forget these tools came from somewhere nobody
// audited — so the rose MCP accent is on every row, "unreviewed third-party code" is stated
// in words rather than implied by a colour, and every tool shows how it was classified AND
// the argument for that classification. A verdict you cannot see the reasoning behind is not
// something anyone can meaningfully disagree with, and disagreeing is the whole point of the
// override control beside it.
//
// Structure follows DatasetBuilder: a chip strip of entities, an action row, a detail list.
// Every mutation goes over the mcp channel and comes back as a full snapshot, so there is no
// optimistic local state here — the only local state is the add form and which row is open.

import { useCallback, useEffect, useRef, useState } from "react";
import { isDiscovering, removalConsequences, useMcpStore } from "../store/mcpStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useEntitlementStore } from "../store/entitlementStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { UpsellCard } from "./UpsellCard.tsx";
import {
  sendAddMcpServer,
  sendListMcpServers,
  sendRediscoverMcpServer,
  sendRemoveMcpServer,
  sendSetMcpServerAuth,
  sendSetMcpToolImpact,
} from "../lib/socket.ts";
import { ACCENT, ICON, STATUS, TEXT } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { SecretField } from "./SecretField.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { SectionHeader } from "./SectionHeader.tsx";
import { MCP_PHASE } from "../lib/domainPhase.ts";
import { AlertTriangleIcon, EyeIcon, KeyIcon, PlugIcon, RefreshIcon, ShieldAlertIcon, ChevronDownIcon, UserCircleIcon, XIcon } from "./panelIcons.tsx";
import { useCanRun } from "../lib/useCapability.ts";
import type { McpServer, McpTool } from "../types.ts";
import { Icon } from "../lib/icons/registry.ts";

/** What each status means, in the words a user would use to decide what to do next. */
/**
 * The word beside the mark, and only the word — `MCP_PHASE` owns the shape and the colour.
 *
 * D2: `unreachable` AND `error` SHARE A GLYPH, deliberately. They are genuinely different — one is
 * usually transient and keeps its tool list, the other means the server answered with something
 * unusable — but that difference needs a sentence and not a shape, and an eighth phase for it would
 * break the rule that a shape means the same thing in every tab. This table is the sentence, and it
 * is why the label stays beside the mark rather than being folded into it.
 */
const STATUS_LABEL: Record<McpServer["status"], string> = {
  connecting: "connecting…",
  connected: "connected",
  unreachable: "unreachable",
  auth_required: "needs a credential",
  error: "error",
};

// --- one discovered tool -----------------------------------------------------

function ToolRow({ tool, serverId }: { tool: McpTool; serverId: string }) {
  // §8.2 — "MCP panel / Grant-revoke tools". The command is `setMcpToolImpact` and its capability
  // is `mcp:manage`, the admin's: raising a tool to high impact decides whether every agent in the
  // workspace has to be asked before running it, and lowering one stops the asking entirely.
  const canManage = useCanRun("setMcpToolImpact");
  const [open, setOpen] = useState(false);
  const high = tool.impact === "high";
  const Icon = high ? ShieldAlertIcon : EyeIcon;

  return (
    <div className="rounded-control px-2 py-1.5 hover:bg-active/40 transition-colors">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: high ? STATUS.pending : TEXT.muted }}>
          <Icon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-caption text-ink">{tool.name}</span>
            {high ? (
              <StatusBadge state="pending" label="high impact" icon={ShieldAlertIcon}
                title="A generated agent must ask before running this for the first time." />
            ) : (
              // The badge's default neutral icon is an ✕, which next to the word "read-only"
              // reads as a negation rather than a description. Both of these are properties
              // of the tool, so both say what they are.
              <StatusBadge state="neutral" variant="outline"
                label={tool.overridden ? "no confirmation" : "read-only"} icon={EyeIcon}
                title={tool.overridden
                  ? "You lowered this. It still does whatever it does; Jaroku just stops asking first."
                  : "Classified as information retrieval — it runs without stopping to ask."} />
            )}
            {tool.overridden && (
              <StatusBadge state="neutral" variant="outline" label="you set this"
                icon={UserCircleIcon}
                title={`Jaroku classified it ${tool.computed_impact}.`} />
            )}
            {/* A voided override is not a silent revert: the server changed the tool out
                from under a judgement that was made about a different version of it. */}
            {tool.override_voided && (
              <StatusBadge state="pending" label="your override no longer applies"
                icon={AlertTriangleIcon}
                title="This tool's schema changed since you set that, so the classification governs again." />
            )}
          </div>
          {tool.description && (
            <p className="mt-0.5 text-tiny leading-[1.5] text-muted">{tool.description}</p>
          )}
          <p className="mt-0.5 text-tiny leading-[1.5] text-faint">
            {tool.overridden ? `Jaroku said ${tool.computed_impact}: ` : ""}
            {tool.impact_reason}
          </p>

          <div className="mt-1 flex items-center gap-2">
            {/* The chevron carries open-vs-closed; the word stays because "schema" is a noun
                nobody can glyph. It was `hide schema` / `schema` — the state spelled out, which is
                the second of the two word-disclosures in this client. */}
            <button
              className={quietBtn + " !px-0 !text-tiny"}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              <span
                className={`text-faint transition-transform duration-fast ${open ? "" : "-rotate-90"}`}
                aria-hidden
              >
                <ChevronDownIcon size={ICON.xs} />
              </span>
              schema
            </button>
            {/* Both directions, always. Raising is how you gate something the heuristic read
                as harmless; lowering is how you stop being asked about a search tool.
                ABSENT FOR A MEMBER, not disabled — §8. The classification itself stays visible to
                everybody, because a member whose run halts for a confirmation has to be able to
                see why; what is admin-only is CHANGING it. */}
            {canManage && (
              <>
                <span className="text-faint">·</span>
                <button
                  className={quietBtn + " !px-0 !text-tiny"}
                  onClick={() => sendSetMcpToolImpact(serverId, tool.name, high ? "low" : "high")}
                  title={high
                    ? "Stop asking before this runs."
                    : "Ask before this runs, even though it was classified read-only."}
                >
                  {high ? "stop asking first" : "treat as high impact"}
                </button>
              </>
            )}
            {canManage && tool.overridden && (
              <>
                <span className="text-faint">·</span>
                <button
                  className={quietBtn + " !px-0 !text-tiny"}
                  onClick={() => sendSetMcpToolImpact(serverId, tool.name, null)}
                >
                  use Jaroku's classification
                </button>
              </>
            )}
          </div>

          {open && (
            <pre className="mt-1.5 overflow-x-auto rounded-control border border-hair bg-void p-2 font-mono text-tiny leading-[1.5] text-muted">
              {JSON.stringify(tool.input_schema, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// --- one server --------------------------------------------------------------

export function RemovalConfirm({ server, onKeep }: { server: McpServer; onKeep: () => void }) {
  const agents = useBuildStore((s) => s.agents);
  const [failed, setFailed] = useState(false);
  return (
    <div role="group" aria-label={`Disconnect ${server.label}?`} className="mt-2 rounded-card border border-err/40 bg-panel p-2">
      <p className="text-tiny leading-[1.5] text-ink">{removalConsequences(server, agents)}</p>
      {failed && <p role="alert" className="mt-1 text-tiny leading-[1.5] text-err">{NOT_SENT}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={secondaryBtn + " hover:!text-err"}
          onClick={() => (sendRemoveMcpServer(server.id) ? onKeep() : setFailed(true))}>
          <XIcon size={ICON.xs} />
          Disconnect {server.label}
        </button>
        <button type="button" className={quietBtn} autoFocus onClick={onKeep}>
          Keep it
        </button>
      </div>
    </div>
  );
}

export function CredentialRemovalConfirm({ server, onKeep, onRemoved }: { server: McpServer; onKeep: () => void; onRemoved: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <div role="group" aria-label="Remove the stored credential?" className="mt-2 rounded-card border border-err/40 bg-panel p-2">
      <p className="text-tiny leading-[1.5] text-ink">
        Removing the credential stored for {server.label} deletes it. Jaroku checks the server again without it, and an agent
        calling it will be refused if the server needs one.
      </p>
      {failed && <p role="alert" className="mt-1 text-tiny leading-[1.5] text-err">{NOT_SENT}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={secondaryBtn + " hover:!text-err"}
          onClick={() => (sendSetMcpServerAuth(server.id, null) ? onRemoved() : setFailed(true))}>
          Remove the credential
        </button>
        <button type="button" className={quietBtn} autoFocus onClick={onKeep}>
          Keep it
        </button>
      </div>
    </div>
  );
}

function ServerDetail({ server }: { server: McpServer }) {
  // The whole control row below is `mcp:manage`. See the row itself for why it is guarded as a
  // group rather than one button at a time.
  const canManage = useCanRun("addMcpServer");
  const discovering = useMcpStore((s) => isDiscovering(s.discovering, server.id));
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "disconnect" | "credential">(null);
  const saveCredential = () => {
    const value = token.trim();
    if (!value) return;
    if (!sendSetMcpServerAuth(server.id, value)) {
      setCredentialError(NOT_SENT);
      return;
    }
    setToken("");
    setCredentialError(null);
    setShowToken(false);
  };
  const cancelCredential = () => {
    setToken("");
    setCredentialError(null);
    setShowToken(false);
  };
  const highCount = server.tools.filter((t) => t.impact === "high").length;
  const lastChecked = server.checked_at ?? server.discovered_at;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="shrink-0 px-4 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* GLYPH THEN WORD, which is I8: a card whose only "this is unreachable" signal is a rose
              mark is unreadable to a colour-blind user and invisible in a greyscale screenshot —
              and here the word is doing more than reinforcing, because two of the four states draw
              the same shape on purpose. */}
          <span className="inline-flex items-center gap-1.5">
            <StatusGlyph phase={MCP_PHASE[server.status]} size={ICON.xs} title={STATUS_LABEL[server.status]} />
            <span className="text-tiny text-muted">{STATUS_LABEL[server.status]}</span>
          </span>
          {server.configured && (
            <StatusBadge state="neutral" variant="outline" label="credential stored" icon={KeyIcon}
              title={`Read from ${server.auth_env_key} in runtime/.env. Jaroku never displays it.`} />
          )}
          <Truncate className="text-tiny text-faint" title={server.endpoint}>{server.endpoint}</Truncate>
        </div>

        {server.server_name && (
          <p className="mt-1 text-tiny text-muted">
            Identifies itself as{" "}
            <span className="text-ink">
              {server.server_name}
              {server.server_version ? ` ${server.server_version}` : ""}
            </span>
            {server.protocol_version ? ` · MCP ${server.protocol_version}` : ""}
            {/* Everything on this line is the server's own claim about itself. */}
            <span className="text-faint"> — its own claim, unverified</span>
          </p>
        )}

        {server.last_error && (
          <p className="mt-1 max-h-28 overflow-y-auto break-words rounded-control border border-err/30 px-2 py-1.5 text-tiny leading-[1.5] text-err">
            {server.last_error}
          </p>
        )}

        {/* §8.2 — "MCP panel / Connect server / Remove server". All three of these send an
            `mcp:manage` command, so the whole row is absent for a member rather than each control
            being guarded separately: a row of controls where every one is missing is an empty flex
            container with a gap, which reads as a rendering fault. What a member keeps is the
            panel itself — which servers are connected, which tools they offer, which one is
            failing — because that is what `mcp:read` is for. */}
        {canManage && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button className={secondaryBtn} disabled={discovering || server.status === "connecting"}
              onClick={() => sendRediscoverMcpServer(server.id)}
              title="Ask the server what it can do, again. A failure keeps the tools already discovered.">
              <RefreshIcon size={ICON.xs} />
              {discovering ? "checking…" : "re-check"}
            </button>
            <button className={secondaryBtn} aria-expanded={showToken} onClick={() => setShowToken((v) => !v)}>
              <KeyIcon size={ICON.xs} />
              {server.configured ? "replace credential" : "add a credential"}
            </button>
            <button className={secondaryBtn + " ml-auto hover:!text-err"}
              aria-expanded={confirming === "disconnect"}
              onClick={() => setConfirming((v) => (v === "disconnect" ? null : "disconnect"))}>
              <XIcon size={ICON.xs} />
              disconnect
            </button>
          </div>
        )}

        {confirming === "disconnect" && <RemovalConfirm server={server} onKeep={() => setConfirming(null)} />}
        {confirming === "credential" && (
          <CredentialRemovalConfirm
            server={server}
            onKeep={() => setConfirming(null)}
            onRemoved={() => {
              setConfirming(null);
              setShowToken(false);
            }}
          />
        )}

        {showToken && (
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              saveCredential();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelCredential();
              }
            }}
            className="mt-2 rounded-card border border-edge bg-panel p-2"
          >
            <div className="flex items-center gap-2">
              <SecretField
                name="mcp-server-credential"
                aria-label={`Credential for ${server.label}`}
                className="min-w-0 flex-1 rounded-input border border-edge bg-elevated px-2 py-1 text-tiny text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
                placeholder="bearer token or API key"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="submit" className={primaryBtn} disabled={!token.trim()}>
                Save
              </button>
              {server.configured && (
                <button type="button" className={quietBtn}
                  onClick={() => setConfirming("credential")}>
                  Remove
                </button>
              )}
              <button type="button" className={quietBtn} onClick={cancelCredential}>
                Cancel
              </button>
            </div>
            {credentialError && (
              <p role="alert" className="mt-1.5 break-words text-tiny leading-[1.5] text-err">{credentialError}</p>
            )}
            {/* Saying where it goes matters more than saying it is safe. */}
            <p className="mt-1.5 text-tiny leading-[1.5] text-faint">
              Stored in <span className="font-mono">runtime/.env</span>
              {server.auth_env_key ? <> as <span className="font-mono">{server.auth_env_key}</span></> : null}
              , which is gitignored. It is never logged and never sent back to this page.
            </p>
          </form>
        )}
      </div>

      <div className="px-2 pb-4">
        {server.tools.length === 0 ? (
          <EmptyState
            size="inline"
            icon={PlugIcon}
            title={server.status !== "connected" ? "No tools discovered yet" : server.discovery_note ? "No usable tools" : "No tools advertised"}
            hint={
              server.status === "connected"
                ? server.discovery_note ?? "The handshake succeeded and this server offered nothing to call."
                : "Connect successfully to see what this server says it can do."
            }
          />
        ) : (
          <>
            <p className="px-2 py-1.5 text-tiny text-faint">
              {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
              {highCount > 0 && `, ${highCount} needing confirmation before first use`}
              {lastChecked && ` · last checked ${new Date(lastChecked).toLocaleString()}`}
              {server.status !== "connected" && server.discovered_at && lastChecked !== server.discovered_at &&
                ` · tools from ${new Date(server.discovered_at).toLocaleString()}`}
            </p>
            {server.discovery_note && (
              <p className="flex items-start gap-1.5 px-2 pb-1.5 text-tiny leading-[1.5] text-muted">
                <span className="mt-0.5 shrink-0" style={{ color: STATUS.pending }}>
                  <AlertTriangleIcon size={ICON.xs} />
                </span>
                <span className="min-w-0 break-words">{server.discovery_note}</span>
              </p>
            )}
            {server.tools.map((t) => (
              <ToolRow key={t.name} tool={t} serverId={server.id} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export const NOT_SENT =
  "Jaroku is not connected right now, so nothing was sent. What you typed is still here: press Connect again once it reconnects.";

export interface AddDraft {
  endpoint: string;
  label: string;
  token: string;
}

export type AddStart = "sent" | "busy" | "empty" | "offline";

function newAddRef(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `add-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function startAdd(draft: AddDraft, send: typeof sendAddMcpServer = sendAddMcpServer): AddStart {
  const store = useMcpStore.getState();
  if (store.pendingAdd?.state === "sending") return "busy";
  const endpoint = draft.endpoint.trim();
  if (!endpoint) return "empty";
  const ref = newAddRef();
  if (!send(endpoint, draft.label.trim() || undefined, draft.token.trim() || undefined, ref)) return "offline";
  store.beginAdd(ref, endpoint);
  return "sent";
}

export const TOKEN_DROPPED =
  "The token you had typed was cleared when you left this panel, because Jaroku does not keep a credential it has not sent. Type it again if the server needs one.";

export function ConnectForm() {
  const pendingAdd = useMcpStore((s) => s.pendingAdd);
  const sending = pendingAdd?.state === "sending";
  const { endpoint, label } = useMcpStore((s) => s.draft);
  const setDraft = useMcpStore((s) => s.setDraft);
  const tokenDropped = useMcpStore((s) => s.tokenDropped);
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const typed = useRef("");
  typed.current = token;

  useEffect(() => {
    if (pendingAdd?.state !== "refused") return;
    setFormError(pendingAdd.message);
    useMcpStore.getState().clearAdd();
  }, [pendingAdd]);

  useEffect(
    () => () => {
      if (typed.current && useMcpStore.getState().formOpen) useMcpStore.getState().setTokenDropped(true);
    },
    [],
  );

  const setEndpoint = (value: string) => setDraft({ endpoint: value });
  const setLabel = (value: string) => setDraft({ label: value });
  const cancel = () => {
    if (sending) return;
    setToken("");
    setFormError(null);
    useMcpStore.getState().setDraft({ endpoint: "", label: "" });
    useMcpStore.getState().setTokenDropped(false);
    useMcpStore.getState().setFormOpen(false);
  };

  const submit = () => {
    const started = startAdd({ endpoint, label, token });
    if (started === "offline") setFormError(NOT_SENT);
    else if (started === "sent") setFormError(null);
    if (started === "sent" && tokenDropped) useMcpStore.getState().setTokenDropped(false);
  };

  return (
    <div className="shrink-0 px-4 pb-2">
      <form
        autoComplete="off"
        aria-label="Connect an MCP server"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className="rounded-card border border-edge bg-panel p-2"
      >
        <input
          autoFocus
          name="mcp-server-endpoint"
          aria-label="Server URL"
          autoComplete="off"
          className="w-full rounded-input border border-edge bg-elevated px-2 py-1 text-tiny text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
          placeholder="https://example.com/mcp"
          value={endpoint}
          readOnly={sending}
          onChange={(e) => setEndpoint(e.target.value)}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <input
            name="mcp-server-label"
            aria-label="Name (optional)"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-input border border-edge bg-elevated px-2 py-1 text-tiny text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
            placeholder="name (optional)"
            value={label}
            readOnly={sending}
            onChange={(e) => setLabel(e.target.value)}
          />
          <SecretField
            name="mcp-server-token"
            aria-label="Token (if the server needs one)"
            className="min-w-0 flex-1 rounded-input border border-edge bg-elevated px-2 py-1 text-tiny text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
            placeholder="token (if it needs one)"
            value={token}
            readOnly={sending}
            onChange={(e) => {
              setToken(e.target.value);
              if (tokenDropped) useMcpStore.getState().setTokenDropped(false);
            }}
          />
          <button type="submit" className={primaryBtn} disabled={!endpoint.trim() || sending}>
            {sending ? "connecting…" : "Connect"}
          </button>
          <button type="button" className={quietBtn} disabled={sending} onClick={cancel}>
            Cancel
          </button>
        </div>
        {tokenDropped && (
          <p className="mt-1.5 text-tiny leading-[1.5] text-muted">{TOKEN_DROPPED}</p>
        )}
        {formError && (
          <p role="alert" className="mt-1.5 break-words text-tiny leading-[1.5] text-err">{formError}</p>
        )}
        <p className="mt-1.5 text-tiny leading-[1.5] text-faint">
          Jaroku will ask the server what it can do and show you the answer. Nothing is
          granted to any agent until you select it while planning. Only http(s) endpoints
          are supported — stdio would mean running someone else's binary on your machine.
        </p>
      </form>
    </div>
  );
}

// --- the panel ---------------------------------------------------------------

export function McpPanel() {
  const canManage = useCanRun("addMcpServer");
  const servers = useMcpStore((s) => s.servers);

  const selectedId = useMcpStore((s) => s.selectedId);
  const setSelectedId = useMcpStore((s) => s.select);
  const adding = useMcpStore((s) => s.formOpen);
  const toggleForm = useCallback(() => useMcpStore.getState().setFormOpen(!useMcpStore.getState().formOpen), []);
  const workspaceId = useSessionStore((s) => s.workspaceId) ?? "";
  const strip = useRef<HTMLDivElement>(null);
  const atLimit = useEntitlementStore((s) => s.channel === "mcp" && s.refusal !== null);
  const openBilling = useUiStore((s) => s.openWorkspacePanel);

  useEffect(() => sendListMcpServers(), []);

  // Keep the selection if it still exists, else fall back to the first — the same idiom as
  // evalStore's dataset selection and buildStore's agent selection.
  const selected = servers.find((s) => s.id === selectedId) ?? servers[0] ?? null;
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId, setSelectedId]);
  useEffect(() => {
    if (!selected) return;
    strip.current?.querySelector(`[data-mcp-server="${selected.id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected?.id]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The standing reminder. It is worth the two lines it costs: everything below this
          came from code that was never reviewed, and that is easy to forget once a tool list
          looks as tidy as a connector list. */}
      <div className="shrink-0 px-4 pt-2">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0" style={{ color: ACCENT.mcp }}>
            <PlugIcon size={ICON.sm} />
          </span>
          <p className="text-tiny leading-[1.5] text-muted">
            <span className="text-ink">MCP servers are third-party code Jaroku has not reviewed.</span>{" "}
            What a server says it can do is its own claim. Tools from here are marked
            everywhere they appear, an agent only receives the ones its plan asked for, and a
            high-impact one stops for your confirmation before it runs.
          </p>
        </div>
      </div>

      {/* Server chips */}
      <div className="flex shrink-0 items-center gap-1 border-b border-hair px-4 py-2">
        {/* IN THE STRIP RATHER THAN OVER IT, because the strip scrolls sideways and a header above
            it would be a second row of chrome on a panel whose whole shape is one dense bar. The
            list is never paginated — `listMcpServers` answers with all of them — so the length is
            a total. */}
        <SectionHeader name="Servers" count={servers.length} className="mr-1 shrink-0" />
        <div ref={strip} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {servers.map((s) => (
            <span key={s.id} data-mcp-server={s.id} className="shrink-0">
              <Chip
                size="lg"
                onClick={() => setSelectedId(s.id)}
                selected={selected?.id === s.id}
                current={selected?.id === s.id}
                className="max-w-[220px] shrink-0"
                figure={s.tools.length}
                icon={
                  <StatusGlyph phase={MCP_PHASE[s.status]} size={ICON.xs} title={STATUS_LABEL[s.status]} />
                }
              >
                <Truncate title={s.label}>{s.label}</Truncate>
              </Chip>
            </span>
          ))}
        </div>
        {/* §8.2 — "MCP panel / Connect server / connector:manage". The command is `addMcpServer`
            and its capability is `mcp:manage`: connecting a third-party server points every agent
            in this workspace at code nobody here has reviewed, which is the definition of
            committing the workspace to something outside itself. */}
        {canManage && (
          <button className={quietBtn + " shrink-0 inline-flex items-center gap-1"}
            aria-expanded={adding}
            onClick={toggleForm}>
            <Icon.mcp.connectServer size={ICON.xs} />
            Connect a server
          </button>
        )}
      </div>

      {atLimit && (
        <div className="shrink-0 px-4 pb-2">
          <UpsellCard channel="mcp" onUpgrade={() => openBilling("billing")} />
        </div>
      )}

      {canManage && adding && <ConnectForm key={workspaceId} />}

      {servers.length === 0 ? (
        <EmptyState
          icon={PlugIcon}
          title="No MCP servers connected"
          hint="Connecting one discovers the tools it offers, so you can give an agent the specific ones it needs — and nothing else."
        />
      ) : selected ? (
        <ServerDetail key={`${workspaceId}:${selected.id}`} server={selected} />
      ) : null}
    </div>
  );
}
