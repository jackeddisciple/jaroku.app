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
// Structure follows DatasetBuilder: a picker of entities, an action row, a detail list.
// Every mutation goes over the mcp channel and comes back as a full snapshot, so there is no
// optimistic local state here — the only local state is the add form and which row is open.

import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { awaitedServer, hasDeparted, isDiscovering, removalConsequences, useMcpStore } from "../store/mcpStore.ts";
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
  sendUpdateMcpServer,
} from "../lib/socket.ts";
import { ACCENT, ICON, STATUS, TEXT } from "../lib/tokens.ts";
import { SecretField } from "./SecretField.tsx";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { buttonVariants } from "./ui/button.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { SectionHeader } from "./SectionHeader.tsx";
import { MCP_PHASE } from "../lib/domainPhase.ts";
import { AlertTriangleIcon, EyeIcon, KebabIcon, KeyIcon, PencilIcon, PlugIcon, RefreshIcon, ShieldAlertIcon, ChevronDownIcon, UserCircleIcon, XIcon } from "./panelIcons.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { useCanRun } from "../lib/useCapability.ts";
import { moreToolsLabel, useToolWindow } from "../lib/toolWindow.ts";
import { STATUS_LABEL, attentionSummary, endpointHint, endpointHost, endpointProblem, nextStep, orderServers } from "../lib/mcpView.ts";
import { McpServerPicker } from "./McpServerPicker.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
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
export const PRESSED_OPEN = "aria-expanded:bg-active aria-expanded:text-ink";

export const FIELD =
  "h-8 w-full rounded-input border border-edge bg-elevated px-2.5 py-1.5 text-caption text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint read-only:text-muted";

export const FIELD_MONO = `${FIELD} font-mono`;

export const controlBtn = `${secondaryBtn} min-h-6 ${PRESSED_OPEN}`;

export const nextBtn =
  "inline-flex min-h-6 items-center gap-1.5 rounded-control px-2.5 py-1 text-tiny bg-ink text-bg hover:bg-ink/90 active:bg-ink/80 aria-expanded:bg-ink/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

export const SCHEMA_DISPLAY_CHARS = 20_000;
export const SCHEMA_SHORTENED = "… shortened for display: this schema is longer than the panel shows";

export function schemaText(schema: unknown): string {
  const pretty = JSON.stringify(schema, null, 2) ?? "";
  if (pretty.length <= SCHEMA_DISPLAY_CHARS) return pretty;
  const compact = JSON.stringify(schema) ?? "";
  if (compact.length <= SCHEMA_DISPLAY_CHARS) return compact;
  return `${compact.slice(0, SCHEMA_DISPLAY_CHARS)}\n${SCHEMA_SHORTENED}`;
}

export { STATUS_LABEL };

// --- one discovered tool -----------------------------------------------------

function ToolRowView({ tool, serverId }: { tool: McpTool; serverId: string }) {
  // §8.2 — "MCP panel / Grant-revoke tools". The command is `setMcpToolImpact` and its capability
  // is `mcp:manage`, the admin's: raising a tool to high impact decides whether every agent in the
  // workspace has to be asked before running it, and lowering one stops the asking entirely.
  const canManage = useCanRun("setMcpToolImpact");
  const [open, setOpen] = useState(false);
  const [unsent, setUnsent] = useState<string | null>(null);
  const high = tool.impact === "high";
  const setImpact = (impact: McpTool["impact"] | null, control: string) =>
    setUnsent(sendSetMcpToolImpact(serverId, tool.name, impact) ? null : notSent(control));
  const Icon = high ? ShieldAlertIcon : EyeIcon;

  return (
    <div className="rounded-control px-2 py-1.5 hover:bg-active/40 transition-colors">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: high ? STATUS.pending : TEXT.muted }}>
          <Icon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="min-w-0 text-caption text-ink [overflow-wrap:anywhere]">{tool.name}</span>
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
            <p className="mt-0.5 text-tiny leading-[1.5] text-muted [overflow-wrap:anywhere]">{tool.description}</p>
          )}
          <p className="mt-0.5 text-tiny leading-[1.5] text-muted">
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
                  onClick={() => setImpact(high ? "low" : "high", high ? "stop asking first" : "treat as high impact")}
                  title={high
                    ? "Stop asking before this runs."
                    : "Ask before this runs, even though it was classified read-only."}
                >
                  {high ? "stop asking first" : "treat as high impact"}
                </button>
              </>
            )}
            {canManage && (tool.overridden || tool.override_voided) && (
              <>
                <span className="text-faint">·</span>
                <button
                  className={quietBtn + " !px-0 !text-tiny"}
                  onClick={() => setImpact(null, tool.override_voided ? "clear my old setting" : "use Jaroku's classification")}
                >
                  {tool.override_voided ? "clear my old setting" : "use Jaroku's classification"}
                </button>
              </>
            )}
          </div>

          {unsent && <p role="alert" className="mt-1 text-tiny leading-[1.5] text-err">{unsent}</p>}

          {open && (
            <pre className="mt-1.5 max-h-80 overflow-auto rounded-control border border-hair bg-void p-2 font-mono text-tiny leading-[1.5] text-muted">
              {schemaText(tool.input_schema)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function sameToolRow(a: { tool: McpTool; serverId: string }, b: { tool: McpTool; serverId: string }): boolean {
  if (a.serverId !== b.serverId) return false;
  const x = a.tool;
  const y = b.tool;
  return (
    x === y ||
    (x.name === y.name &&
      x.schema_hash === y.schema_hash &&
      x.impact === y.impact &&
      x.computed_impact === y.computed_impact &&
      x.overridden === y.overridden &&
      x.override_voided === y.override_voided &&
      x.description === y.description &&
      x.impact_reason === y.impact_reason)
  );
}

const ToolRow = memo(ToolRowView, sameToolRow);

const toolText = (tool: McpTool): string => `${tool.name} ${tool.description ?? ""}`;

export function ToolList({ server }: { server: McpServer }) {
  const tools = useToolWindow(server.tools, toolText);
  return (
    <>
      {tools.filterable && (
        <div className="px-2 pb-1.5">
          <input
            type="search"
            name="mcp-tool-filter"
            value={tools.query}
            onChange={(e) => tools.search(e.target.value)}
            placeholder="Find a tool by name or description"
            aria-label={`Find a tool on ${server.label}`}
            autoComplete="off"
            spellCheck={false}
            className="h-6 w-full rounded-input border border-hair bg-elevated px-2 text-tiny text-ink outline-none placeholder:text-faint focus-visible:shadow-focusring"
          />
        </div>
      )}
      {tools.visible.map((t) => (
        <ToolRow key={t.name} tool={t} serverId={server.id} />
      ))}
      {tools.query.trim() !== "" && tools.matched === 0 && (
        <p className="px-2 py-1.5 text-tiny text-muted">No tool on {server.label} matches that.</p>
      )}
      {tools.remaining > 0 && (
        <div className="px-2 pt-1">
          <button type="button" className={controlBtn} onClick={tools.more}>
            {moreToolsLabel(tools.remaining)}
          </button>
        </div>
      )}
    </>
  );
}

// --- one server --------------------------------------------------------------

export const ENDPOINT_SETTLED =
  "This server has connected, so its endpoint stays as it is: agents were granted its tools at that address. Disconnect it and connect a new one to move.";

function FieldLabel({ htmlFor, first = false, children }: { htmlFor: string; first?: boolean; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className={`${first ? "" : "mt-1.5 "}mb-1 block text-tiny text-muted`}>
      {children}
    </label>
  );
}

export function EditServerForm({ server, onDone }: { server: McpServer; onDone: () => void }) {
  const fixed = server.discovered_at !== null || server.status === "connecting";
  const [label, setLabel] = useState(server.label);
  const [endpoint, setEndpoint] = useState(server.endpoint);
  const [failed, setFailed] = useState<string | null>(null);
  const fieldId = useId();
  const save = () => {
    const patch = {
      ...(label.trim() && label.trim() !== server.label ? { label: label.trim() } : {}),
      ...(!fixed && endpoint.trim() && endpoint.trim() !== server.endpoint ? { endpoint: endpoint.trim() } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    if (!sendUpdateMcpServer(server.id, patch)) {
      setFailed(notSent("Save", true));
      return;
    }
    onDone();
  };
  return (
    <form
      autoComplete="off"
      aria-label={`Edit ${server.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
      className="mt-2 rounded-card border border-edge bg-panel p-2"
    >
      <FieldLabel htmlFor={`${fieldId}-label`} first>Name</FieldLabel>
      <input
        id={`${fieldId}-label`}
        name="mcp-server-edit-label"
        aria-label="Name"
        autoComplete="off"
        maxLength={MCP_LABEL_MAX}
        className={FIELD}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <FieldLabel htmlFor={`${fieldId}-endpoint`}>Server URL</FieldLabel>
      <input
        id={`${fieldId}-endpoint`}
        name="mcp-server-edit-endpoint"
        aria-label="Server URL"
        autoComplete="off"
        readOnly={fixed}
        className={FIELD_MONO}
        placeholder="https://example.com/mcp"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
      />
      {fixed && server.discovered_at !== null && <p className="mt-1.5 text-tiny leading-[1.5] text-muted">{ENDPOINT_SETTLED}</p>}
      {failed && <p role="alert" className="mt-1.5 text-tiny leading-[1.5] text-err">{failed}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" className={primaryBtn} disabled={!label.trim()}>
          Save
        </button>
        <button type="button" className={quietBtn} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RemovalConfirm({ server, onKeep }: { server: McpServer; onKeep: () => void }) {
  const agents = useBuildStore((s) => s.agents);
  const [failed, setFailed] = useState(false);
  return (
    <div role="group" aria-label={`Disconnect ${server.label}?`} className="mt-2 rounded-card border border-err/40 bg-panel p-2">
      <p className="text-tiny leading-[1.5] text-ink">{removalConsequences(server, agents)}</p>
      {failed && <p role="alert" className="mt-1 text-tiny leading-[1.5] text-err">{notSent(`Disconnect ${server.label}`)}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={controlBtn + " hover:!text-err"}
          onClick={() => {
            if (!sendRemoveMcpServer(server.id)) {
              setFailed(true);
              return;
            }
            useMcpStore.getState().noteDeparting(server.id);
            onKeep();
          }}>
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
      {failed && <p role="alert" className="mt-1 text-tiny leading-[1.5] text-err">{notSent("Remove the credential")}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={controlBtn + " hover:!text-err"}
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

export function storedCredentialTitle(server: Pick<McpServer, "auth_env_key" | "credential_store">): string {
  if (server.credential_store === "dotenv") return `Read from ${server.auth_env_key} in runtime/.env. Jaroku never displays it.`;
  if (server.credential_store === "kms") return "Kept encrypted for this workspace alone. Jaroku never displays it.";
  return "Kept for this workspace alone. Jaroku never displays it.";
}

export function CredentialHome({ server }: { server: Pick<McpServer, "auth_env_key" | "credential_store"> }) {
  if (server.credential_store === "dotenv") {
    return (
      <>
        Stored in <span className="font-mono">runtime/.env</span>
        {server.auth_env_key ? <> as <span className="font-mono">{server.auth_env_key}</span></> : null}
        , which is gitignored.
      </>
    );
  }
  return <>{server.credential_store === "kms" ? "Kept encrypted for this workspace alone." : "Kept for this workspace alone."}</>;
}

export type DetailForm = "credential" | "edit" | "disconnect" | "credential-removal";

export function toggledForm(current: DetailForm | null, pressed: DetailForm): DetailForm | null {
  return current === pressed ? null : pressed;
}

function ServerDetail({ server }: { server: McpServer }) {
  // The whole control row below is `mcp:manage`. See the row itself for why it is guarded as a
  // group rather than one button at a time.
  const canManage = useCanRun("addMcpServer");
  const discovering = useMcpStore((s) => isDiscovering(s.discovering, server.id));
  const [token, setToken] = useState("");
  const [open, setOpen] = useState<DetailForm | null>(null);
  const toggle = (form: DetailForm) => setOpen((current) => toggledForm(current, form));
  const handingFocus = useRef(false);
  const fieldId = useId();
  const openFromMenu = (form: DetailForm) => {
    handingFocus.current = open !== form;
    toggle(form);
  };
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [checkUnsent, setCheckUnsent] = useState(false);
  useEffect(() => {
    if (open === "credential" || open === "credential-removal") return;
    setToken("");
    setCredentialError(null);
  }, [open]);
  const saveCredential = () => {
    const value = token.trim();
    if (!value) return;
    if (!sendSetMcpServerAuth(server.id, value)) {
      setCredentialError(notSent("Save", true));
      return;
    }
    setToken("");
    setCredentialError(null);
    setOpen(null);
  };
  const cancelCredential = () => {
    setToken("");
    setCredentialError(null);
    setOpen(null);
  };
  const highCount = server.tools.filter((t) => t.impact === "high").length;
  const lastChecked = server.checked_at ?? server.discovered_at;
  const step = nextStep(server);
  const recheckControl = (
    <button key="recheck" data-mcp-next={step === "recheck" ? "recheck" : undefined}
      className={step === "recheck" ? nextBtn : controlBtn} disabled={discovering || server.status === "connecting"}
      onClick={() => setCheckUnsent(!sendRediscoverMcpServer(server.id))}
      title="Ask the server what it can do, again. A failure keeps the tools already discovered.">
      <RefreshIcon size={ICON.xs} />
      {discovering ? "checking…" : "re-check"}
    </button>
  );
  const credentialControl = (
    <button key="credential" data-mcp-next={step === "credential" ? "credential" : undefined}
      className={step === "credential" ? nextBtn : controlBtn} aria-expanded={open === "credential"} onClick={() => toggle("credential")}>
      <KeyIcon size={ICON.xs} />
      {server.configured ? "replace credential" : "add a credential"}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="shrink-0 px-4 py-2">
        <div className="flex items-start gap-2">
          <h2 data-mcp-server-title className="min-w-0 flex-1 text-label font-medium text-ink [overflow-wrap:anywhere]">{server.label}</h2>
          {/* GLYPH THEN WORD, which is I8: a card whose only "this is unreachable" signal is a rose
              mark is unreadable to a colour-blind user and invisible in a greyscale screenshot —
              and here the word is doing more than reinforcing, because two of the four states draw
              the same shape on purpose. */}
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5">
            <StatusGlyph phase={MCP_PHASE[server.status]} size={ICON.xs} title={STATUS_LABEL[server.status]} />
            <span className="text-tiny text-muted">{STATUS_LABEL[server.status]}</span>
          </span>
        </div>
        <p data-mcp-endpoint className="mt-0.5 font-mono text-tiny leading-[1.5] text-muted [overflow-wrap:anywhere]">{server.endpoint}</p>
        {server.configured && (
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <StatusBadge state="neutral" variant="outline" label="credential stored" icon={KeyIcon}
              title={storedCredentialTitle(server)} />
          </div>
        )}

        {server.server_name && (
          <p className="mt-1 text-tiny text-muted [overflow-wrap:anywhere]">
            Identifies itself as{" "}
            <span className="text-ink">
              {server.server_name}
              {server.server_version ? ` ${server.server_version}` : ""}
            </span>
            {server.protocol_version ? ` · MCP ${server.protocol_version}` : ""}
            {/* Everything on this line is the server's own claim about itself. */}
            <span className="text-muted"> — its own claim, unverified</span>
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
          <div className="mt-2 flex items-center gap-2">
            {step === "address" && (
              <button data-mcp-next="address" className={nextBtn} aria-expanded={open === "edit"} onClick={() => toggle("edit")}>
                <PencilIcon size={ICON.xs} />
                fix the address
              </button>
            )}
            {step === "credential" ? [credentialControl, recheckControl] : [recheckControl, credentialControl]}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-mcp-more
                  aria-label={`More for ${server.label}`}
                  title="Edit or disconnect"
                  className={`${controlBtn} ml-auto !px-1.5`}
                >
                  <KebabIcon size={ICON.xs} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                aria-label={`More for ${server.label}`}
                onCloseAutoFocus={(e) => {
                  if (!handingFocus.current) return;
                  handingFocus.current = false;
                  e.preventDefault();
                }}
              >
                <DropdownMenuItem size="compact" onSelect={() => openFromMenu("edit")}>
                  <PencilIcon size={ICON.xs} />
                  edit
                </DropdownMenuItem>
                <DropdownMenuItem size="compact" tone="danger" onSelect={() => openFromMenu("disconnect")}>
                  <XIcon size={ICON.xs} />
                  disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {checkUnsent && <p role="alert" className="mt-1.5 text-tiny leading-[1.5] text-err">{notSent("re-check")}</p>}

        {open === "edit" && <EditServerForm server={server} onDone={() => setOpen(null)} />}
        {open === "disconnect" && <RemovalConfirm server={server} onKeep={() => setOpen(null)} />}
        {open === "credential-removal" && (
          <CredentialRemovalConfirm server={server} onKeep={() => setOpen("credential")} onRemoved={() => setOpen(null)} />
        )}

        {open === "credential" && (
          <form
            autoComplete="off"
            aria-label={`Credential for ${server.label}`}
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
            <FieldLabel htmlFor={`${fieldId}-credential`} first>Credential</FieldLabel>
            <SecretField
              id={`${fieldId}-credential`}
              name="mcp-server-credential"
              aria-label={`Credential for ${server.label}`}
              className={FIELD_MONO}
              placeholder="bearer token or API key"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            {credentialError && (
              <p role="alert" className="mt-1.5 break-words text-tiny leading-[1.5] text-err">{credentialError}</p>
            )}
            <div data-mcp-form-actions className="mt-2 flex items-center gap-2">
              <button type="submit" className={primaryBtn} disabled={!token.trim()}>
                Save
              </button>
              {server.configured && (
                <button type="button" className={quietBtn}
                  onClick={() => setOpen("credential-removal")}>
                  Remove
                </button>
              )}
              <button type="button" className={quietBtn} onClick={cancelCredential}>
                Cancel
              </button>
            </div>
            {/* Saying where it goes matters more than saying it is safe. */}
            <p className="mt-1.5 text-tiny leading-[1.5] text-faint">
              <CredentialHome server={server} /> It is never logged and never sent back to this page.
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
            <p className="px-2 py-1.5 text-tiny text-muted">
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
            <ToolList server={server} />
          </>
        )}
      </div>
    </div>
  );
}

export function notSent(control: string, typed = false): string {
  return typed
    ? `Jaroku is not connected right now, so nothing was sent. What you typed is still here: press ${control} again once it reconnects.`
    : `Jaroku is not connected right now, so nothing was sent. Press ${control} again once it reconnects.`;
}

export const NOT_SENT = notSent("Connect", true);

export interface AddDraft {
  endpoint: string;
  label: string;
  token: string;
}

export type AddStart = "sent" | "busy" | "empty" | "invalid" | "offline";

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
  if (endpointProblem(endpoint)) return "invalid";
  const ref = newAddRef();
  if (!send(endpoint, draft.label.trim() || undefined, draft.token.trim() || undefined, ref)) return "offline";
  store.beginAdd(ref, endpoint);
  return "sent";
}

export const MCP_LABEL_MAX = 80;

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
  const [attempted, setAttempted] = useState(false);
  const fieldId = useId();
  const problem = attempted ? endpointProblem(endpoint) : endpointHint(endpoint);
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
    setAttempted(started === "invalid");
    if (started === "offline") setFormError(NOT_SENT);
    else if (started === "sent" || started === "invalid") setFormError(null);
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
        <FieldLabel htmlFor={`${fieldId}-endpoint`} first>Server URL</FieldLabel>
        <input
          autoFocus
          id={`${fieldId}-endpoint`}
          name="mcp-server-endpoint"
          aria-label="Server URL"
          autoComplete="off"
          className={FIELD_MONO}
          placeholder="https://example.com/mcp"
          value={endpoint}
          readOnly={sending}
          aria-invalid={problem !== null}
          onChange={(e) => setEndpoint(e.target.value)}
        />
        {problem && (
          <p role={attempted ? "alert" : "status"} data-mcp-endpoint-problem className="mt-1.5 break-words text-tiny leading-[1.5] text-err">
            {problem.message}
            {problem.suggestion && (
              <>
                {" "}
                <button
                  type="button"
                  className="rounded-control text-ink underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-focusring"
                  onClick={() => {
                    setEndpoint(problem.suggestion ?? endpoint);
                    setAttempted(false);
                  }}
                >
                  Use {problem.suggestion}
                </button>
              </>
            )}
          </p>
        )}
        <FieldLabel htmlFor={`${fieldId}-label`}>Name (optional)</FieldLabel>
        <input
          id={`${fieldId}-label`}
          name="mcp-server-label"
          aria-label="Name (optional)"
          autoComplete="off"
          maxLength={MCP_LABEL_MAX}
          className={FIELD}
          value={label}
          readOnly={sending}
          onChange={(e) => setLabel(e.target.value)}
        />
        <FieldLabel htmlFor={`${fieldId}-token`}>Token, if the server needs one</FieldLabel>
        <SecretField
          id={`${fieldId}-token`}
          name="mcp-server-token"
          aria-label="Token (if the server needs one)"
          className={FIELD_MONO}
          value={token}
          readOnly={sending}
          onChange={(e) => {
            setToken(e.target.value);
            if (tokenDropped) useMcpStore.getState().setTokenDropped(false);
          }}
        />
        {tokenDropped && (
          <p className="mt-1.5 text-tiny leading-[1.5] text-muted">{TOKEN_DROPPED}</p>
        )}
        {formError && (
          <p role="alert" className="mt-1.5 break-words text-tiny leading-[1.5] text-err">{formError}</p>
        )}
        <div data-mcp-form-actions className="mt-2 flex items-center gap-2">
          <button type="submit" className={`${primaryBtn} h-8`} disabled={!endpoint.trim() || sending}>
            {sending ? "connecting…" : "Connect"}
          </button>
          <button type="button" className={`${quietBtn} h-8`} disabled={sending} onClick={cancel}>
            Cancel
          </button>
        </div>
        <p className="mt-1.5 text-tiny leading-[1.5] text-faint">
          Jaroku will ask the server what it can do and show you the answer. Nothing is
          granted to any agent until you select it while planning, or on an agent's
          Capabilities tab. Only http(s) endpoints
          are supported — stdio would mean running someone else's binary on your machine.
        </p>
      </form>
    </div>
  );
}

// --- the panel ---------------------------------------------------------------

export const MCP_EMPTY_ADMIN =
  "Connecting one discovers the tools it offers, so you can give an agent the specific ones it needs — and nothing else.";
export const MCP_EMPTY_MEMBER =
  "Connecting a server is up to an admin of this workspace, so ask one to connect the server you need. Its tools then appear here, and can be given to an agent while planning.";

export function TrustBanner({ full }: { full: boolean }) {
  const [why, setWhy] = useState(false);
  return (
    <Collapsible open={full || why} onOpenChange={setWhy} className="shrink-0 px-4 pt-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: ACCENT.mcp }}>
          <PlugIcon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1 text-tiny leading-[1.5] text-muted">
          <p>
            <span className="text-ink">MCP servers are third-party code Jaroku has not reviewed.</span>
            {!full && (
              <>
                {" "}
                <CollapsibleTrigger className="rounded-control text-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring">
                  {why ? "Show less" : "Why this matters"}
                </CollapsibleTrigger>
              </>
            )}
          </p>
          <CollapsibleContent>
            <p className="mt-0.5">
              What a server says it can do is its own claim. Tools from here are marked
              everywhere they appear, an agent only receives the ones selected for it, and a
              high-impact one stops for your confirmation before it runs.
            </p>
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  );
}

export function McpPanel() {
  const canManage = useCanRun("addMcpServer");
  const servers = useMcpStore((s) => s.servers);

  const selectedId = useMcpStore((s) => s.selectedId);
  const setSelectedId = useMcpStore((s) => s.select);
  const adding = useMcpStore((s) => s.formOpen);
  const toggleForm = useCallback(() => useMcpStore.getState().setFormOpen(!useMcpStore.getState().formOpen), []);
  const openForm = useCallback(() => useMcpStore.getState().setFormOpen(true), []);
  const workspaceId = useSessionStore((s) => s.workspaceId) ?? "";
  const atLimit = useEntitlementStore((s) => s.channel === "mcp" && s.refusal !== null);
  const openBilling = useUiStore((s) => s.openWorkspacePanel);

  useEffect(() => sendListMcpServers(), []);

  // Keep the selection if it still exists, else fall back to the first — the same idiom as
  // evalStore's dataset selection and buildStore's agent selection.
  const pending = useMcpStore(awaitedServer);
  const selected = pending ? null : (servers.find((s) => s.id === selectedId) ?? orderServers(servers)[0] ?? null);
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId, setSelectedId]);
  const picking = servers.length > 0 || pending !== null;
  const root = useRef<HTMLDivElement>(null);
  const departing = useMcpStore((s) => s.departing);
  useEffect(() => {
    if (!departing) return;
    if (!hasDeparted({ departing, servers }, Date.now())) return;
    useMcpStore.getState().noteDeparting(null);
    root.current?.querySelector<HTMLElement>("[data-mcp-picker], [data-mcp-connect]")?.focus();
  }, [departing, servers]);
  const attention = attentionSummary(servers);

  return (
    <div ref={root} className="flex h-full flex-col overflow-hidden">
      {/* The standing reminder. It is worth the two lines it costs: everything below this
          came from code that was never reviewed, and that is easy to forget once a tool list
          looks as tidy as a connector list. */}
      <TrustBanner full={servers.length === 0 || adding} />

      <div className="flex shrink-0 items-center gap-2 border-b border-hair px-4 py-2">
        <SectionHeader name="Servers" count={servers.length} className="shrink-0">
          {attention && (
            <span
              role="img"
              aria-label={attention}
              title={attention}
              data-mcp-attention
              className="inline-flex shrink-0 items-center text-err"
            >
              <AlertTriangleIcon size={ICON.xs} />
            </span>
          )}
        </SectionHeader>
        {picking && (
          <McpServerPicker
            servers={servers}
            selected={selected}
            pending={pending}
            onSelect={setSelectedId}
            onConnect={canManage ? openForm : undefined}
          />
        )}
        {/* §8.2 — "MCP panel / Connect server / connector:manage". The command is `addMcpServer`
            and its capability is `mcp:manage`: connecting a third-party server points every agent
            in this workspace at code nobody here has reviewed, which is the definition of
            committing the workspace to something outside itself. */}
        {canManage && picking && (
          <button
            type="button"
            data-mcp-connect
            aria-label="Connect a server"
            title="Connect a server"
            aria-expanded={adding}
            onClick={toggleForm}
            className={`${buttonVariants({ variant: "soft", size: "icon-sm" })} aria-expanded:bg-chrome aria-expanded:text-ink`}
          >
            <Icon.mcp.connectServer size={ICON.sm} />
          </button>
        )}
        {canManage && !picking && (
          <button type="button" data-mcp-connect className={`${quietBtn} ml-auto shrink-0 ${PRESSED_OPEN}`} aria-expanded={adding} onClick={toggleForm}>
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

      {pending ? (
        <LoadingLine label={`Connecting to ${endpointHost(pending.endpoint)}…`} />
      ) : servers.length === 0 ? (
        <EmptyState
          icon={PlugIcon}
          title="No MCP servers connected"
          hint={canManage ? MCP_EMPTY_ADMIN : MCP_EMPTY_MEMBER}
        />
      ) : selected ? (
        <ServerDetail key={`${workspaceId}:${selected.id}`} server={selected} />
      ) : null}
    </div>
  );
}
