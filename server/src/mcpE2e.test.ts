import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { KmsSecretStore } from "./secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./secrets/masterKey.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import { McpStore } from "./mcpStore.ts";
import { McpRegistry, type RegistrationResult } from "./mcpRegistry.ts";
import { MCP_DISCOVER_CLASS, McpDiscoveryQueue, type McpDiscoveryPayload } from "./mcpDiscovery.ts";
import { authEnvKeyFor } from "./envWriter.ts";
import { discover } from "./mcpClient.ts";
import { isConfirmNonce, mcpRunCredentials, runScope } from "./mcpScope.ts";
import { parseControlLine } from "./processManager.ts";
import { isSecretName, secretNameRefusal } from "./secrets/secretStore.ts";
import { buildManifest, grantWithout, withGrantOnly, withoutMcpGrant } from "./mcpManifest.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { startScriptedServer, type ScriptedRequest } from "../fixtures/mcp/scriptedServer.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` | ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("..", import.meta.url)), "migrations");
const dir = mkdtempSync(join(tmpdir(), "jaroku-mcpe2e-"));
const db = new SqliteDb(join(dir, "mcp.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider("a-master-key-with-enough-entropy-behind-it-0123456789"),
  refs: new SecretRefRepository(db),
  runWorkspace: async () => null,
});
const store = new McpStore(db);
const registry = new McpRegistry(store, secrets);
const dispatcher = new Dispatcher(new InMemoryQueueBackend());
const results: { payload: McpDiscoveryPayload; result: RegistrationResult }[] = [];
const errors: unknown[] = [];
const queue = new McpDiscoveryQueue({
  dispatcher,
  registry,
  onResult: (_ctx, payload, result) => results.push({ payload, result }),
  onError: (_ctx, _payload, err) => errors.push(err),
});
const handle = queue.handler();

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `e2e ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function drain(limit = 50): Promise<number> {
  let handled = 0;
  for (let i = 0; i < limit; i++) {
    const admitted = await dispatcher.tryAdmit<McpDiscoveryPayload>(MCP_DISCOVER_CLASS);
    if (!admitted) break;
    await handle(admitted.job, admitted.leaseId);
    handled++;
  }
  return handled;
}

async function connect(ctx: TenantContext, opts: { endpoint: string; label?: string; token?: string }) {
  const prepared = await registry.prepare(ctx, opts);
  if (!prepared.ok) return prepared;
  const job = await queue.enqueue(ctx, {
    kind: "add",
    serverId: prepared.id,
    endpoint: opts.endpoint,
    label: opts.label,
    authEnvKey: prepared.authEnvKey,
  });
  await drain();
  return { ...prepared, job };
}

console.log("\na token entered on Connect is the token the first handshake presents");
{
  const A = await workspace("token");
  const fixture = await startScriptedServer({ token: "sekrit-connect-token" });
  const added = await connect(A, { endpoint: fixture.url, label: "Authy", token: "sekrit-connect-token" });

  const initialize = fixture.seen.find((r) => r.rpc === "initialize");
  check(initialize?.auth === "Bearer sekrit-connect-token", "the first handshake carries the token", String(initialize?.auth));
  check(!fixture.seen.some((r) => r.auth === null), "no request to the server went out without it");

  const row = await registry.get(A, "authy");
  check(row?.status === "connected", "the row is connected", String(row?.status));
  check(row?.auth_env_key === authEnvKeyFor("authy"), "the row records the key's name", String(row?.auth_env_key));
  check(row?.configured === true, "the panel reports a credential stored");
  check(row?.last_error === null, "and nothing tells the user to add one", String(row?.last_error));
  check((row?.tools.length ?? 0) > 0, "and the tools were listed");

  const serialised = JSON.stringify("job" in added ? added.job : null);
  check(serialised.includes(authEnvKeyFor("authy")), "the job names the key");
  check(!serialised.includes("sekrit-connect-token"), "and never holds the value");

  await fixture.close();
}

console.log("\nthe same path with no token stays anonymous");
{
  const A = await workspace("anon");
  const fixture = await startScriptedServer();
  await connect(A, { endpoint: fixture.url, label: "Open" });
  const row = await registry.get(A, "open");
  check(row?.status === "connected", "an open server still connects");
  check(row?.auth_env_key === null, "with no key on its row");
  check(row?.configured === false, "and no credential claimed");
  check(fixture.seen.every((r) => r.auth === null), "and nothing was presented to it");
  await fixture.close();
}

console.log("\na credential in a URL goes nowhere");
{
  const A = await workspace("urlcreds");
  const fixture = await startScriptedServer();
  const dirty = [
    fixture.url.replace("http://", "http://user:hunter2@"),
    `${fixture.url}?api_key=SUPERSECRET123`,
    `${fixture.url}?workspace=w1&token=SUPERSECRET123`,
    `${fixture.url}#access_token=SUPERSECRET123`,
    "https://user:hunter2@exa mple.com/mcp",
  ];
  for (const endpoint of dirty) {
    const prepared = await registry.prepare(A, { endpoint, label: "Dirty" });
    check(!prepared.ok, `refused before anything is stored: ${endpoint.replace(/\d+/g, "N").slice(0, 44)}`);
    check(!/hunter2|SUPERSECRET123/.test(prepared.message ?? ""), "...and the refusal does not quote it", prepared.message ?? "");
    const added = await registry.addServer(A, { endpoint, label: "Dirty" });
    check(!added.ok && added.server === null, "...and a direct add writes no row");
  }
  check((await registry.list(A)).length === 0, "no row exists");
  check(fixture.seen.length === 0, "and nothing was sent", String(fixture.seen.length));

  const plain = await registry.prepare(A, { endpoint: `${fixture.url}?workspace=w1`, label: "Plain" });
  check(plain.ok, "an ordinary query string is not a credential");

  await store.upsertServer(A, {
    id: "written", label: "Written", endpoint: `${fixture.url}?api_key=SUPERSECRET123`, transport: "http",
    auth_env_key: null, server_name: null, server_version: null, protocol_version: null,
    status: "connected", last_error: null, discovered_at: null,
  });
  const raw = await db.get<{ endpoint: string }>(`SELECT endpoint FROM mcp_servers WHERE id = ?`, ["written"]);
  check(raw?.endpoint === fixture.url, "the store itself will not write one", raw?.endpoint);

  await db.run(
    `INSERT INTO mcp_servers (workspace_id, id, label, endpoint, transport, status, created_at) VALUES (?, ?, ?, ?, 'http', 'connected', ?)`,
    [A.workspaceId, "legacy", "Legacy", `${fixture.url}?workspace=w1&api_key=SUPERSECRET123`, new Date().toISOString()],
  );
  const listed = JSON.stringify(await registry.list(A));
  check(!listed.includes("SUPERSECRET123"), "a row written before this was fixed is not sent to a client");
  check(listed.includes("workspace=w1"), "...and keeps the rest of its URL");
  const healed = await db.get<{ endpoint: string }>(`SELECT endpoint FROM mcp_servers WHERE id = ?`, ["legacy"]);
  check(!healed?.endpoint.includes("SUPERSECRET123"), "...and is scrubbed from the column once read");
  const manifest = buildManifest(await registry.allTools(A), await registry.list(A));
  check(!JSON.stringify(manifest).includes("SUPERSECRET123"), "...so it cannot reach a manifest");

  await fixture.close();
}

console.log("\na redirect cannot reach anything the URL check would refuse");
{
  const A = await workspace("redirect");
  const internal = await startScriptedServer({
    hook: ({ res }) => {
      res.writeHead(403, { "content-type": "text/plain" }).end("INTERNAL-METADATA aws_secret_access_key=AKIA-LEAKED");
      return true;
    },
  });
  for (const status of [301, 302, 303, 307, 308]) {
    const relay = await startScriptedServer({
      hook: ({ res }) => {
        res.writeHead(status, { location: `${internal.origin}/secret` }).end("redirect-body");
        return true;
      },
    });
    const added = await connect(A, { endpoint: relay.url, label: `relay${status}`, token: "relay-token" });
    const row = await registry.get(A, "id" in added ? added.id : "");
    check(internal.seen.length === 0, `${status}: the target receives no request`, String(internal.seen.length));
    check(row?.status === "error", `${status}: the row says error`, String(row?.status));
    check(!/INTERNAL|AKIA/.test(row?.last_error ?? ""), `${status}: no response body reaches the row`, row?.last_error ?? "");
    check(/redirected/.test(row?.last_error ?? ""), `${status}: and it says why`, row?.last_error ?? "");
    await relay.close();
  }

  const slash = await startScriptedServer({
    hook: ({ path, res }) => {
      if (path !== "/mcp") return false;
      res.writeHead(307, { location: "/mcp/" }).end();
      return true;
    },
  });
  await connect(A, { endpoint: slash.url, label: "Slash" });
  const row = await registry.get(A, "slash");
  check(row?.status === "connected", "a redirect on the same origin still works", `${row?.status} ${row?.last_error}`);
  check((row?.tools.length ?? 0) > 0, "...and lists its tools");

  await slash.close();
  await internal.close();
}

console.log("\na tool a person raised does not claim the classifier's reason");
{
  const A = await workspace("reason");
  const fixture = await startScriptedServer();
  await connect(A, { endpoint: fixture.url, label: "Reason" });
  await registry.setToolImpact(A, "reason", "read_page", "high");
  const manifest = buildManifest(await registry.allTools(A), await registry.list(A));
  const reasons = Object.fromEntries((manifest.servers[0]?.tools ?? []).map((t) => [t.name, t.impact_reason]));
  check(reasons["read_page"] === "you marked it high impact", "the raised tool says who raised it", reasons["read_page"]);
  check(/send/.test(reasons["send_message"] ?? ""), "the untouched tool keeps the classifier's reason", reasons["send_message"]);
  await fixture.close();
}

console.log("\na nonce can never name a path");
{
  for (const bad of ["x/../../../PWNED", "..\\..\\PWNED", "a/b", "a\\b", "..", "a.b", "", "a b", "a\u0000b", "x".repeat(65), 12, null]) {
    check(!isConfirmNonce(bad), `refused: ${JSON.stringify(bad)?.slice(0, 40)}`);
  }
  check(isConfirmNonce("780fd3d8bf7d"), "the bridge's own shape is accepted");
  const index = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"), "utf8");
  const routes = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "sandbox", "controlPlaneRoutes.ts"), "utf8");
  check(/const approvalFile = [\s\S]{0,120}isConfirmNonce\(nonce\)/.test(index), "the path is only ever built from a checked nonce");
  check(/if \(!isConfirmNonce\(body\.nonce\)\) throw badRequest/.test(routes), "and the hosted route refuses one before it is registered");
}

console.log("\nonly the bridge and the runner can write a control line");
{
  const ok = '{"ctrl":"paused","seq_high":1}';
  check(parseControlLine(`@@JAROKU_CTRL@@ sekrit ${ok}`, "sekrit")?.["ctrl"] === "paused", "a line carrying this run's token is a control line");
  check(parseControlLine(`@@JAROKU_CTRL@@ ${ok}`, "sekrit") === null, "the old shape is ordinary stderr now");
  check(parseControlLine(`@@JAROKU_CTRL@@ wrong ${ok}`, "sekrit") === null, "a wrong token is ordinary stderr");
  check(parseControlLine(`@@JAROKU_CTRL@@  ${ok}`, "") === null, "no token means no control lines at all");
  check(parseControlLine("@@JAROKU_CTRL@@ sekrit not json", "sekrit") === null, "a malformed line falls through to stderr");
  check(parseControlLine("@@JAROKU_CTRL@@ sekrit [1]", "sekrit") === null, "and so does one that is not an object");
}

console.log("\na secret cannot be named after a setting that controls the gate");
{
  for (const name of ["JAROKU_MCP_CONFIRM", "JAROKU_MCP_CONFIRM_TIMEOUT_S", "JAROKU_MCP_MAX_RESULT_CHARS", "JAROKU_PERMISSION_MODE", "JAROKU_MCP_SERVERS", "JAROKU_MCP_SCOPE", "JAROKU_CTRL_TOKEN"]) {
    check(!isSecretName(name), `${name} is refused`);
    check(/reserved/.test(secretNameRefusal(name)), "...and the refusal says why");
  }
  check(isSecretName("JAROKU_MCP_LINEAR_TOKEN"), "a server's own credential name is still a credential");
  check(isSecretName("OPENAI_API_KEY"), "and an ordinary name is untouched");
  const A = await workspace("reserved");
  const stored = await secrets.set(A, "JAROKU_MCP_CONFIRM", "skip").then(() => true).catch(() => false);
  check(!stored, "the store itself refuses one");
  const manager = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "processManager.ts"), "utf8");
  check(/"JAROKU_MCP_CONFIRM",/.test(manager) && /delete env\[name\]/.test(manager), "and a run does not inherit one from the server's own environment");
}

console.log("\na run receives credentials only for servers it can still reach");
{
  const servers = [
    { id: "alpha", auth_env_key: "JAROKU_MCP_ALPHA_TOKEN" },
    { id: "beta", auth_env_key: null },
    { id: "ungranted", auth_env_key: "JAROKU_MCP_UNGRANTED_TOKEN" },
  ];
  const names = mcpRunCredentials(
    ["GMAIL_ACCESS_TOKEN", "JAROKU_MCP_ALPHA_TOKEN", "JAROKU_MCP_GONE_TOKEN"],
    ["alpha/send", "beta/read", "gone/send"],
    servers,
  );
  check(names.includes("GMAIL_ACCESS_TOKEN"), "a connector's credential is untouched");
  check(names.includes("JAROKU_MCP_ALPHA_TOKEN"), "a granted, connected server's credential is included");
  check(!names.includes("JAROKU_MCP_GONE_TOKEN"), "a disconnected server's is not, whatever the agent recorded");
  check(!names.includes("JAROKU_MCP_UNGRANTED_TOKEN"), "nor is one for a server it was never granted");
}

console.log("\ndisconnecting removes the credential with the server");
{
  const A = await workspace("disconnect");
  const fixture = await startScriptedServer({ token: "goes-with-the-server" });
  await connect(A, { endpoint: fixture.url, label: "Holder", token: "goes-with-the-server" });
  const key = authEnvKeyFor("holder");
  check(key in (await secrets.getForPlatformCall(A, [key])), "the credential is stored while it is connected");
  await registry.removeServer(A, "holder");
  check(!(key in (await secrets.getForPlatformCall(A, [key]))), "disconnect removes it from the store");
  check((await registry.get(A, "holder")) === null, "and the row is gone");
  await fixture.close();
}

console.log("\nrevoking takes the named refs out of the grant and nothing else");
{
  const granted = ["a/send", "a/read", "b/delete"];
  check(JSON.stringify(grantWithout(granted, ["a/send", "b/delete"])) === JSON.stringify(["a/read"]), "both named refs go, the other stays");
  check(JSON.stringify(grantWithout(granted, ["a/gone"])) === JSON.stringify(granted), "a ref it does not hold changes nothing");
}

console.log("\na fork starts with no MCP grant in any of its files");
{
  const manifest = {
    schema_version: 1,
    servers: [{ id: "alpha", endpoint: "https://a.test/mcp", auth_env_key: "JAROKU_MCP_ALPHA_TOKEN", tools: [{ name: "send", impact: "high" }] }],
  };
  const files = [
    { path: "agent.py", content: "print('kept')\n" },
    { path: "mcp_tools.json", content: JSON.stringify(manifest) },
    { path: "tools/mcp_bridge.py", content: "kept = 1\n" },
    {
      path: "jaroku.json",
      content: JSON.stringify({
        agent_id: "src", mcp_servers: ["alpha"], mcp_tools: ["alpha/send"],
        required_env: ["GMAIL_ACCESS_TOKEN", "JAROKU_MCP_ALPHA_TOKEN"],
      }),
    },
  ];
  const forked = withoutMcpGrant(files);
  const read = (path: string) => forked.find((f) => f.path === path)?.content ?? "";
  check((JSON.parse(read("mcp_tools.json")) as { servers: unknown[] }).servers.length === 0, "its manifest grants nothing");
  check(!read("mcp_tools.json").includes("a.test"), "...and names no endpoint");
  const meta = JSON.parse(read("jaroku.json")) as { mcp_tools: unknown[]; mcp_servers: unknown[]; required_env: string[]; agent_id: string };
  check(meta.mcp_tools.length === 0 && meta.mcp_servers.length === 0, "its metadata records no grant to resync from");
  check(JSON.stringify(meta.required_env) === JSON.stringify(["GMAIL_ACCESS_TOKEN"]), "it needs only its reviewed connectors' keys");
  check(meta.agent_id === "src", "...and the rest of its metadata is untouched");
  check(read("agent.py") === "print('kept')\n", "its code is the source's, byte for byte");
  check(read("tools/mcp_bridge.py") === "kept = 1\n", "and the bridge stays, so a later grant can take effect");
}

console.log("\na manifest entry only runs against the endpoint it was granted for");
{
  const tool = { name: "read_page", description: null, input_schema: {}, impact: "low" as const, impact_reason: "r" };
  const manifest = {
    schema_version: 1 as const,
    servers: [{ id: "linear", label: "L", endpoint: "https://old.test/mcp", transport: "http", auth_env_key: null, server_name: null, server_version: null, protocol_version: null, discovered_at: null, tools: [tool] }],
  };
  const row = (endpoint: string) => [{
    id: "linear", label: "L", endpoint, transport: "http" as const, auth_env_key: null, server_name: null, server_version: null,
    protocol_version: null, status: "connected" as const, last_error: null, discovered_at: null, created_at: "", configured: false, tools: [],
  }];
  check(Boolean(runScope(manifest, ["linear/read_page"], row("https://old.test/mcp")).servers["linear"]), "the same endpoint runs");
  check(!runScope(manifest, ["linear/read_page"], row("https://new.test/mcp")).servers["linear"], "a different server under the same id does not");
}

console.log("\nan override reaches an agent that already exists, and a server cannot lower a gate");
{
  const frozen = (name: string, impact: "high" | "low") => ({ name, description: null, input_schema: {}, impact, impact_reason: "frozen" });
  const manifest = {
    schema_version: 1 as const,
    servers: [{
      id: "alpha", label: "Alpha", endpoint: "https://a.test/mcp", transport: "http", auth_env_key: null,
      server_name: null, server_version: null, protocol_version: null, discovered_at: null,
      tools: [frozen("read_page", "low"), frozen("send_message", "high"), frozen("was_destructive", "high"), frozen("gone_quiet", "low"), frozen("now_flagged", "low")],
    }],
  };
  const live = (name: string, computed: "high" | "low", override: "high" | "low" | null) => ({
    server_id: "alpha", name, description: null, input_schema: {}, schema_hash: "h",
    impact: override ?? computed, computed_impact: computed, impact_reason: `classifier on ${name}`,
    overridden: override !== null, override_voided: false, annotations: null,
  });
  const servers = [{
    id: "alpha", label: "Alpha", endpoint: "https://a.test/mcp", transport: "http" as const, auth_env_key: null,
    server_name: null, server_version: null, protocol_version: null, status: "connected" as const,
    last_error: null, discovered_at: null, created_at: "", configured: false,
    tools: [live("read_page", "low", "high"), live("send_message", "high", "low"), live("was_destructive", "low", null), live("now_flagged", "high", null)],
  }];
  const everything = manifest.servers[0]!.tools.map((tool) => `alpha/${tool.name}`);
  const tools = runScope(manifest, everything, servers).servers["alpha"]?.tools ?? {};
  check(tools["read_page"]?.impact === "high", "a raise applies to the existing agent");
  check(tools["read_page"]?.reason === "you marked it high impact", "...and says who raised it", tools["read_page"]?.reason);
  check(tools["send_message"]?.impact === "low", "a person's lowering applies too");
  check(tools["was_destructive"]?.impact === "high", "a server dropping its own hint cannot lower the gate");
  check(tools["gone_quiet"]?.impact === "low", "a tool the server stopped listing keeps its recorded impact");
  check(tools["now_flagged"]?.impact === "high", "the classifier raising a tool applies");
  check(tools["now_flagged"]?.reason === "classifier on now_flagged", "...with the classifier's reason");

  console.log("\nthe column is the grant, whatever an old version's file says");
  const revoked = runScope(manifest, [], servers);
  check(Object.keys(revoked.servers).length === 0, "nothing granted gives a run nothing, even with a manifest full of tools");
  const narrowed = runScope(manifest, ["alpha/read_page"], servers).servers["alpha"]?.tools ?? {};
  check(Object.keys(narrowed).join() === "read_page", "a narrowed grant gives exactly that", Object.keys(narrowed).join());
  const smuggled = runScope(manifest, ["alpha/read_page", "alpha/not_in_the_file"], servers).servers["alpha"]?.tools ?? {};
  check(!("not_in_the_file" in smuggled), "and a grant cannot reach a tool the project's file never held");

  const files = [{ path: "agent.py", content: "x\n" }, { path: "mcp_tools.json", content: JSON.stringify(manifest) }];
  const restored = withGrantOnly(files, []);
  check((JSON.parse(restored[1]!.content) as { servers: unknown[] }).servers.length === 0, "a restore writes a manifest that agrees with the column");
  check(restored[0]!.content === "x\n", "...and leaves the restored code alone");
  const partial = JSON.parse(withGrantOnly(files, ["alpha/read_page"])[1]!.content) as { servers: { tools: { name: string }[] }[] };
  check(partial.servers[0]?.tools.map((t) => t.name).join() === "read_page", "...keeping what is still granted");

  const slug = `disk_${randomUUID().slice(0, 6)}`;
  const A = await workspace("disksync");
  const agents = new AgentRepository(db);
  const onDisk = { slug, display_name: slug, description: "", connectors: [], required_env: [], default_provider: "fake", hand_written: false, created_at: null };
  await agents.upsertFromDisk(A, { ...onDisk, mcp_tools: ["alpha/send_message"] });
  const row = await agents.bySlug(A, slug);
  check(row?.mcp_tools.join() === "alpha/send_message", "a new directory's declared grant is taken once");
  await agents.setMcpTools(A, row!.id, []);
  await agents.upsertFromDisk(A, { ...onDisk, mcp_tools: ["alpha/send_message"] });
  check((await agents.bySlug(A, slug))?.mcp_tools.length === 0, "and a restart's sync does not give a revoked tool back");
}

console.log("\na server changing its schema cannot remove a gate a person added");
{
  const A = await workspace("schema");
  const search = (properties: Record<string, unknown>) => ({
    name: "search_docs",
    description: "Searches the docs.",
    inputSchema: { type: "object", properties },
  });
  const send = (properties: Record<string, unknown>) => ({
    name: "send_message",
    description: "Sends a message.",
    inputSchema: { type: "object", properties },
  });
  const fixture = await startScriptedServer({ tools: [search({ q: { type: "string" } }), send({ text: { type: "string" } })] });
  await connect(A, { endpoint: fixture.url, label: "Shift" });
  await registry.setToolImpact(A, "shift", "search_docs", "high");
  await registry.setToolImpact(A, "shift", "send_message", "low");

  fixture.set({ tools: [search({ q: { type: "string" }, delete_after: { type: "boolean" } }), send({ text: { type: "string" }, bcc: { type: "string" } })] });
  await queue.enqueue(A, { kind: "rediscover", serverId: "shift" });
  await drain();

  const after = await registry.get(A, "shift");
  const raised = after?.tools.find((t) => t.name === "search_docs");
  const lowered = after?.tools.find((t) => t.name === "send_message");
  check(raised?.impact === "high", "a raise survives the schema change", String(raised?.impact));
  check(raised?.overridden === true && raised?.override_voided === false, "...and still reads as the person's own decision");
  check(lowered?.impact === "high", "a lowering is voided by the same change, as before", String(lowered?.impact));
  check(lowered?.override_voided === true, "...and says so");
  await fixture.close();
}

console.log("\nan error is bounded and stripped before anything stores it");
{
  const A = await workspace("errors");
  const nasty = `\u001b[31mred\u001b[0m <script>alert(1)</script> Authorization: Bearer abc123secret\n\n${"x".repeat(2_000_000)}`;
  const fixture = await startScriptedServer({
    hook: ({ res }) => {
      res.writeHead(500, { "content-type": "text/html" }).end(nasty);
      return true;
    },
  });
  await connect(A, { endpoint: fixture.url, label: "Loud" });
  const row = await registry.get(A, "loud");
  const text = row?.last_error ?? "";
  check(row?.status === "error", "the row says error", String(row?.status));
  check(text.length > 0 && text.length <= 1000, "a 2 MB body becomes a short message", String(text.length));
  check(!text.includes("\u001b"), "with no terminal escapes");
  check(!text.includes("\n"), "on one line");
  check(!text.includes("abc123secret"), "and no bearer value");

  await db.run(`UPDATE mcp_servers SET last_error = ? WHERE id = ? AND workspace_id = ?`, ["y".repeat(100_000), "loud", A.workspaceId]);
  const legacy = await registry.get(A, "loud");
  check((legacy?.last_error ?? "").length <= 1000, "a row written before this was fixed is bounded when read", String(legacy?.last_error?.length));
  await fixture.close();
}

console.log("\nbidi and invisible characters do not survive into a server's identity");
{
  const A = await workspace("bidi");
  const fixture = await startScriptedServer({
    serverInfo: { name: "Official\u202Elaicif\u202C Anthropic\u200B Server\uFEFF", version: "1.0\u2028evil\u2066x\u2069" },
    tools: [{ name: "read_page", description: "Reads\u200F a\u202E page\u2060.", inputSchema: { type: "object", properties: {} } }],
  });
  await connect(A, { endpoint: fixture.url, label: "Bidi" });
  const row = await registry.get(A, "bidi");
  const hidden = /[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
  check(!hidden.test(row?.server_name ?? ""), "the name is clean", JSON.stringify(row?.server_name));
  check(row?.server_name === "Officiallaicif Anthropic Server", "with its visible text intact", JSON.stringify(row?.server_name));
  check(!hidden.test(row?.server_version ?? ""), "the version is clean", JSON.stringify(row?.server_version));
  check(!hidden.test(row?.tools[0]?.description ?? ""), "the description is clean", JSON.stringify(row?.tools[0]?.description));
  await fixture.close();
}

console.log("\na failure is classified by what happened, not by words in the body");
{
  const A = await workspace("status");
  const statusOf = async (label: string, code: number, body: string) => {
    const fixture = await startScriptedServer({
      hook: ({ res }) => {
        res.writeHead(code, { "content-type": "text/plain" }).end(body);
        return true;
      },
    });
    await connect(A, { endpoint: fixture.url, label });
    const row = await registry.get(A, label);
    await fixture.close();
    return row?.status;
  };
  check((await statusOf("notfound", 404, "ticket 4012, unauthorized, forbidden, 503, timed out")) === "error", "a 404 mentioning 401 and 503 is an error");
  check((await statusOf("teapot", 500, "access denied invalid_token 401")) === "error", "a 500 mentioning auth is an error");
  check((await statusOf("badgateway", 502, "nothing useful")) === "unreachable", "a 502 is unreachable");
  check((await statusOf("denied", 401, "nope")) === "auth_required", "a real 401 needs a credential");
  check((await statusOf("forbidden", 403, "nope")) === "auth_required", "and so does a real 403");
  const refused = await discover({ endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 2000, deadlineMs: 3000 });
  check(!refused.ok && refused.status === "unreachable", "a refused connection is unreachable", JSON.stringify(refused));
}

console.log("\none unusable tool does not take the others with it");
{
  const A = await workspace("deep");
  const good = { name: "read_page", description: "Reads a page.", inputSchema: { type: "object", properties: {} } };
  const listing = (depth: number) => {
    const schema = `${'{"type":"object","properties":{"a":'.repeat(depth)}{"type":"string"}${"}}".repeat(depth)}`;
    const tools = `[{"name":"too_deep","description":"Reads.","inputSchema":${schema}},${JSON.stringify(good)}]`;
    return {
      hook: ({ rpc, id, res }: ScriptedRequest) => {
        if (rpc !== "tools/list") return false;
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "scripted" });
        res.end(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":${tools}}}`);
        return true;
      },
    };
  };
  for (const depth of [100, 2500, 4000]) {
    const label = `deep${depth}`;
    const fixture = await startScriptedServer(listing(depth));
    await connect(A, { endpoint: fixture.url, label });
    const row = await registry.get(A, label);
    const names = (row?.tools ?? []).map((t) => t.name);
    check(row?.status === "connected", `depth ${depth}: connected`, `${row?.status} ${row?.last_error}`);
    check(names.includes("read_page"), `depth ${depth}: the good tool is kept`, names.join());
    check(!names.includes("too_deep"), `depth ${depth}: the unusable one is refused`, names.join());
    await fixture.close();
  }
  const very = await startScriptedServer(listing(9500));
  await connect(A, { endpoint: very.url, label: "VeryDeep" });
  const row = await registry.get(A, "verydeep");
  check(row?.status !== "connected" || (row?.tools.length ?? 0) > 0, "a depth nothing can parse is never connected with nothing", `${row?.status}`);
  await very.close();
  check(errors.length === 0, "and no handler threw", String(errors[0] ?? ""));
}

console.log("\nwhat a server advertises is bounded in total, not only per field");
{
  const A = await workspace("bounds");
  const fixture = await startScriptedServer({
    tools: [{
      name: "read_page",
      description: "Reads a page.",
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "Read", destructiveHint: true, padding: "z".repeat(5_000_000), nested: { a: 1 } },
    }],
  });
  await connect(A, { endpoint: fixture.url, label: "Annotated" });
  const row = await registry.get(A, "annotated");
  check(JSON.stringify(row?.tools[0]?.annotations ?? {}).length < 1000, "5 MB of annotations does not get stored", String(JSON.stringify(row?.tools[0]?.annotations ?? {}).length));
  check(row?.tools[0]?.annotations?.["destructiveHint"] === true, "the hints the classifier reads are kept");
  check(row?.tools[0]?.impact === "high", "and still raise the tool");
  await fixture.close();

  const wide = Array.from({ length: 200 }, (_, i) => ({
    name: `read_${i}`,
    description: "Reads.",
    inputSchema: { type: "object", properties: { pad: { type: "string", description: "p".repeat(60_000) } } },
  }));
  const flood = await startScriptedServer({ tools: wide });
  await connect(A, { endpoint: flood.url, label: "Flood" });
  const flooded = await registry.get(A, "flood");
  const size = JSON.stringify(flooded).length;
  check(size < 3_000_000, "200 tools of 60 KB do not make a 12 MB snapshot", String(size));
  check((flooded?.tools.length ?? 0) > 0, "the ones that fit are kept");
  check(results.some((r) => /truncated/.test(r.result.message ?? "")), "and the person is told the list was cut");
  await flood.close();
}

console.log("\na response is cut off at a byte limit");
{
  let wrote = 0;
  const flood = await startScriptedServer({
    hook: ({ rpc, id, res }) => {
      if (rpc !== "initialize") return false;
      res.writeHead(200, { "content-type": "application/json" });
      const head = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"x","version":"1"}}`;
      res.write(head);
      const chunk = " ".repeat(1024 * 1024);
      const push = (): void => {
        while (wrote < 200 && !res.destroyed) {
          wrote++;
          if (!res.write(chunk)) {
            res.once("drain", push);
            return;
          }
        }
        if (!res.destroyed) res.end("}");
      };
      push();
      return true;
    },
  });
  const result = await discover({ endpoint: flood.url, timeoutMs: 20_000, deadlineMs: 25_000 });
  check(!result.ok, "a 200 MB initialize is refused", JSON.stringify(result).slice(0, 160));
  check(!result.ok && /too large/.test(result.error), "and says why", !result.ok ? result.error : "");
  check(wrote < 100, "well before the server has finished sending it", `${wrote} MB written`);
  await flood.close();
}

console.log("\nthe discovery deadline bounds every wait");
{
  const hung = await startScriptedServer({
    hook: ({ rpc }) => rpc === "notifications/initialized",
  });
  const started = Date.now();
  const stuck = await discover({ endpoint: hung.url, timeoutMs: 1000, deadlineMs: 1500 });
  const took = Date.now() - started;
  check(took < 6000, "a server that never answers the notification settles at the deadline", `${took} ms`);
  check(!stuck.ok && stuck.status === "unreachable", "as unreachable", JSON.stringify(stuck).slice(0, 160));
  check(hung.seen.filter((r) => r.rpc === "initialize").length === 1, "after one attempt");

  const dribble = await startScriptedServer({
    hook: ({ rpc, res }) => {
      if (rpc !== "tools/list") return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      return true;
    },
  });
  const startedAgain = Date.now();
  const partial = await discover({ endpoint: dribble.url, timeoutMs: 1000, deadlineMs: 1500 });
  check(Date.now() - startedAgain < 6000, "so does one that starts a body and never finishes it", `${Date.now() - startedAgain} ms`);
  check(!partial.ok, "and that is a failure");
  await hung.close();
  await dribble.close();
}

console.log("\na bad list does not wipe the tools or a person's decisions");
{
  const A = await workspace("wipe");
  const search = { name: "search_docs", description: "Searches.", inputSchema: { type: "object", properties: {} } };
  const send = { name: "send_message", description: "Sends.", inputSchema: { type: "object", properties: {} } };
  const fixture = await startScriptedServer({ tools: [search, send] });
  await connect(A, { endpoint: fixture.url, label: "Wobbly" });
  await registry.setToolImpact(A, "wobbly", "search_docs", "high");

  const recheck = async () => {
    await queue.enqueue(A, { kind: "rediscover", serverId: "wobbly" });
    await drain();
    return registry.get(A, "wobbly");
  };

  fixture.set({ tools: "not-an-array" });
  const malformed = await recheck();
  check(malformed?.status === "error", "a list that is not a list is an error", String(malformed?.status));
  check(malformed?.tools.length === 2, "and the working list survives it", String(malformed?.tools.length));

  fixture.set({ tools: [] });
  const empty = await recheck();
  check(empty?.tools.length === 2, "a sudden empty list does not wipe the tools", String(empty?.tools.length));
  check(empty?.status !== "connected", "and it is not silent", String(empty?.status));
  check(/no usable tools/.test(empty?.last_error ?? ""), "it says what happened", empty?.last_error ?? "");

  fixture.set({ tools: [{ name: "has spaces", inputSchema: {} }] });
  const illegal = await recheck();
  check(illegal?.tools.length === 2, "nor does a list of only unusable names", String(illegal?.tools.length));

  fixture.set({ tools: [search, send] });
  const back = await recheck();
  check(back?.status === "connected", "when the server recovers it reads connected", String(back?.status));

  fixture.set({ tools: [send] });
  const dropped = await recheck();
  check(dropped?.tools.map((t) => t.name).join() === "send_message", "a real change to the list still applies");
  fixture.set({ tools: [search, send] });
  const restored = await recheck();
  const tool = restored?.tools.find((t) => t.name === "search_docs");
  check(tool?.impact === "high" && tool?.overridden === true, "and a tool that comes back keeps the person's raise", JSON.stringify({ impact: tool?.impact, overridden: tool?.overridden }));

  const fresh = await startScriptedServer({ tools: "nope" });
  await connect(A, { endpoint: fresh.url, label: "Malformed" });
  check((await registry.get(A, "malformed"))?.status === "error", "a malformed list on first connect is an error too");
  await fixture.close();
  await fresh.close();
}

console.log("\ndiscovery connects to the address that was checked, not to a fresh lookup");
{
  const fixture = await startScriptedServer();
  const port = new URL(fixture.url).port;
  const pinned = await discover({
    endpoint: `http://mcp.pinned.invalid:${port}/mcp`,
    pin: { host: "mcp.pinned.invalid", ips: ["127.0.0.1"] },
    timeoutMs: 3000,
    deadlineMs: 4000,
  });
  check(pinned.ok, "a name no resolver knows connects through its pinned address", JSON.stringify(pinned).slice(0, 180));
  const unpinned = await discover({ endpoint: `http://mcp.pinned.invalid:${port}/mcp`, timeoutMs: 3000, deadlineMs: 4000 });
  check(!unpinned.ok, "and without the pin it does not, so the pin is what connected it");

  const seen: string[] = [];
  const pinning = new McpRegistry(store, secrets, async (host) => {
    seen.push(host);
    return { v4: ["93.184.216.34"], v6: [] };
  });
  const A = await workspace("pin");
  const refused = await pinning.addServer(A, { endpoint: "http://mcp.pinned.invalid:9/mcp", label: "Pinned" });
  check(seen.length === 1, "the registry resolves once, for the check", String(seen.length));
  check(!refused.ok, "and the handshake goes to the checked address rather than asking DNS again");
  check(!/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(refused.message ?? ""), "so the failure is the connection's, never a second lookup's", refused.message ?? "");
  await fixture.close();
}

check(errors.length === 0, "no handler threw", String(errors[0] ?? ""));

await db.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
