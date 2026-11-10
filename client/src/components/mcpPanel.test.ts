import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConnectForm, CredentialHome, CredentialRemovalConfirm, ENDPOINT_SETTLED, EditServerForm, FIELD, FIELD_MONO, MCP_EMPTY_ADMIN, MCP_EMPTY_MEMBER, MCP_LABEL_MAX, McpPanel, NOT_SENT, PRESSED_OPEN, RemovalConfirm, SCHEMA_DISPLAY_CHARS, SCHEMA_SHORTENED, TOKEN_DROPPED, TrustBanner, controlBtn, nextBtn, notSent, sameToolRow, schemaText, startAdd, storedCredentialTitle, toggledForm } from "./McpPanel.tsx";
import { FIRST_TOOL_PAGE, TOOL_PAGE, matchTools, moreToolsLabel, searchTools, showMoreTools, toolWindow } from "../lib/toolWindow.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { ADD_INTERRUPTED, DEPARTURE_FOCUS_MS, DISCOVERY_STALE_MS, agentsUsing, allMcpTools, awaitedServer, hasDeparted, isDiscovering, liveSelection, mcpToolSearchText, removalConsequences, useMcpStore } from "../store/mcpStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { markup, seed, sessionAs } from "../lib/testRender.ts";
import { resetWorkspaceStores } from "../store/reset.ts";
import { grantRows } from "./AgentTabs.tsx";
import { useEntitlementStore } from "../store/entitlementStore.ts";
import { announceAsks } from "./McpConfirmModal.tsx";
import { McpServerFacts } from "./McpServerPicker.tsx";
import { nextStep } from "../lib/mcpView.ts";
import { TOAST_MAX_MS, TOAST_MS, toastDuration, useUiStore } from "../store/uiStore.ts";
import type { AgentSummary, McpServer, McpTool } from "../types.ts";

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
  const accepted = useMcpStore.getState();
  check("an acceptance ends the wait", accepted.pendingAdd === null);
  check("...and selects the row it reserved", accepted.selectedId === "c_example");

  store.clearAdd();
  startAdd({ endpoint: "https://d.example/mcp", label: "", token: "" }, () => true);
  store.interruptAdd();
  const dropped = useMcpStore.getState().pendingAdd;
  check("a socket that drops while waiting says the outcome is unknown", dropped?.state === "refused" && dropped.message === ADD_INTERRUPTED);
  store.clearAdd();
  store.interruptAdd();
  check("...and a reconnect with nothing waiting leaves nothing behind", useMcpStore.getState().pendingAdd === null);

  seed(useMcpStore, { pendingAdd: { ref: "r", endpoint: "https://e.example/mcp", state: "sending", serverId: null, message: null } });
  const form = markup(React.createElement(ConnectForm));
  check("while waiting the button reads connecting and cannot be pressed", /<button[^>]*disabled=""[^>]*>connecting\u2026<\/button>/.test(form), form.slice(0, 300));
  check("...and what was typed cannot change under it", (form.match(/readOnly=""/gi) ?? []).length === 3);
  seed(useMcpStore, { pendingAdd: null });

  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  check("the add reports whether it left the tab", /export function sendAddMcpServer\([^)]*\): boolean \{\s*return send\(/.test(socket));
  check("an accepted add is matched to the form that sent it", /type === "discovering"\) \{[\s\S]{0,160}settleAdd\(msg\.clientRef, \{ serverId: msg\.serverId \}\)/.test(socket));
  check("...and so is a refusal", /type === "error"\) \{[\s\S]{0,260}if \(msg\.clientRef\) m\.settleAdd\(msg\.clientRef, \{ message: carded \? null : msg\.message \}\)/.test(socket));
  check("a reconnect settles an add left waiting", /forgetDiscovering\(\);\s*useMcpStore\.getState\(\)\.interruptAdd\(\);/.test(socket));
}

console.log("\nEnter submits a form only as its button would");
{
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("no field in the panel handles Enter by itself", !/key === "Enter"/.test(source));
  const form = markup(React.createElement(ConnectForm));
  check("the connect form is a form", /^<div[^>]*><form/.test(form));
  check("...whose Connect is its submit button", /<button type="submit"[^>]*disabled=""[^>]*>Connect<\/button>/.test(form), form.slice(0, 400));
  check("...and submitting it goes through the guarded start", /onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*submit\(\);/.test(source) && /const started = startAdd\(/.test(source));
  check("the credential form is a form too", /onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*saveCredential\(\);/.test(source));
  check("...whose Save submits and whose Remove does not", /<button type="submit" className=\{primaryBtn\} disabled=\{!token\.trim\(\)\}>\s*Save/.test(source) && /<button type="button" className=\{quietBtn\}[\s\S]{0,120}Remove/.test(source));
  check("...and a credential the socket did not send is kept, with the reason", /if \(!sendSetMcpServerAuth\(server\.id, value\)\) \{\s*setCredentialError\(notSent\("Save", true\)\);\s*return;/.test(source));
}

console.log("\nswitching workspace drops whatever was typed for the old one");
{
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("the connect form is rebuilt for each workspace, so a typed credential does not follow", /<ConnectForm key=\{workspaceId\} /.test(source));
  useMcpStore.getState().setFormOpen(true);
  useMcpStore.getState().setDraft({ endpoint: "https://old.example/mcp", label: "Old" });
  useMcpStore.getState().select("old_server");
  useMcpStore.getState().setTokenDropped(true);
  check("a server's credential field is rebuilt too, even where both workspaces have a server of that name", source.includes("<ServerDetail key={`${workspaceId}:${selected.id}`}"));
  useMcpStore.getState().beginAdd("ref-old", "https://old.example/mcp");
  resetWorkspaceStores();
  const after = useMcpStore.getState();
  check("an add the old workspace was waiting on is forgotten", after.pendingAdd === null);
  check("...and so are its open form, its draft, its selection and its notes", !after.formOpen && after.draft.endpoint === "" && after.draft.label === "" && after.selectedId === null && !after.tokenDropped);
}

console.log("\nwhat is selected and what was typed survive leaving the panel");
{
  const store = useMcpStore.getState();
  const alpha = server();
  const beta = server({ id: "beta", label: "Beta", tools: [tool("send_message")] });
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [alpha, beta], selectedId: "beta", formOpen: false, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const chosen = markup(React.createElement(McpPanel));
  check("the server last selected is the one shown when the panel opens again", />send_message</.test(chosen));

  seed(useMcpStore, { formOpen: true, draft: { endpoint: "https://half.example/mcp", label: "Half" } });
  const reopened = markup(React.createElement(McpPanel));
  check("a half filled form is still open", /name="mcp-server-endpoint"/.test(reopened));
  check("...with the endpoint and name that were typed", /value="https:\/\/half\.example\/mcp"/.test(reopened) && /value="Half"/.test(reopened));
  check("...but never with a credential", /name="mcp-server-token"[^>]*value=""/.test(reopened));
  check("and without a note when no token was lost", !reopened.includes("was cleared when you left"));

  seed(useMcpStore, { tokenDropped: true });
  const dropped = markup(React.createElement(McpPanel));
  check("a token that was typed and dropped is said to be gone", dropped.includes(TOKEN_DROPPED));
  seed(useMcpStore, { tokenDropped: false, formOpen: false, draft: { endpoint: "", label: "" } });

  store.clearAdd();
  startAdd({ endpoint: "https://new.example/mcp", label: "New", token: "" }, () => true);
  store.setFormOpen(true);
  store.setDraft({ endpoint: "https://new.example/mcp", label: "New" });
  store.settleAdd(useMcpStore.getState().pendingAdd?.ref ?? "", { serverId: "new_server" });
  const settled = useMcpStore.getState();
  check("a server just added is selected", settled.selectedId === "new_server");
  check("...and its form closes and empties, wherever the person was", !settled.formOpen && settled.draft.endpoint === "" && settled.draft.label === "");

  store.select("beta");
  store.setFormOpen(true);
  store.setDraft({ endpoint: "https://typo.example" });
  startAdd({ endpoint: "https://typo.example", label: "", token: "" }, () => true);
  store.settleAdd(useMcpStore.getState().pendingAdd?.ref ?? "", { message: "could not find" });
  const kept = useMcpStore.getState();
  check("a refused add keeps its form and its draft", kept.formOpen && kept.draft.endpoint === "https://typo.example" && kept.selectedId === "beta");
  store.clearAdd();

  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const row = /<div className="flex shrink-0 items-center gap-2 border-b border-hair px-4 py-2">[\s\S]*?\n {6}<\/div>\n/.exec(source)?.[0] ?? "";
  check("the servers are chosen from one picker, so nothing scrolls sideways", row.includes("<McpServerPicker") && !/overflow-x-auto/.test(source));
  check("Connect a server sits beside the picker, never inside something that scrolls", (row.match(/data-mcp-connect/g) ?? []).length === 2 && row.includes('aria-label="Connect a server"'));
  check("a token typed and then left behind is noted, never kept", /if \(typed\.current && useMcpStore\.getState\(\)\.formOpen\) useMcpStore\.getState\(\)\.setTokenDropped\(true\)/.test(source));
  seed(useMcpStore, { servers: [], selectedId: null, formOpen: false });
}

console.log("\nthe panel can be used without a mouse or a screen");
{
  const alpha = server();
  const beta = server({ id: "beta", label: "Beta" });
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [alpha, beta], selectedId: "beta", formOpen: false, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const closed = markup(React.createElement(McpPanel));
  const picker = /<button[^>]*data-mcp-picker="[^"]*"[^>]*>.*?<\/button>/s.exec(closed)?.[0] ?? "";
  check("the picker is one control, and names the server it shows", /data-mcp-picker="beta"/.test(picker) && /aria-label="Server: Beta, connected\. Choose another"/.test(picker), picker.slice(0, 300));
  check("...with its whole name, its status and how many tools it has", />Beta<\/span>/.test(picker) && /title="connected"/.test(picker) && />0<\/span>/.test(picker), picker);
  check("...and says it opens a menu", /aria-haspopup="menu"/.test(picker) && /aria-expanded="false"/.test(picker));
  const connectButton = (html: string): string => /<button[^>]*data-mcp-connect[^>]*>/.exec(html)?.[0] ?? "";
  check("Connect a server is named, and says the form is closed", /aria-label="Connect a server"/.test(connectButton(closed)) && /aria-expanded="false"/.test(connectButton(closed)), connectButton(closed));
  check("...named for a pointer too, since it is a mark with no words", /title="Connect a server"/.test(connectButton(closed)));
  seed(useMcpStore, { formOpen: true });
  const open = markup(React.createElement(McpPanel));
  check("...and open once it is", /aria-expanded="true"/.test(connectButton(open)));
  seed(useMcpStore, { servers: [], formOpen: false, selectedId: null });
  const none = markup(React.createElement(McpPanel));
  check("with no server there is nothing to pick, so the button is spelled out", !/data-mcp-picker/.test(none) && /<button[^>]*data-mcp-connect[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Connect a server<\/button>/s.test(none), connectButton(none));
  seed(useSessionStore, sessionAs("member"));
  seed(useMcpStore, { servers: [alpha, beta], selectedId: "beta" });
  const member = markup(React.createElement(McpPanel));
  check("a member picks a server too, and is offered no way to connect one", /data-mcp-picker="beta"/.test(member) && !/data-mcp-connect/.test(member));
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [alpha, beta], formOpen: false, selectedId: null });

  const form = markup(React.createElement(ConnectForm));
  check("the connect form is named", /<form[^>]*aria-label="Connect an MCP server"/.test(form));
  for (const [field, label] of [["mcp-server-endpoint", "Server URL"], ["mcp-server-label", "Name (optional)"], ["mcp-server-token", "Token (if the server needs one)"]] as const) {
    check(`its ${field.replace("mcp-server-", "")} field has a label, not only a placeholder`, new RegExp(`aria-label="${label.replace(/[()]/g, "\\$&")}"[^>]*name="${field}"|name="${field}"[^>]*aria-label="${label.replace(/[()]/g, "\\$&")}"`).test(form));
  }
  check("it has a Cancel that does not submit", /<button type="button"[^>]*>Cancel<\/button>/.test(form));

  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("Escape cancels the connect form", /if \(e\.key === "Escape"\) \{\s*e\.preventDefault\(\);\s*cancel\(\);/.test(source));
  check("...which closes it and forgets the draft, unless an add is on its way", /const cancel = \(\) => \{\s*if \(sending\) return;[\s\S]{0,260}setDraft\(\{ endpoint: "", label: "" \}\)[\s\S]{0,160}setFormOpen\(false\)/.test(source));
  check("Escape cancels the credential form too", /if \(e\.key === "Escape"\) \{\s*e\.preventDefault\(\);\s*cancelCredential\(\);/.test(source));
  check("...which has a Cancel of its own", /<button type="button" className=\{quietBtn\} onClick=\{cancelCredential\}>\s*Cancel/.test(source));
  check("the credential field is labelled with its server", /name="mcp-server-credential"\s*aria-label=\{`Credential for \$\{server\.label\}`\}/.test(source));
  check("and the button that shows it says whether it is shown", /aria-expanded=\{open === "credential"\}/.test(source));

  const ask = (nonce: string, tool: string, agentName: string | null) => ({
    runId: `run-${nonce}`, nonce, server: "alpha", tool, impactReason: null, args: "{}", timeoutS: 60,
    requestedAt: new Date().toISOString(), agentName,
  });
  check("one new ask is said on its own", announceAsks([ask("a", "send_message", "Mailer")]) === "Mailer is waiting on you to allow send_message on alpha.");
  const both = announceAsks([ask("a", "send_message", "Mailer"), ask("b", "delete_row", null)]);
  check("two that arrive together are both said, rather than one replacing the other", /^2 tools are waiting on you: Mailer wants send_message on alpha; run run-b wants delete_row on alpha\.$/.test(both), both);
}

console.log("\nwhat MCP has to say reaches the person who asked, wherever they are");
{
  check("a short message stays long enough to read", toastDuration("connected") === TOAST_MS);
  const long = "x".repeat(200);
  check("a long one stays longer", toastDuration(long) > TOAST_MS && toastDuration(long) <= TOAST_MAX_MS, String(toastDuration(long)));
  check("...up to a ceiling", toastDuration("x".repeat(5000)) === TOAST_MAX_MS);

  const ui = useUiStore.getState();
  useUiStore.setState({ toast: null, toastAfter: null });
  ui.showToast("that endpoint could not be checked", "err");
  const failed = useUiStore.getState().toast;
  check("an error is shown for as long as its length needs", failed?.ms === toastDuration("that endpoint could not be checked"));
  ui.showToast("2 advertised tools were refused as unusable");
  check("a notice does not cover an error still being read", useUiStore.getState().toast?.id === failed?.id);
  ui.dismissToast(failed?.id ?? -1);
  check("...it follows once the error has gone", useUiStore.getState().toast?.message === "2 advertised tools were refused as unusable");
  const before = useUiStore.getState().toast?.id;
  for (let i = 0; i < 30; i++) ui.showToast("2 advertised tools were refused as unusable");
  check("the same sentence thirty times is one toast, kept up rather than replaced", useUiStore.getState().toast?.id === before);
  ui.showToast("a newer error", "err");
  check("an error still replaces a notice at once", useUiStore.getState().toast?.message === "a newer error");
  useUiStore.setState({ toast: null, toastAfter: null });

  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  const mcp = /case "mcp": \{[\s\S]*?\n {4}\}\n/.exec(socket)?.[0] ?? "";
  check("an MCP error is said in the corner toast, whichever panel is open", /type === "error"\) \{[\s\S]{0,520}if \(isOurs\(msg\.origin\) && !cardShown\) useUiStore\.getState\(\)\.showToast\(msg\.message, "err"\)/.test(mcp));
  check("...and so is a notice", /type === "notice"\) \{ if \(isOurs\(msg\.origin\)\) useUiStore\.getState\(\)\.showToast\(msg\.message\); \}/.test(mcp));
  check("...only in the tab whose action it is about", /cmd: "rediscoverMcpServer", serverId, origin: EVAL_ORIGIN/.test(socket) && /cmd: "setMcpServerAuth", serverId, token, origin: EVAL_ORIGIN/.test(socket) && /cmd: "addMcpServer", endpoint, label, token, clientRef, origin: EVAL_ORIGIN/.test(socket));
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("the panel no longer has to be open for any of it", !/useToastFrom/.test(source));
}

console.log("\nthe plan's server limit is explained where it was hit, with the way past it");
{
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server()], selectedId: null, formOpen: false });
  seed(useEntitlementStore, {
    channel: "mcp",
    refusal: { error: "quota_exceeded", kind: "mcp_servers", current: 3, limit: 3, tier: "free", upgradeUrl: "/billing", unlocks: "pro", unlocksLabel: "Pro" },
  });
  const limited = markup(React.createElement(McpPanel));
  check("the panel shows the limit it hit", /You have used all your connected MCP servers/.test(limited));
  check("...the figures", /3 of 3 connected MCP servers used/.test(limited));
  check("...and the plan that raises it", /Pro raises this limit/.test(limited));
  seed(useEntitlementStore, { channel: "gen", refusal: { error: "quota_exceeded", kind: "agents", current: 3, limit: 3, tier: "free", upgradeUrl: "/billing", unlocks: "pro", unlocksLabel: "Pro" } });
  check("a limit hit somewhere else is not shown here", !/You have used all your/.test(markup(React.createElement(McpPanel))));
  seed(useEntitlementStore, { channel: null, refusal: null });

  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  check("an accepted add puts the card away", /settleAdd\(msg\.clientRef, \{ serverId: msg\.serverId \}\);\s*if \(msg\.clientRef && useEntitlementStore\.getState\(\)\.channel === "mcp"\) useEntitlementStore\.getState\(\)\.clear\(\);/.test(socket));
}

console.log("\ndisconnecting and removing a credential ask first, and say what is lost");
{
  const agent = (name: string, refs: string[]): AgentSummary => ({ agent_id: name, name, description: "", connectors: [], mcp_tools: refs, required_env: [], default_provider: "anthropic", created_at: "2026-11-07T00:00:00.000Z", hand_written: false, runnable: true } as AgentSummary);
  const rich = server({
    configured: true,
    tools: [tool("read_page"), tool("send_message", { overridden: true, impact: "low", computed_impact: "high" }), tool("search")],
  });
  const agents = [agent("mailer", ["alpha/send_message"]), agent("reader", ["alpha/read_page", "beta/x"]), agent("other", ["alphabet/read_page"])];
  check("an agent counts as using a server only by that server's own refs", agentsUsing("alpha", agents).map((a) => a.name).join() === "mailer,reader");
  const said = removalConsequences(rich, agents);
  check("it names what is removed", /removes 3 discovered tools, the impact you set on 1 of them and its stored credential\./.test(said), said);
  check("...that nothing undoes it", /Nothing brings them back except connecting it again\./.test(said));
  check("...and the agents that lose its tools", /2 agents granted its tools \(mailer, reader\) will no longer be able to call them\./.test(said), said);
  const bare = removalConsequences(server({ tools: [tool("read_page")] }), []);
  check("a plain server says only what it has", /removes 1 discovered tool\. Nothing brings them back/.test(bare) && /No agent is granted its tools\./.test(bare), bare);

  seed(useBuildStore, { agents });
  const ask = markup(React.createElement(RemovalConfirm, { server: rich, onKeep: () => {} }));
  check("the disconnect question is the consequences, then the choice", ask.includes("2 agents granted its tools (mailer, reader)") && /Disconnect Alpha/.test(ask) && /Keep it/.test(ask));
  seed(useBuildStore, { agents: [] });
  const credential = markup(React.createElement(CredentialRemovalConfirm, { server: rich, onKeep: () => {}, onRemoved: () => {} }));
  check("removing a credential asks too", /Removing the credential stored for Alpha deletes it/.test(credential) && /Remove the credential/.test(credential) && /Keep it/.test(credential));

  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const detail = /function ServerDetail\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
  check("disconnect opens the question rather than disconnecting", /onSelect=\{\(\) => openFromMenu\("disconnect"\)\}/.test(detail) && !/sendRemoveMcpServer/.test(detail));
  check("...and Remove does the same for the credential", /onClick=\{\(\) => setOpen\("credential-removal"\)\}/.test(detail) && !/sendSetMcpServerAuth\(server\.id, null\)/.test(detail));
}

console.log("\na server can be renamed, and a mistyped endpoint fixed before it ever connects");
{
  const typo = server({ status: "error", discovered_at: null, endpoint: "https://alpha.example/mpc" });
  const draft = markup(React.createElement(EditServerForm, { server: typo, onDone: () => {} }));
  check("the edit form holds the current name", /name="mcp-server-edit-label"[^>]*value="Alpha"|value="Alpha"[^>]*name="mcp-server-edit-label"/.test(draft));
  const endpointField = /<input[^>]*name="mcp-server-edit-endpoint"[^>]*>/.exec(draft)?.[0] ?? "";
  check("...and an endpoint that can still be corrected", /value="https:\/\/alpha\.example\/mpc"/.test(endpointField) && !/readOnly/i.test(endpointField), endpointField);
  const settled = markup(React.createElement(EditServerForm, { server: server(), onDone: () => {} }));
  const fixedField = /<input[^>]*name="mcp-server-edit-endpoint"[^>]*>/.exec(settled)?.[0] ?? "";
  check("a server that has connected keeps its endpoint", /readOnly=""/i.test(fixedField), fixedField);
  check("...and says why", settled.includes(ENDPOINT_SETTLED));
  check("it can be cancelled", /<button type="button"[^>]*>Cancel<\/button>/.test(settled));

  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server()], selectedId: null });
  const panel = markup(React.createElement(McpPanel));
  check("an admin is offered edit, from the server's menu", /<button[^>]*data-mcp-more[^>]*>/.test(panel) && /aria-label="More for Alpha"/.test(panel));
  const menu = /<DropdownMenuContent[\s\S]*?<\/DropdownMenuContent>/.exec(/function ServerDetail\([\s\S]*?\n\}\n/.exec(readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8"))?.[0] ?? "")?.[0] ?? "";
  check("...which opens the edit form", /onSelect=\{\(\) => openFromMenu\("edit"\)\}/.test(menu));
  seed(useSessionStore, sessionAs("member"));
  check("a member is not", !/data-mcp-more/.test(markup(React.createElement(McpPanel))));
  seed(useSessionStore, sessionAs("admin"));

  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  check("the edit says whether it left the tab, and which tab sent it", /export function sendUpdateMcpServer\([^)]*\): boolean \{\s*return send\(\{ cmd: "updateMcpServer", serverId, \.\.\.patch, origin: EVAL_ORIGIN \}\);/.test(socket));
}

console.log("\na setting voided by a schema change can be cleared directly");
{
  const voided = server({ tools: [tool("search_docs", { override_voided: true, overridden: false, impact: "high", computed_impact: "high" })] });
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [voided], selectedId: null });
  const admin = markup(React.createElement(McpPanel));
  check("the voided setting is still flagged", /your override no longer applies/.test(admin));
  check("...and an admin can clear it in one step", />clear my old setting<\/button>/.test(admin));
  seed(useSessionStore, sessionAs("member"));
  check("a member is not offered that", !/clear my old setting/.test(markup(React.createElement(McpPanel))));
  seed(useSessionStore, sessionAs("admin"));
  const live = server({ tools: [tool("send_message", { overridden: true, impact: "low", computed_impact: "high" })] });
  seed(useMcpStore, { servers: [live] });
  const current = markup(React.createElement(McpPanel));
  check("a setting still in force keeps its own wording", />use Jaroku&#x27;s classification<\/button>/.test(current) && !/clear my old setting/.test(current));
  seed(useMcpStore, { servers: [] });
}

console.log("\nan empty panel tells each role what it can do next");
{
  seed(useMcpStore, { servers: [], selectedId: null, formOpen: false });
  seed(useSessionStore, sessionAs("member"));
  const member = markup(React.createElement(McpPanel));
  check("a member is told who can connect a server", member.includes(MCP_EMPTY_MEMBER) && /ask one/.test(MCP_EMPTY_MEMBER));
  check("...and is not told to connect one themselves", !member.includes(MCP_EMPTY_ADMIN));
  seed(useSessionStore, sessionAs("admin"));
  const admin = markup(React.createElement(McpPanel));
  check("an admin is told what connecting one does", admin.includes(MCP_EMPTY_ADMIN.replace("—", "&#8212;")) || admin.includes(MCP_EMPTY_ADMIN));
  check("...and not to ask somebody else", !admin.includes(MCP_EMPTY_MEMBER));
}

console.log("\nwhat a person reads to decide is readable, and the controls are big enough to hit");
{
  const config = readFileSync(fileURLToPath(new URL("../../tailwind.config.js", import.meta.url)), "utf8");
  const colour = (name: string): string => new RegExp(`^\\s*${name}: "(#[0-9A-Fa-f]{6})"`, "m").exec(config)?.[1] ?? "";
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const ratio = Math.min(contrast(colour("muted"), colour("bg")), contrast(colour("muted"), colour("panel")));
  check("the colour now used for the reason, the time and the claim meets AA at small sizes", ratio >= 4.5, ratio.toFixed(2));

  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server({ server_name: "Mock", server_version: "1.0", tools: [tool("read_page")] })], selectedId: null, discovering: {} });
  const html = markup(React.createElement(McpPanel));
  check("the reason a tool was classified is not faint", /<p class="[^"]*text-muted[^"]*">[^<]*its name begins with a read verb/.test(html));
  check("nor is the server's claim about itself", /<span class="text-muted"> — its own claim, unverified<\/span>/.test(html));
  check("nor when it was last checked", /<p class="px-2 py-1\.5 text-tiny text-muted">1 tool/.test(html));
  for (const label of ["re-check", "add a credential"]) {
    check(`${label} is at least 24px tall`, new RegExp(`<button[^>]*class="[^"]*min-h-6[^"]*"[^>]*>(?:(?!</button>).)*${label}</button>`, "s").test(html));
  }
  check("the menu holding edit and disconnect is at least 24px tall too", /<button[^>]*data-mcp-more[^>]*class="[^"]*min-h-6|<button[^>]*class="[^"]*min-h-6[^"]*"[^>]*data-mcp-more/.test(html));
  check("every control in that row shares the taller class", controlBtn.includes("min-h-6"));
}

console.log("\nlong text wraps inside the panel, and a big schema is bounded");
{
  const longName = `read_${"x".repeat(123)}`;
  const wide = server({
    server_name: "S".repeat(600),
    tools: [tool(longName, { description: "d".repeat(4000) })],
  });
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [wide], selectedId: null, discovering: {} });
  const html = markup(React.createElement(McpPanel));
  check("an unbroken description can break anywhere", /<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">d{4000}<\/p>/.test(html));
  check("...and so can a long tool name", new RegExp(`<span class="[^"]*\\[overflow-wrap:anywhere\\][^"]*">${longName}</span>`).test(html));
  check("...and the server's own description of itself", /<p class="mt-1 text-tiny text-muted \[overflow-wrap:anywhere\]">Identifies itself as/.test(html));

  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 64; i++) deep = { type: "object", properties: { [`level_${i}`]: deep } };
  const pretty = JSON.stringify(deep, null, 2).length;
  const shown = schemaText(deep);
  check("a deep schema is never laid out as megabytes of indentation", pretty > SCHEMA_DISPLAY_CHARS && shown.length <= SCHEMA_DISPLAY_CHARS + SCHEMA_SHORTENED.length + 1, `${pretty} -> ${shown.length}`);
  check("...it is shown compactly instead", shown === JSON.stringify(deep) || shown.endsWith(SCHEMA_SHORTENED));
  const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`p${i}`, { type: "string", description: "padding" }])) };
  check("and a schema too long even then says it was shortened", schemaText(huge).endsWith(SCHEMA_SHORTENED));
  const small = { type: "object", properties: { url: { type: "string" } } };
  check("an ordinary schema is pretty printed as before", schemaText(small) === JSON.stringify(small, null, 2));
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("the schema block has a height of its own", /<pre className="[^"]*max-h-80 overflow-auto[^"]*">\s*\{schemaText\(tool\.input_schema\)\}/.test(source));
}

console.log("\nthe composer's tool picker holds only tools that exist, and says when their server is in trouble");
{
  const alpha = server({ tools: [tool("read_page"), tool("send_message")] });
  const beta = server({ id: "beta", label: "Beta", status: "unreachable", tools: [tool("search")] });
  const picked = ["alpha/send_message", "beta/search", "gone/read_page", "alpha/deleted_tool"];
  check("a tick for a disconnected server or a vanished tool is dropped", liveSelection(picked, [alpha, beta]).join() === "alpha/send_message,beta/search");
  check("...and nothing else changes order or goes", liveSelection(["beta/search", "alpha/read_page"], [alpha, beta]).join() === "beta/search,alpha/read_page");
  check("once a server is gone none of its tools stay ticked", liveSelection(picked, [alpha]).join() === "alpha/send_message");
  check("each listed tool carries its server's status", allMcpTools([alpha, beta]).map((t) => `${t.ref}:${t.serverStatus}`).join() === "alpha/read_page:connected,alpha/send_message:connected,beta/search:unreachable");

  const build = readFileSync(fileURLToPath(new URL("./BuildPane.tsx", import.meta.url)), "utf8");
  check("the composer prunes its ticks whenever the servers change", /useEffect\(\(\) => \{\s*setSelectedMcp\(\(current\) => \{\s*const kept = liveSelection\(current, mcpServers\);[\s\S]{0,120}\}, \[mcpServers\]\);/.test(build));
  check("a tool from a server that is not connected says so in its row", /\{t\.serverStatus !== "connected" && \([\s\S]{0,260}MCP_STATUS_LABEL\[t\.serverStatus\]/.test(build));
}

console.log("\ntools ticked for one agent are not carried into the next");
{
  const build = readFileSync(fileURLToPath(new URL("./BuildPane.tsx", import.meta.url)), "utf8");
  check("moving to another agent clears the MCP ticks and closes the list", /useEffect\(\(\) => \{\s*setSelectedMcp\(\[\]\);\s*setMcpOpen\(false\);\s*\}, \[activeAgentId\]\);/.test(build));
  const declared = build.indexOf("const activeAgentId = useBuildStore(");
  const cleared = build.indexOf("setSelectedMcp([]);");
  check("...keyed on the agent the composer is building, which is set before the effect reads it", declared > 0 && cleared > declared);
  check("the ticks are sent as they stand when a plan or a build goes out", (build.match(/selectedMcp, attachRefs/g) ?? []).length >= 2);
}

console.log("\nthe grant editor marks a tool that asks first, as the composer does");
{
  const alpha = server({ tools: [tool("read_page"), tool("delete_everything", { impact: "high", computed_impact: "high" })] });
  const rows = grantRows([alpha], ["alpha/read_page", "gone/send"]);
  check("every tool in the workspace and every granted ref is a row", rows.map((r) => r.ref).join() === "alpha/delete_everything,alpha/read_page,gone/send");
  check("a high impact tool is marked as one", rows.find((r) => r.ref === "alpha/delete_everything")?.high === true);
  check("a read is not", rows.find((r) => r.ref === "alpha/read_page")?.high === false);
  check("a ref whose server has gone is still offered, as gone", rows.find((r) => r.ref === "gone/send")?.gone === true);
  const lowered = server({ tools: [tool("send_message", { impact: "low", computed_impact: "high", overridden: true })] });
  check("the mark follows the impact that governs, not the classifier's first answer", grantRows([lowered], [])[0]?.high === false);
  const tabs = readFileSync(fileURLToPath(new URL("./AgentTabs.tsx", import.meta.url)), "utf8");
  check("the row shows the same confirms chip the composer shows", /\{high && \(\s*<Chip size="sm" caps variant="bare" color=\{STATUS\.pending\}[^>]*title="Asks before it runs the first time">\s*confirms/.test(tabs));
}

console.log("\nthe panel's own words match what actually grants a tool");
{
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [], selectedId: null, formOpen: true, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const html = markup(React.createElement(McpPanel));
  check("an agent receives the tools selected for it, which may be more than its plan used", /an agent only receives the ones selected for it/.test(html) && !/the ones its plan asked for/.test(html));
  check("the connect form names both places a tool is granted", /until you select it while planning, or on an agent&#x27;s\s+Capabilities tab/.test(html) || /until you select it while planning, or on an agent's\s+Capabilities tab/.test(html));
  seed(useMcpStore, { formOpen: false });
}

console.log("\na credential is said to be kept where this server keeps it");
{
  const key = "JAROKU_MCP_ALPHA_TOKEN";
  check("a desktop names its file and the key in it", storedCredentialTitle({ auth_env_key: key, credential_store: "dotenv" }) === `Read from ${key} in runtime/.env. Jaroku never displays it.`);
  const hosted = storedCredentialTitle({ auth_env_key: key, credential_store: "kms" });
  check("a hosted workspace is told it is encrypted, and about no file", hosted.includes("encrypted") && !hosted.includes("runtime/.env") && !hosted.includes(key), hosted);
  const unsaid = storedCredentialTitle({ auth_env_key: key });
  check("a server that does not say where claims neither", !unsaid.includes("runtime/.env") && !unsaid.includes("encrypted"), unsaid);
  const note = (credential_store?: "dotenv" | "kms" | null): string =>
    markup(React.createElement(CredentialHome, { server: { auth_env_key: key, credential_store } }));
  check("the credential form names the file on a desktop", note("dotenv").includes("runtime/.env") && note("dotenv").includes(key) && note("dotenv").includes("gitignored"), note("dotenv"));
  check("...and no file when hosted", !note("kms").includes("runtime/.env") && !note("kms").includes(key) && note("kms").includes("encrypted"), note("kms"));
  check("...nor when the server does not say", !note(undefined).includes("runtime/.env") && !note(null).includes("runtime/.env"), note(undefined));

  seed(useMcpStore, { selectedId: "alpha" });
  const vaulted = render([server({ configured: true, auth_env_key: key, credential_store: "kms" })]);
  check("a hosted panel showing a stored credential never mentions runtime/.env", vaulted.includes("credential stored") && !vaulted.includes("runtime/.env"), vaulted.slice(0, 200));
  const local = render([server({ configured: true, auth_env_key: key, credential_store: "dotenv" })]);
  check("a desktop one says where to find it", local.includes("runtime/.env"));
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("the credential form says it through the same rule", /<CredentialHome server=\{server\} \/> It is never logged and never sent back to this page\./.test(source));
  seed(useMcpStore, { selectedId: null });
}

console.log("\na server with hundreds of tools renders a page of them, not all of them");
{
  const many = Array.from({ length: 500 }, (_, i) => tool(`tool_${String(i).padStart(3, "0")}`, {
    description: i % 2 ? `reads page ${i}` : `writes row ${i}`,
    schema_hash: `h${i}`,
  }));
  seed(useMcpStore, { selectedId: "alpha" });
  const html = render([server({ tools: many })]);
  const rows = html.match(/>schema<\/button>/g)?.length ?? 0;
  check("only the first page of rows is drawn", rows === TOOL_PAGE, String(rows));
  check("...starting with the first tool", html.includes(">tool_000<") && html.includes(`>tool_${String(TOOL_PAGE - 1).padStart(3, "0")}<`) && !html.includes(`>tool_${String(TOOL_PAGE).padStart(3, "0")}<`));
  check("the count still says how many there are", /500 tools/.test(html));
  check("the rest are one press away", html.includes(`Show ${TOOL_PAGE} more (${500 - TOOL_PAGE} not shown)`), html.match(/Show [^<]*/)?.[0] ?? "");
  check("and a long list can be searched", /type="search"[^>]*name="mcp-tool-filter"|name="mcp-tool-filter"[^>]*type="search"/.test(html) && html.includes('aria-label="Find a tool on Alpha"'));
  const few = render([server({ tools: many.slice(0, 12) })]);
  check("a short list is drawn whole, with no search and nothing more to show", (few.match(/>schema<\/button>/g)?.length ?? 0) === 12 && !few.includes("mcp-tool-filter") && !/Show (the other|\d+ more)/.test(few));
  const fiveThousand = render([server({ tools: Array.from({ length: 5000 }, (_, i) => tool(`t${i}`, { schema_hash: `x${i}` })) })]);
  check("the page drawn does not grow with the list behind it", fiveThousand.length < html.length * 1.5, `${fiveThousand.length} vs ${html.length}`);
  seed(useMcpStore, { selectedId: null });

  let state = FIRST_TOOL_PAGE;
  const text = (t: McpTool): string => `${t.name} ${t.description ?? ""}`;
  const windowOf = () => toolWindow(many, matchTools(many, state.query, text), state);
  check("the first page is a page", windowOf().visible.length === TOOL_PAGE && windowOf().remaining === 500 - TOOL_PAGE);
  state = showMoreTools(state);
  check("showing more adds one more page", windowOf().visible.length === TOOL_PAGE * 2 && windowOf().remaining === 500 - TOOL_PAGE * 2);
  state = searchTools("  WRITES ");
  check("a search matches descriptions, ignoring case and spaces around it", windowOf().matched === 250 && windowOf().visible.every((t) => (t.description ?? "").startsWith("writes")), String(windowOf().matched));
  check("...and starts again from its first page", windowOf().visible.length === TOOL_PAGE);
  state = searchTools("tool_499");
  check("a name finds its one tool wherever it sits in the list", windowOf().matched === 1 && windowOf().visible[0]?.name === "tool_499" && windowOf().remaining === 0);
  state = searchTools("nothing called this");
  check("a search that matches nothing shows nothing", windowOf().matched === 0 && windowOf().visible.length === 0);
  check("the last few are offered by name", moreToolsLabel(7) === "Show the other 7");

  const row = { tool: many[1]!, serverId: "alpha" };
  check("a row whose tool arrived again unchanged is not drawn again", sameToolRow(row, { tool: { ...many[1]! }, serverId: "alpha" }));
  check("...but one whose impact moved is", !sameToolRow(row, { tool: { ...many[1]!, impact: "high" }, serverId: "alpha" }));
  check("...or whose schema changed", !sameToolRow(row, { tool: { ...many[1]!, schema_hash: "changed" }, serverId: "alpha" }));
  check("...or whose override was voided", !sameToolRow(row, { tool: { ...many[1]!, override_voided: true }, serverId: "alpha" }));
  check("...or that now belongs to another server", !sameToolRow(row, { tool: many[1]!, serverId: "beta" }));
}

console.log("\nthe composer's MCP list and the grant editor draw a page at a time too");
{
  const many = Array.from({ length: 300 }, (_, i) => tool(`op_${i}`, { schema_hash: `s${i}` }));
  const refs = allMcpTools([server({ tools: many }), server({ id: "beta", label: "Billing", tools: [tool("charge_card", { description: "takes money" })] })]);
  const byServer = matchTools(refs, "billing", mcpToolSearchText);
  check("the composer finds a tool by the server it comes from", byServer.length === 1 && byServer[0]?.ref === "beta/charge_card", byServer.map((t) => t.ref).join());
  check("...or by what it says it does", matchTools(refs, "MONEY", mcpToolSearchText)[0]?.ref === "beta/charge_card");
  const build = readFileSync(fileURLToPath(new URL("./BuildPane.tsx", import.meta.url)), "utf8");
  check("the composer draws only the window of its tools", /mcpWindow\.visible\.map\(\(t\) => \{/.test(build) && !/\{mcpTools\.map\(/.test(build));
  check("...searchable once the list is long", /\{mcpOpen && mcpWindow\.filterable && \(\s*<input\s+type="search"\s+name="mcp-composer-filter"/.test(build));
  check("...with the rest one press away", /\{mcpWindow\.remaining > 0 && \([\s\S]{0,300}onClick=\{mcpWindow\.more\}[\s\S]{0,300}moreToolsLabel\(mcpWindow\.remaining\)/.test(build));

  const tabs = readFileSync(fileURLToPath(new URL("./AgentTabs.tsx", import.meta.url)), "utf8");
  const editor = /function McpGrantEditor\([\s\S]*?\n\}\n/.exec(tabs)?.[0] ?? "";
  check("the grant editor draws only its window", /choices\.visible\.map\(\(\{ ref, gone, high \}\) => \{/.test(editor) && !/\brows\.map\(/.test(editor));
  check("...searchable once the list is long", /\{choices\.filterable && \(\s*<input\s+type="search"\s+name="mcp-grant-filter"/.test(editor));
  check("...with the rest one press away", /\{choices\.remaining > 0 && \([\s\S]{0,200}onClick=\{choices\.more\}[\s\S]{0,100}moreToolsLabel\(choices\.remaining\)/.test(editor));
  const hook = editor.indexOf("useToolWindow(rows, grantRowText)");
  check("...and its hooks run before it decides a member sees nothing", hook > 0 && hook < editor.indexOf("if (!mayWrite) return null;"));
  check("the count beside Save is still every row, not the page", /\{chosen\.length\} of \{rows\.length\}/.test(editor));
  const rows = grantRows([server({ tools: many })], ["gone/kept_grant"]);
  const gone = toolWindow(rows, matchTools(rows, "gone/", (r) => r.ref), FIRST_TOOL_PAGE);
  check("a grant whose server went can be found however long the list", gone.visible.length === 1 && gone.visible[0]?.gone === true);
}

console.log("\nevery MCP panel action says when it was not sent, naming the button to press again");
{
  check("the connect form's words are as they were", NOT_SENT === "Jaroku is not connected right now, so nothing was sent. What you typed is still here: press Connect again once it reconnects.");
  check("an action with nothing typed names its own button", notSent("re-check") === "Jaroku is not connected right now, so nothing was sent. Press re-check again once it reconnects.", notSent("re-check"));
  check("...and one with something typed says that is kept", notSent("Save", true).includes("What you typed is still here: press Save again once it reconnects."));
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("only the connect form sends somebody to Connect", (source.match(/\bNOT_SENT\b/g) ?? []).length === 2 && /if \(started === "offline"\) setFormError\(NOT_SENT\);/.test(source));
  check("disconnecting names its own button", source.includes("{notSent(`Disconnect ${server.label}`)}"));
  check("removing a credential names its own button", source.includes('{notSent("Remove the credential")}'));
  check("an edit and a new credential keep what was typed and name Save", (source.match(/notSent\("Save", true\)/g) ?? []).length === 2);
  check("a re-check that never left the tab says so", /onClick=\{\(\) => setCheckUnsent\(!sendRediscoverMcpServer\(server\.id\)\)\}/.test(source) && /\{checkUnsent && <p role="alert"[^>]*>\{notSent\("re-check"\)\}<\/p>\}/.test(source));
  check("an impact change that never left the tab says so on its own tool", /setUnsent\(sendSetMcpToolImpact\(serverId, tool\.name, impact\) \? null : notSent\(control\)\)/.test(source) && /\{unsent && <p role="alert"[^>]*>\{unsent\}<\/p>\}/.test(source));
  check("...naming the button that was pressed", /setImpact\(high \? "low" : "high", high \? "stop asking first" : "treat as high impact"\)/.test(source) && /setImpact\(null, tool\.override_voided \? "clear my old setting" : "use Jaroku's classification"\)/.test(source));
  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  check("and the socket reports whether an impact change was sent", /export function sendSetMcpToolImpact\([^)]*\): boolean \{\s*return send\(/.test(socket));
}

console.log("\na grant editor save that never left the tab keeps the ticks and says so");
{
  const tabs = readFileSync(fileURLToPath(new URL("./AgentTabs.tsx", import.meta.url)), "utf8");
  const editor = /function McpGrantEditor\([\s\S]*?\n\}\n/.exec(tabs)?.[0] ?? "";
  check("a save that was not sent leaves the editor open with its ticks", /if \(!sendSetAgentTools\(slug, chosen\)\) \{\s*setUnsent\(true\);\s*return;\s*\}\s*setUnsent\(false\);\s*setOpen\(false\);\s*setDraft\(null\);/.test(editor));
  check("...and says so, naming Save", /\{unsent && <p role="alert"[^>]*>\{notSent\("Save"\)\}<\/p>\}/.test(editor));
  check("...until the editor is opened or closed again", /setDraft\(granted\); setUnsent\(false\); setOpen\(\(v\) => !v\);/.test(editor));
  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  check("the socket reports whether a grant was sent", /export function sendSetAgentTools\([^)]*\): boolean \{\s*return send\(/.test(socket));
}

console.log("\na server's name stops where the server would cut it");
{
  const kept = /export const MAX_LABEL_CHARS = (\d+);/.exec(
    readFileSync(fileURLToPath(new URL("../../../server/src/mcpText.ts", import.meta.url)), "utf8"),
  )?.[1];
  check("the panel's limit is the server's", Number(kept) === MCP_LABEL_MAX, `${kept} vs ${MCP_LABEL_MAX}`);
  seed(useMcpStore, { formOpen: true, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const connect = markup(React.createElement(ConnectForm));
  check("connecting takes no longer a name than is kept", new RegExp(`name="mcp-server-label"[^>]*maxLength="${MCP_LABEL_MAX}"|maxLength="${MCP_LABEL_MAX}"[^>]*name="mcp-server-label"`, "i").test(connect), connect.match(/<input[^>]*mcp-server-label[^>]*>/)?.[0] ?? "");
  seed(useMcpStore, { formOpen: false });
  const editing = markup(React.createElement(EditServerForm, { server: server(), onDone: () => {} }));
  check("...and neither does renaming", new RegExp(`name="mcp-server-edit-label"[^>]*maxLength="${MCP_LABEL_MAX}"|maxLength="${MCP_LABEL_MAX}"[^>]*name="mcp-server-edit-label"`, "i").test(editing), editing.match(/<input[^>]*mcp-server-edit-label[^>]*>/)?.[0] ?? "");
}

console.log("\nan address that could never connect is caught in the form, before anything is sent");
{
  const store = useMcpStore.getState();
  store.clearAdd();
  const sent: unknown[][] = [];
  const bare = startAdd({ endpoint: "127.0.0.1:8931/mcp", label: "", token: "" }, (...args) => (sent.push(args), true));
  check("an address with no scheme is not sent", bare === "invalid" && sent.length === 0);
  check("...and nothing is left waiting on an answer", useMcpStore.getState().pendingAdd === null);
  check("nor is one with a scheme that is not http", startAdd({ endpoint: "ftp://example.com/mcp", label: "", token: "" }, (...args) => (sent.push(args), true)) === "invalid" && sent.length === 0);

  seed(useMcpStore, { formOpen: true, draft: { endpoint: "mcp.example.com/mcp", label: "" }, pendingAdd: null, tokenDropped: false });
  const hinted = markup(React.createElement(ConnectForm));
  check("the form says what is wrong while it is still being typed", /data-mcp-endpoint-problem[^>]*>This address has no scheme/.test(hinted), hinted.slice(0, 300));
  check("...offers the address it probably meant", />Use https:\/\/mcp\.example\.com\/mcp<\/button>/.test(hinted));
  check("...and marks the field", /<input[^>]*aria-invalid="true"[^>]*name="mcp-server-endpoint"|name="mcp-server-endpoint"[^>]*aria-invalid="true"/.test(hinted));
  seed(useMcpStore, { draft: { endpoint: "https://mcp.example.com/mcp", label: "" } });
  const fine = markup(React.createElement(ConnectForm));
  check("a good address is left alone", !/data-mcp-endpoint-problem/.test(fine) && /aria-invalid="false"/.test(fine));
  seed(useMcpStore, { draft: { endpoint: "htt", label: "" } });
  check("and so is one still being started", !/data-mcp-endpoint-problem/.test(markup(React.createElement(ConnectForm))));
  seed(useMcpStore, { formOpen: false, draft: { endpoint: "", label: "" } });

  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("pressing Connect on a bad address shows the reason as an alert", /setAttempted\(started === "invalid"\);/.test(source) && /role=\{attempted \? "alert" : "status"\}/.test(source));
}

console.log("\na server just added stays selected until the list names it");
{
  const store = useMcpStore.getState();
  const alpha = server();
  const beta = server({ id: "beta", label: "Beta", tools: [tool("send_message")] });
  const gamma = server({ id: "gamma_example", label: "gamma_example", status: "connecting", discovered_at: null });
  const adding = (endpoint = "https://gamma.example/mcp", serverId = "gamma_example"): void => {
    store.clearAdd();
    startAdd({ endpoint, label: "", token: "" }, () => true);
    store.settleAdd(useMcpStore.getState().pendingAdd?.ref ?? "", { serverId });
  };
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [alpha, beta], selectedId: "beta", awaited: null, formOpen: false, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  adding();
  const waiting = useMcpStore.getState();
  check("the new server is selected before the list has it", waiting.selectedId === "gamma_example" && awaitedServer(waiting)?.endpoint === "https://gamma.example/mcp");
  seed(useMcpStore, { selectedId: waiting.selectedId, awaited: waiting.awaited });
  const html = markup(React.createElement(McpPanel));
  check("the panel does not fall back to another server", !/>send_message</.test(html) && !/data-mcp-picker="(alpha|beta)"/.test(html));
  check("...it shows the new one as connecting", html.includes("Connecting to gamma.example") && /data-mcp-picker="gamma_example"[^>]*aria-label="Server: gamma\.example, connecting…\. Choose another"/.test(html), html.slice(0, 200));

  store.setServers([alpha, beta, gamma]);
  const listed = useMcpStore.getState();
  check("once the list has it nothing is awaited, and it is still the one selected", listed.awaited === null && listed.selectedId === "gamma_example");
  seed(useMcpStore, { servers: listed.servers, awaited: null });
  check("...and the panel shows it as any other server", /data-mcp-picker="gamma_example"[^>]*aria-label="Server: gamma_example, connecting…\. Choose another"/.test(markup(React.createElement(McpPanel))));

  seed(useMcpStore, { servers: [alpha, beta], selectedId: "beta", awaited: null });
  adding();
  store.select("alpha");
  check("choosing another server stops the wait", useMcpStore.getState().awaited === null && useMcpStore.getState().selectedId === "alpha");
  adding();
  store.setDiscovered("gamma_example");
  check("a check that ends without the server ever being listed stops it too", useMcpStore.getState().awaited === null);
  adding();
  store.forgetDiscovering();
  check("and so does a reconnect", useMcpStore.getState().awaited === null);
  adding("https://alpha.example/mcp", "alpha");
  check("a server the list already has is not waited for", useMcpStore.getState().awaited === null && useMcpStore.getState().selectedId === "alpha");
  seed(useMcpStore, { servers: [], selectedId: null, awaited: null, formOpen: false, pendingAdd: null });
}

console.log("\nthe limit card goes once the workspace is under its limit again");
{
  const three = [server(), server({ id: "beta", label: "Beta" }), server({ id: "gamma", label: "Gamma" })];
  const quota = { error: "quota_exceeded" as const, kind: "mcp_servers", current: 3, limit: 3, tier: "free", upgradeUrl: "/billing", unlocks: "pro", unlocksLabel: "Pro" };
  useMcpStore.getState().setServers(three);
  useEntitlementStore.getState().refuse("mcp", quota);
  useMcpStore.getState().setServers(three);
  check("the same list leaves the card up", useEntitlementStore.getState().refusal !== null);
  useMcpStore.getState().setServers(three.slice(0, 2));
  check("disconnecting a server puts it away", useEntitlementStore.getState().refusal === null && useEntitlementStore.getState().channel === null);

  useMcpStore.getState().setServers(three);
  useEntitlementStore.getState().refuse("gen", { ...quota, kind: "agents" });
  useMcpStore.getState().setServers(three.slice(0, 2));
  check("a limit on something else is not cleared by it", useEntitlementStore.getState().refusal?.kind === "agents");
  useEntitlementStore.getState().clear();

  useMcpStore.getState().setServers([...three, server({ id: "delta", label: "Delta" })]);
  useEntitlementStore.getState().refuse("mcp", quota);
  useMcpStore.getState().setServers(three);
  check("a workspace still at its limit keeps the card", useEntitlementStore.getState().refusal !== null);
  useEntitlementStore.getState().clear();
  useMcpStore.getState().setServers([]);
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\na plan limit is said once, on its card");
{
  const store = useMcpStore.getState();
  store.clearAdd();
  seed(useMcpStore, { formOpen: true, draft: { endpoint: "https://fourth.example/mcp", label: "" }, pendingAdd: null, tokenDropped: false });
  startAdd({ endpoint: "https://fourth.example/mcp", label: "", token: "" }, () => true);
  store.settleAdd(useMcpStore.getState().pendingAdd?.ref ?? "", { message: null });
  const refused = useMcpStore.getState();
  check("a refusal the card carries keeps the form open", refused.pendingAdd?.state === "refused" && refused.formOpen && refused.draft.endpoint === "https://fourth.example/mcp");
  check("...with no line of its own to repeat it", refused.pendingAdd?.message === null);
  store.clearAdd();
  seed(useMcpStore, { formOpen: false, draft: { endpoint: "", label: "" } });

  const socket = readFileSync(fileURLToPath(new URL("../lib/socket.ts", import.meta.url)), "utf8");
  const mcp = /case "mcp": \{[\s\S]*?\n {4}\}\n/.exec(socket)?.[0] ?? "";
  check("the socket knows a refusal that arrived with a card", /const carded = carried !== undefined && isRefusal\(carried\);/.test(mcp));
  check("...and holds the toast back only while that card is on screen", /const cardShown = carded && useUiStore\.getState\(\)\.rightPanelOpen && useUiStore\.getState\(\)\.rightTab === "mcp";/.test(mcp));
}

console.log("\nremoving a server that never connected says so plainly");
{
  const never = server({ status: "error", discovered_at: null, last_error: "not a valid URL" });
  const said = removalConsequences(never, []);
  check("it does not count tools it never had", !/0 discovered tools/.test(said) && !/Nothing brings them back/.test(said), said);
  check("...it says it never connected", said === "Remove Alpha? It never connected, so it has no tools to lose.", said);
  const keyed = removalConsequences({ ...never, configured: true }, []);
  check("a credential stored for it is still named", /no tools to lose, and its stored credential is deleted with it\.$/.test(keyed), keyed);
  const emptied = removalConsequences(server({ tools: [] }), []);
  check("a server that connected and offers nothing keeps the full wording", /removes 0 discovered tools\. Nothing brings them back/.test(emptied), emptied);
  seed(useBuildStore, { agents: [] });
  const ask = markup(React.createElement(RemovalConfirm, { server: never, onKeep: () => {} }));
  check("the question shows that wording, with the same two answers", ask.includes("It never connected") && /Disconnect Alpha/.test(ask) && /Keep it/.test(ask));
}

console.log("\na server in trouble can be seen without opening it");
{
  const healthy = server({ tools: [tool("read_page"), tool("delete_record", { impact: "high", computed_impact: "high" }), tool("send_message", { impact: "high", computed_impact: "high" })] });
  const down = server({ id: "beta", label: "Beta", status: "unreachable", tools: [tool("search", { override_voided: true })] });
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [healthy, down], selectedId: null, awaited: null, formOpen: false });
  const html = markup(React.createElement(McpPanel));
  check("the header says a server needs attention, in words a screen reader gets", /<span role="img" aria-label="1 server needs attention" title="1 server needs attention" data-mcp-attention/.test(html));
  check("with nothing chosen yet the panel opens on the one in trouble", /data-mcp-picker="beta"/.test(html));
  seed(useMcpStore, { selectedId: "alpha" });
  check("a server somebody chose stays chosen", /data-mcp-picker="alpha"/.test(markup(React.createElement(McpPanel))));
  seed(useMcpStore, { servers: [healthy], selectedId: null });
  check("a healthy workspace carries no mark", !/data-mcp-attention/.test(markup(React.createElement(McpPanel))));

  const row = markup(React.createElement(McpServerFacts, { server: healthy }));
  check("a row in the picker names the server and its status", />Alpha<\/span>/.test(row) && />connected<\/span>/.test(row), row);
  check("...how many of its tools ask first", /title="2 tools ask first"/.test(row));
  check("...and how many tools it has", /title="3 tools"[^>]*>3<\/span>/.test(row));
  check("...with no review mark when nothing needs review", !/need(s)? review/.test(row));
  const troubled = markup(React.createElement(McpServerFacts, { server: down }));
  check("a server with a voided override says a tool needs review", /title="1 tool needs review"/.test(troubled) && />unreachable<\/span>/.test(troubled), troubled);
  check("...and carries no asks first mark it has not earned", !/ask(s)? first/.test(troubled));
  const picker = readFileSync(fileURLToPath(new URL("./McpServerPicker.tsx", import.meta.url)), "utf8");
  check("the menu lists servers needing attention first", /orderServers\(servers\)\.map\(\(server\) => \(/.test(picker));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\nfocus lands somewhere useful after a disconnect");
{
  const alpha = server();
  const beta = server({ id: "beta", label: "Beta" });
  const at = Date.now();
  check("nothing has left while the server is still listed", !hasDeparted({ departing: { id: "beta", at }, servers: [alpha, beta] }, at));
  check("once the list drops it, it has", hasDeparted({ departing: { id: "beta", at }, servers: [alpha] }, at));
  check("a removal nobody here asked for moves no focus", !hasDeparted({ departing: null, servers: [alpha] }, at));
  check("...and neither does one asked for long ago", !hasDeparted({ departing: { id: "beta", at }, servers: [alpha] }, at + DEPARTURE_FOCUS_MS + 1));
  useMcpStore.getState().noteDeparting("beta");
  check("pressing Disconnect notes which server is leaving", useMcpStore.getState().departing?.id === "beta");
  useMcpStore.getState().noteDeparting(null);
  check("...and the note is cleared once focus has moved", useMcpStore.getState().departing === null);

  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const confirm = /export function RemovalConfirm\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
  check("the note is made only when the removal was sent", /if \(!sendRemoveMcpServer\(server\.id\)\) \{\s*setFailed\(true\);\s*return;\s*\}\s*useMcpStore\.getState\(\)\.noteDeparting\(server\.id\);/.test(confirm));
  check("focus goes to the picker, or to Connect a server when no server is left", /querySelector<HTMLElement>\("\[data-mcp-picker\], \[data-mcp-connect\]"\)\?\.focus\(\)/.test(source));
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [alpha], selectedId: null, awaited: null, formOpen: false });
  const some = markup(React.createElement(McpPanel));
  check("the picker comes before the connect button, so it is the one found first", some.indexOf("data-mcp-picker") > 0 && some.indexOf("data-mcp-picker") < some.indexOf("data-mcp-connect"));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\nthe server on screen says which server it is");
{
  const long = `Internal ${"Tools ".repeat(12)}Gateway`;
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server({ label: long, status: "unreachable", tools: [tool("read_page")] })], selectedId: null, awaited: null, formOpen: false });
  const html = markup(React.createElement(McpPanel));
  const title = /<h2[^>]*data-mcp-server-title[^>]*>(.*?)<\/h2>/s.exec(html);
  check("its name heads its own detail, as a heading", title?.[1] === long, title?.[0]?.slice(0, 200));
  check("...in full, wrapping rather than cut off", /\[overflow-wrap:anywhere\]/.test(title?.[0] ?? "") && !/truncate/.test(title?.[0] ?? ""));
  check("...with its status beside it, as a word", /<\/h2>.*?title="unreachable".*?>unreachable<\/span>/s.test(html));
  check("the heading comes before the address", html.indexOf("data-mcp-server-title") < html.indexOf("https://alpha.example/mcp"));
  seed(useSessionStore, sessionAs("member"));
  check("a member reads the same heading", /<h2[^>]*data-mcp-server-title/.test(markup(React.createElement(McpPanel))));
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\na server's address can be read");
{
  const address = `https://mcp.example.com/${"segment/".repeat(20)}mcp`;
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server({ endpoint: address, configured: true, credential_store: "kms" })], selectedId: null, awaited: null, formOpen: false });
  const html = markup(React.createElement(McpPanel));
  const line = /<p[^>]*data-mcp-endpoint[^>]*>.*?<\/p>/s.exec(html)?.[0] ?? "";
  check("it has a line of its own, whole", line.includes(`>${address}<`), line.slice(0, 200));
  check("...set as the identifier it is", /font-mono/.test(line));
  check("...in the grey that meets contrast, not the faint one", /text-muted/.test(line) && !/text-faint/.test(line));
  check("...and breaks where it has to rather than running off the panel", /\[overflow-wrap:anywhere\]/.test(line));
  check("the stored credential badge no longer shares its line", html.indexOf("data-mcp-endpoint") < html.indexOf("credential stored") && !/data-mcp-endpoint[^<]*<[^>]*>credential stored/.test(html));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\nthe standing reminder costs one sentence, with the rest a press away");
{
  const headline = "MCP servers are third-party code Jaroku has not reviewed.";
  const rest = "What a server says it can do is its own claim.";
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server({ tools: [tool("read_page")] })], selectedId: null, awaited: null, formOpen: false });
  const working = markup(React.createElement(McpPanel));
  check("with a server on screen the first sentence is still there", working.includes(headline));
  check("...and the rest is folded away", !working.includes(rest));
  check("...behind a control that says it is closed", /<button[^>]*aria-expanded="false"[^>]*>Why this matters<\/button>/.test(working), working.slice(0, 400));
  seed(useMcpStore, { formOpen: true });
  const connecting = markup(React.createElement(McpPanel));
  check("the whole of it is shown while a server is being connected", connecting.includes(headline) && connecting.includes(rest) && !/Why this matters/.test(connecting));
  seed(useMcpStore, { servers: [], formOpen: false });
  const empty = markup(React.createElement(McpPanel));
  check("...and while there is no server yet", empty.includes(rest) && !/Why this matters/.test(empty));
  check("a banner told to show everything offers nothing to unfold", !/<button/.test(markup(React.createElement(TrustBanner, { full: true }))));
  seed(useSessionStore, sessionAs("member"));
  seed(useMcpStore, { servers: [server()] });
  check("a member reads the same sentence", markup(React.createElement(McpPanel)).includes(headline));
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\na server shows one form at a time");
{
  check("pressing a closed form's button opens it", toggledForm(null, "edit") === "edit");
  check("...pressing it again closes it", toggledForm("edit", "edit") === null);
  check("...and pressing another's swaps one for the other", toggledForm("edit", "credential") === "credential" && toggledForm("credential", "disconnect") === "disconnect");
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const detail = /function ServerDetail\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
  check("the detail holds a single open form", (detail.match(/useState<DetailForm \| null>\(null\)/g) ?? []).length === 1 && !/setShowToken|setEditing|setConfirming/.test(detail));
  for (const form of ["edit", "disconnect", "credential-removal", "credential"]) {
    check(`the ${form} form is drawn only while it is the open one`, detail.includes(`{open === "${form}" && `));
  }
  check("keeping a credential goes back to the form it was asked from", /onKeep=\{\(\) => setOpen\("credential"\)\}/.test(detail));
  check("a credential typed and then left for another form is not kept", /if \(open === "credential" \|\| open === "credential-removal"\) return;\s*setToken\(""\);\s*setCredentialError\(null\);/.test(detail));
}

console.log("\na button that has opened something looks pressed");
{
  check("the pressed look is keyed on the state a screen reader is told", PRESSED_OPEN.split(" ").every((cls) => cls.startsWith("aria-expanded:")) && /aria-expanded:bg-active/.test(PRESSED_OPEN) && /aria-expanded:text-ink/.test(PRESSED_OPEN));
  check("every control in a server's row carries it", controlBtn.includes(PRESSED_OPEN));
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server()], selectedId: null, awaited: null, formOpen: true, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const html = markup(React.createElement(McpPanel));
  const toggles = [...html.matchAll(/<button[^>]*aria-expanded="(?:true|false)"[^>]*>/g)].map((m) => m[0]).filter((b) => !/data-mcp-picker/.test(b) && !/Why this matters/.test(b));
  check("the panel has buttons that open things", toggles.length >= 3, String(toggles.length));
  check("...and each of them has a pressed look for when it has", toggles.every((b) => /aria-expanded:bg-(active|chrome)/.test(b) && /aria-expanded:text-ink/.test(b)), toggles.find((b) => !/aria-expanded:bg-/.test(b)) ?? "");
  check("Connect a server reads as pressed while its form is open", /<button[^>]*data-mcp-connect[^>]*aria-expanded="true"[^>]*class="[^"]*aria-expanded:bg-chrome/.test(html) || /<button[^>]*class="[^"]*aria-expanded:bg-chrome[^"]*"[^>]*data-mcp-connect[^>]*aria-expanded="true"/.test(html) || /<button[^>]*data-mcp-connect[^>]*>/.exec(html)?.[0].includes('aria-expanded="true"') === true);
  seed(useMcpStore, { servers: [], selectedId: null, formOpen: false });
}

console.log("\na server's controls fit on one row");
{
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [server({ tools: [tool("read_page")] })], selectedId: null, awaited: null, formOpen: false });
  const html = markup(React.createElement(McpPanel));
  const more = /<button[^>]*data-mcp-more[^>]*>/.exec(html)?.[0] ?? "";
  check("edit and disconnect sit behind one menu button", more.length > 0 && !/>edit<\/button>/.test(html) && !/>disconnect<\/button>/.test(html));
  check("...which is named, and titled for a pointer", /aria-label="More for Alpha"/.test(more) && /title="Edit or disconnect"/.test(more), more);
  check("...and says it opens a menu", /aria-haspopup="menu"/.test(more));
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const detail = /function ServerDetail\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
  const row = /<div className="mt-2 flex items-center gap-2">[\s\S]*?<\/DropdownMenu>\s*<\/div>/.exec(detail)?.[0] ?? "";
  check("the row no longer wraps, so no control is left alone on a second line", row.length > 0 && !/flex-wrap/.test(row));
  check("disconnect is still marked as the one that removes something", /<DropdownMenuItem size="compact" tone="danger" onSelect=\{\(\) => openFromMenu\("disconnect"\)\}>/.test(row));
  check("a form opened from the menu takes the focus the menu would have taken back", /handingFocus\.current = open !== form;/.test(detail) && /if \(!handingFocus\.current\) return;\s*handingFocus\.current = false;\s*e\.preventDefault\(\);/.test(detail));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\nthe next step for a server's status is the first button, and the loud one");
{
  check("a server that needs a credential is asked for one", nextStep({ status: "auth_required", discovered_at: null }) === "credential");
  check("one whose address never worked is sent to fix it", nextStep({ status: "error", discovered_at: null }) === "address");
  check("one that broke after connecting is checked again", nextStep({ status: "error", discovered_at: "2026-11-07T10:00:00.000Z" }) === "recheck");
  check("...as is one that cannot be reached", nextStep({ status: "unreachable", discovered_at: null }) === "recheck");
  check("a healthy server has no next step to push", nextStep({ status: "connected", discovered_at: "2026-11-07T10:00:00.000Z" }) === null && nextStep({ status: "connecting", discovered_at: null }) === null);
  check("the loud button is the ink one, and no shorter than the others", /bg-ink/.test(nextBtn) && /min-h-6/.test(nextBtn) && !/bg-ink/.test(controlBtn));

  const controls = (patch: Partial<McpServer>): string[] => {
    seed(useSessionStore, sessionAs("admin"));
    seed(useMcpStore, { servers: [server(patch)], selectedId: null, awaited: null, formOpen: false, discovering: {} });
    const html = markup(React.createElement(McpPanel));
    const row = /<div class="mt-2 flex items-center gap-2">.*?data-mcp-more/s.exec(html)?.[0] ?? "";
    return [...row.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].map((m) => `${/data-mcp-next="([a-z]+)"/.exec(m[1] ?? "")?.[1] ?? "-"}:${(m[2] ?? "").replace(/<[^>]*>/g, "")}`);
  };
  const locked = controls({ status: "auth_required", discovered_at: null, last_error: "a bearer token is required" });
  check("needing a credential puts add a credential first", locked[0] === "credential:add a credential" && locked[1] === "-:re-check", locked.join(" | "));
  const typo = controls({ status: "error", discovered_at: null, last_error: "could not find the host" });
  check("an address that never worked puts fix the address first", typo[0] === "address:fix the address" && typo[1] === "-:re-check", typo.join(" | "));
  const down = controls({ status: "unreachable", last_error: "timed out" });
  check("an unreachable server keeps re-check first", down[0] === "recheck:re-check" && down[1] === "-:add a credential", down.join(" | "));
  const healthy = controls({});
  check("a connected server has no loud button", healthy.join(" | ") === "-:re-check | -:add a credential", healthy.join(" | "));
  seed(useSessionStore, sessionAs("member"));
  seed(useMcpStore, { servers: [server({ status: "auth_required" })] });
  check("a member is offered none of them", !/data-mcp-next/.test(markup(React.createElement(McpPanel))));
  seed(useSessionStore, sessionAs("admin"));
  seed(useMcpStore, { servers: [], selectedId: null });
}

console.log("\nthe connect form gives each field the panel's width");
{
  seed(useMcpStore, { formOpen: true, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const form = markup(React.createElement(ConnectForm));
  const fields = ["mcp-server-endpoint", "mcp-server-label", "mcp-server-token"].map((name) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(form)?.[0] ?? "");
  check("all three fields are there", fields.every((f) => f.length > 0));
  check("each is as wide as the form", fields.every((f) => /class="[^"]*\bw-full\b/.test(f) && !/flex-1/.test(f)), fields.find((f) => !/\bw-full\b/.test(f)) ?? "");
  check("...and as tall as the buttons beside none of them", fields.every((f) => /\bh-8\b/.test(f)));
  const actions = /<div data-mcp-form-actions[^>]*>.*?<\/div>/s.exec(form)?.[0] ?? "";
  check("Connect and Cancel have a row of their own", />Connect<\/button>/.test(actions) && />Cancel<\/button>/.test(actions) && !/<input/.test(actions), actions);
  check("...at the fields' height", (actions.match(/\bh-8\b/g) ?? []).length === 2);
  check("the fields come before the buttons, in the order they are filled in", form.indexOf("mcp-server-endpoint") < form.indexOf("mcp-server-label") && form.indexOf("mcp-server-label") < form.indexOf("mcp-server-token") && form.indexOf("mcp-server-token") < form.indexOf("data-mcp-form-actions"));
  seed(useMcpStore, { formOpen: false });
}

console.log("\nevery field keeps a label that stays once something is typed");
{
  const labelled = (html: string, name: string): string | null => {
    const id = new RegExp(`<input[^>]* id="([^"]+)"[^>]*name="${name}"|<input[^>]*name="${name}"[^>]* id="([^"]+)"`).exec(html);
    const key = id?.[1] ?? id?.[2];
    if (!key) return null;
    return new RegExp(`<label[^>]*for="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>(.*?)</label>`, "s").exec(html)?.[1] ?? null;
  };
  seed(useMcpStore, { formOpen: true, draft: { endpoint: "https://typed.example/mcp", label: "Typed" }, pendingAdd: null, tokenDropped: false });
  const connect = markup(React.createElement(ConnectForm));
  check("the address field is labelled Server URL", labelled(connect, "mcp-server-endpoint") === "Server URL", String(labelled(connect, "mcp-server-endpoint")));
  check("the name field says it is optional", labelled(connect, "mcp-server-label") === "Name (optional)");
  check("the token field says when it is needed", labelled(connect, "mcp-server-token") === "Token, if the server needs one");
  check("a hint that only repeated the label is gone", !/placeholder="name \(optional\)"/.test(connect) && !/placeholder="token/.test(connect));
  check("...and the address keeps its example", /placeholder="https:\/\/example\.com\/mcp"/.test(connect));
  seed(useMcpStore, { formOpen: false, draft: { endpoint: "", label: "" } });

  const edit = markup(React.createElement(EditServerForm, { server: server(), onDone: () => {} }));
  check("renaming labels its name field", labelled(edit, "mcp-server-edit-label") === "Name");
  check("...and its address field", labelled(edit, "mcp-server-edit-endpoint") === "Server URL");
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("the credential field is labelled too", /<FieldLabel htmlFor=\{`\$\{fieldId\}-credential`\} first>Credential<\/FieldLabel>/.test(source) && /id=\{`\$\{fieldId\}-credential`\}\s*name="mcp-server-credential"/.test(source));
  check("each form makes its own ids, so two servers' forms never share one", (source.match(/const fieldId = useId\(\);/g) ?? []).length === 3);
}

console.log("\nan MCP field is drawn as a Secrets field is");
{
  const secrets = readFileSync(fileURLToPath(new URL("./SecretsPanel.tsx", import.meta.url)), "utf8");
  for (const cls of ["rounded-input", "border-edge", "bg-elevated", "px-2.5", "py-1.5", "text-caption", "text-ink", "placeholder:text-faint"]) {
    check(`${cls} is shared with the Secrets panel's inputs`, FIELD.split(" ").includes(cls) && secrets.includes(cls));
  }
  check("no MCP field is set smaller than a Secrets one", !FIELD.split(" ").includes("text-tiny") && !FIELD.split(" ").includes("py-1") && !FIELD.split(" ").includes("px-2"));
  check("an address or a credential is set in mono, as a key is", FIELD_MONO === `${FIELD} font-mono`);
  seed(useMcpStore, { formOpen: true, draft: { endpoint: "", label: "" }, pendingAdd: null, tokenDropped: false });
  const connect = markup(React.createElement(ConnectForm));
  const cls = (html: string, name: string): string => /class="([^"]*)"/.exec(new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? "")?.[1] ?? "";
  check("the connect form's address is mono", cls(connect, "mcp-server-endpoint") === FIELD_MONO);
  check("...its name is not, being words", cls(connect, "mcp-server-label") === FIELD);
  check("...and its token is", cls(connect, "mcp-server-token") === FIELD_MONO);
  seed(useMcpStore, { formOpen: false });
  const edit = markup(React.createElement(EditServerForm, { server: server(), onDone: () => {} }));
  check("the edit form follows the same rule", cls(edit, "mcp-server-edit-label") === FIELD && cls(edit, "mcp-server-edit-endpoint") === FIELD_MONO);
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  check("no MCP field spells out a style of its own", !/<(input|SecretField)\b(?:(?!\/>)[\s\S])*?className="[^"]*rounded-input/.test(source.replace(/name="mcp-tool-filter"[\s\S]*?\/>/, "")));
}

console.log("\nthe credential field has the form's width to itself");
{
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const form = /\{open === "credential" && \(\s*<form[\s\S]*?<\/form>/.exec(source)?.[0] ?? "";
  const field = /<SecretField[\s\S]*?\/>/.exec(form)?.[0] ?? "";
  check("the field is full width, not one of four things on a row", /className=\{FIELD_MONO\}/.test(field) && !/flex-1/.test(field), field);
  const actions = /<div data-mcp-form-actions[\s\S]*?<\/div>/.exec(form)?.[0] ?? "";
  check("Save, Remove and Cancel sit on a row beneath it", /Save/.test(actions) && /Remove/.test(actions) && /Cancel/.test(actions) && !/SecretField/.test(actions));
  check("...in that order, after the field", form.indexOf("<SecretField") < form.indexOf("data-mcp-form-actions") && actions.indexOf("Save") < actions.indexOf("Remove") && actions.indexOf("Remove") < actions.indexOf("Cancel"));
  check("a refusal is said between the field and its buttons", form.indexOf("{credentialError && (") > form.indexOf("<SecretField") && form.indexOf("{credentialError && (") < form.indexOf("data-mcp-form-actions"));
  check("its hint is whole, with room to be", /placeholder="bearer token or API key"/.test(field));
}

console.log("\nevery form on a server says what it is");
{
  const source = readFileSync(fileURLToPath(new URL("./McpPanel.tsx", import.meta.url)), "utf8");
  const credential = /\{open === "credential" && \(\s*<form[\s\S]*?>/.exec(source)?.[0] ?? "";
  check("the credential form is named for its server", /aria-label=\{`Credential for \$\{server\.label\}`\}/.test(credential), credential);
  const edit = markup(React.createElement(EditServerForm, { server: server(), onDone: () => {} }));
  check("as the edit form is", /<form[^>]*aria-label="Edit Alpha"/.test(edit));
  seed(useBuildStore, { agents: [] });
  const removal = markup(React.createElement(RemovalConfirm, { server: server(), onKeep: () => {} }));
  check("...and the disconnect question", /role="group" aria-label="Disconnect Alpha\?"/.test(removal));
  const forms = [...source.matchAll(/<form\b[\s\S]*?>/g)].map((m) => m[0]);
  check("no form in the panel is left without a name", forms.length === 3 && forms.every((f) => /aria-label=/.test(f)), String(forms.length));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
