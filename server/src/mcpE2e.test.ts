import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { withScratchPostgres } from "./db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { KmsSecretStore } from "./secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./secrets/masterKey.ts";
import { DotEnvSecretStore } from "./secrets/dotEnvSecretStore.ts";
import { fileCredentialWriter } from "./envWriter.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import { WorkerLoop } from "./queue/workerLoop.ts";
import { McpStore } from "./mcpStore.ts";
import { McpRegistry, type RegistrationResult } from "./mcpRegistry.ts";
import { MCP_DISCOVER_CLASS, McpDiscoveryQueue, type McpDiscoveryPayload } from "./mcpDiscovery.ts";
import { authEnvKeyFor } from "./envWriter.ts";
import { discover } from "./mcpClient.ts";
import { isConfirmNonce, mcpRunCredentials, runScope } from "./mcpScope.ts";
import { parseControlLine } from "./processManager.ts";
import { PeerConfirms } from "./mcpConfirmPeers.ts";
import { isSecretName, secretNameRefusal } from "./secrets/secretStore.ts";
import { isHostOwnedPath, readOnlyPaths } from "./projectFs.ts";
import { safeObjectPath } from "./storage/keys.ts";
import { buildManifest, grantWithout, projectCanCallMcp, withGrantOnly, withoutMcpGrant } from "./mcpManifest.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { GithubPuller } from "./githubPullRunner.ts";
import { replyResult, startScriptedServer, type ScriptedRequest } from "../fixtures/mcp/scriptedServer.ts";

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
const refs = new SecretRefRepository(db);
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider("a-master-key-with-enough-entropy-behind-it-0123456789"),
  refs,
  runWorkspace: async () => null,
});
const store = new McpStore(db);
const registry = new McpRegistry(store, secrets, undefined, refs);
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
    `${fixture.url}?private_token=SUPERSECRET123`,
    `${fixture.url}?apiToken=SUPERSECRET123`,
    `${fixture.url}?AWSAccessKeyId=AKIA&X-Amz-Signature=SUPERSECRET123`,
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
  for (const query of ["keyword=mcp", "author=me", "monkey=1", "tokenizer=bpe"]) {
    const ordinary = await registry.prepare(A, { endpoint: `${fixture.url}?${query}`, label: `Plain ${query.slice(0, 4)}` });
    check(ordinary.ok, `?${query} is not one either`, ordinary.message ?? "");
  }

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
  check((await refs.get(A, key))?.configured === true, "and the Secrets list shows it");
  await registry.removeServer(A, "holder");
  check(!(key in (await secrets.getForPlatformCall(A, [key]))), "disconnect removes it from the store");
  check((await refs.get(A, key)) === undefined, "and takes its name off the Secrets list", JSON.stringify(await refs.get(A, key)));
  check((await registry.get(A, "holder")) === null, "and the row is gone");
  await connect(A, { endpoint: fixture.url, label: "Unset", token: "goes-with-the-server" });
  await registry.setCredential(A, "unset", null);
  check((await refs.get(A, authEnvKeyFor("unset"))) === undefined, "removing a server's credential takes its name off as well", JSON.stringify(await refs.get(A, authEnvKeyFor("unset"))));
  await registry.removeServer(A, "unset");
  await secrets.set(A, "PLAIN_SERVICE_KEY", "kept-name");
  await secrets.delete(A, "PLAIN_SERVICE_KEY");
  check((await refs.get(A, "PLAIN_SERVICE_KEY"))?.configured === false, "while a credential no server owns keeps its name, marked not set");
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
  const smuggled = await startScriptedServer({
    tools: [{
      name: "read_page",
      description: "Reads a page.\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} soft\u00ADhyphen mark\u061C vowel\u180E gap\uFFF9",
      inputSchema: { type: "object", properties: {} },
    }],
  });
  await connect(A, { endpoint: smuggled.url, label: "Smuggled" });
  const said = (await registry.get(A, "smuggled"))?.tools[0]?.description ?? "";
  check(!/[\u00ad\u061c\u180e\ufff9-\ufffb\u{e0000}-\u{e007f}]/u.test(said), "tag characters and other invisible marks are stripped too", JSON.stringify(said));
  check(said.startsWith("Reads a page.") && said.includes("softhyphen"), "leaving the visible text", JSON.stringify(said));
  await smuggled.close();
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

console.log("\na failure says what happened, in words a person can act on");
{
  const A = await workspace("words");
  const nowhere = new McpRegistry(store, secrets, async () => ({ v4: [], v6: [] }), refs);
  const lost = await nowhere.prepare(A, { endpoint: "https://no-such-host.invalid/mcp", label: "Lost" });
  const missing = await nowhere.addServer(A, { endpoint: "https://no-such-host.invalid/mcp", label: "Lost", id: lost.id, reserved: true });
  check(missing.server?.status === "unreachable", "a name that does not resolve is unreachable, not a permanent error", String(missing.server?.status));
  check(/could not find/.test(missing.message ?? ""), "...and says the name was not found", missing.message ?? "");

  const plain = await startScriptedServer();
  const local = plain.url.replace("127.0.0.1", "localhost");
  await connect(A, { endpoint: local, label: "Localhost" });
  const viaName = await registry.get(A, "localhost");
  check(viaName?.status === "connected", "a localhost URL connects in development", `${viaName?.status} ${viaName?.last_error}`);
  await plain.close();

  const unversioned = await startScriptedServer({ serverInfo: { name: "nameless" } });
  await connect(A, { endpoint: unversioned.url, label: "Unversioned" });
  const invalid = await registry.get(A, "unversioned");
  check(!/ZodError|"expected"/.test(invalid?.last_error ?? ""), "an invalid handshake does not show raw validator output", invalid?.last_error ?? "");
  check(/not valid MCP \(serverInfo\.version: /.test(invalid?.last_error ?? ""), "...it names the field that was wrong", invalid?.last_error ?? "");
  await unversioned.close();

  const guarded = await startScriptedServer({ token: "right-token" });
  await connect(A, { endpoint: guarded.url, label: "NoToken" });
  const none = await registry.get(A, "notoken");
  check(none?.status === "auth_required" && /requires authorization\. Add a credential for it/.test(none.last_error ?? ""), "with no token the server asks for one", none?.last_error ?? "");
  check(!/\[redacted\]/.test(none?.last_error ?? ""), "...in words that survive being stored", none?.last_error ?? "");
  await connect(A, { endpoint: guarded.url, label: "WrongToken", token: "wrong-token" });
  const wrong = await registry.get(A, "wrongtoken");
  check(wrong?.status === "auth_required", "a rejected token still needs a credential", String(wrong?.status));
  check(/rejected the credential Jaroku presented/.test(wrong?.last_error ?? ""), "...and says the token given was refused", wrong?.last_error ?? "");
  check(!/Add a credential/.test(wrong?.last_error ?? ""), "...rather than asking for one that was just given", wrong?.last_error ?? "");
  check(!/\[redacted\]/.test(wrong?.last_error ?? ""), "...in words that survive being stored", wrong?.last_error ?? "");
  check(!(wrong?.last_error ?? "").includes("wrong-token"), "...without quoting it");

  const seenBefore = guarded.seen.length;
  for (const [what, token] of [["a bell character", "abc\u0007def"], ["a NUL", "abc\u0000def"], ["a line break", "abc\ndef"], ["a curly quote", "\u201cabc\u201d"]] as const) {
    const refused = await registry.prepare(A, { endpoint: guarded.url, label: `Bad ${what}`, token });
    check(!refused.ok && /HTTP header cannot carry/.test(refused.message ?? ""), `a token with ${what} is refused before anything is stored`, refused.message ?? "");
  }
  check(guarded.seen.length === seenBefore, "and the server never saw a request for any of them", String(guarded.seen.length - seenBefore));
  check(!(await store.listServers(A)).some((s) => s.label.startsWith("Bad ")), "nor was a row left behind");
  const kept = await registry.setCredential(A, "wrongtoken", "abc\u0007def");
  check(!kept.result.ok && /HTTP header cannot carry/.test(kept.result.message ?? ""), "replacing a credential with one is refused the same way", kept.result.message ?? "");
  check((await secrets.getForPlatformCall(A, [wrong?.auth_env_key ?? ""]))[wrong?.auth_env_key ?? ""] === "wrong-token", "and the stored credential is left as it was");
  await guarded.close();
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

console.log("\nan empty cursor ends the list, and a repeated name is called what it is");
{
  const A = await workspace("cursor");
  const listed = [
    { name: "read_page", description: "Reads.", inputSchema: { type: "object", properties: {} } },
    { name: "list_items", description: "Lists.", inputSchema: { type: "object", properties: {} } },
    { name: "get_item", description: "Gets.", inputSchema: { type: "object", properties: {} } },
  ];
  const paged = (nextCursor: (cursor: unknown) => unknown, tools: unknown[] = listed) => ({
    hook: ({ rpc, id, body, res }: ScriptedRequest) => {
      if (rpc !== "tools/list") return false;
      const cursor = (JSON.parse(body) as { params?: { cursor?: unknown } }).params?.cursor;
      replyResult(res, id, { tools, nextCursor: nextCursor(cursor) });
      return true;
    },
  });
  const said = (from: number) => results.slice(from).map((r) => r.result.message ?? "").join(" ");
  const lists = (server: { seen: { rpc: string | null }[] }) => server.seen.filter((r) => r.rpc === "tools/list").length;

  const empty = await startScriptedServer(paged(() => ""));
  let before = results.length;
  await connect(A, { endpoint: empty.url, label: "EmptyCursor" });
  const row = await registry.get(A, "emptycursor");
  check(lists(empty) === 1, "an empty cursor is the last page", String(lists(empty)));
  check(row?.status === "connected" && row.tools.length === 3, "and the tools on it are all kept", `${row?.status} ${row?.tools.length}`);
  check(said(before) === "", "and nothing claims the list was cut or refused", said(before));
  await empty.close();

  const loop = await startScriptedServer(paged(() => "again"));
  before = results.length;
  await connect(A, { endpoint: loop.url, label: "LoopCursor" });
  check(lists(loop) === 2, "a cursor the server already sent ends the list", String(lists(loop)));
  check((await registry.get(A, "loopcursor"))?.tools.length === 3, "without losing a tool");
  check(said(before) === "", "and it is not reported as more tools than Jaroku accepts", said(before));
  await loop.close();

  const twice = await startScriptedServer({ tools: [listed[0], listed[0], listed[1]] });
  before = results.length;
  await connect(A, { endpoint: twice.url, label: "Twice" });
  check((await registry.get(A, "twice"))?.tools.map((t) => t.name).join() === "list_items,read_page", "a tool listed twice is kept once");
  check(said(before) === "", "and nothing is lost, so nothing is said", said(before));
  await twice.close();

  const clash = await startScriptedServer({ tools: [listed[0], { ...listed[0], description: "Deletes a page." }, listed[1]] });
  before = results.length;
  await connect(A, { endpoint: clash.url, label: "Clash" });
  const kept = (await registry.get(A, "clash"))?.tools.find((t) => t.name === "read_page");
  check(kept?.description === "Reads.", "two different tools under one name keep the first", String(kept?.description));
  check(/^1 advertised tool reused the name of a different tool already listed/.test(said(before)), "and the second is reported as a reused name", said(before));
  check(!/refused as unusable|tool name must be/.test(said(before)), "not as an illegal one", said(before));
  await clash.close();

  const endless = await startScriptedServer({
    hook: ({ rpc, id, body, res }: ScriptedRequest) => {
      if (rpc !== "tools/list") return false;
      const page = Number((JSON.parse(body) as { params?: { cursor?: unknown } }).params?.cursor ?? 0);
      replyResult(res, id, {
        tools: [{ name: "has spaces", inputSchema: {} }, { ...listed[0], description: `Reads page ${page}.` }],
        nextCursor: String(page + 1),
      });
      return true;
    },
  });
  before = results.length;
  await connect(A, { endpoint: endless.url, label: "Endless" });
  const message = said(before);
  check(/the list was truncated\. 50 advertised tools were refused as unusable/.test(message), "each sentence ends before the next begins", message);
  check(/64KB\. 49 advertised tools reused the name of a different tool/.test(message), "and reused names are counted apart from the refusals", message);
  await endless.close();
}

console.log("\nwhat discovery refused stays on the server's row");
{
  const A = await workspace("note");
  const fixture = await startScriptedServer({ tools: [{ name: "has spaces", inputSchema: {} }, { name: "bad.dot", inputSchema: {} }] });
  await connect(A, { endpoint: fixture.url, label: "Refusing" });
  const row = await registry.get(A, "refusing");
  check(row?.status === "connected" && row.tools.length === 0, "a server whose every tool is refused still connects", `${row?.status} ${row?.tools.length}`);
  check(/^2 advertised tools were refused as unusable/.test(row?.discovery_note ?? ""), "and its row says two tools were refused", String(row?.discovery_note));
  const listed = (await store.listServers(A)).find((s) => s.id === "refusing");
  check(listed?.discovery_note === row?.discovery_note, "the note is part of the snapshot every client receives");

  const recheck = async () => {
    await queue.enqueue(A, { kind: "rediscover", serverId: "refusing" });
    await drain();
    return registry.get(A, "refusing");
  };
  fixture.set({ tools: [{ name: "read_page", inputSchema: {} }, { name: "has spaces", inputSchema: {} }] });
  const partly = await recheck();
  check(partly?.tools.length === 1 && /^1 advertised tool was refused/.test(partly.discovery_note ?? ""), "a re-check replaces the note with what it found", String(partly?.discovery_note));

  fixture.set({ tools: [{ name: "read_page", inputSchema: {} }] });
  const clean = await recheck();
  check(clean?.discovery_note === null, "a clean list clears it", String(clean?.discovery_note));

  fixture.set({ tools: [{ name: "read_page", inputSchema: {} }, { name: "has spaces", inputSchema: {} }] });
  await recheck();
  fixture.set({ tools: "nope" });
  const failed = await recheck();
  check(failed?.status === "error" && failed.tools.length === 1, "a failed re-check keeps the list it had", `${failed?.status} ${failed?.tools.length}`);
  check(/^1 advertised tool was refused/.test(failed?.discovery_note ?? ""), "...and the note that describes that list", String(failed?.discovery_note));
  await fixture.close();
}

console.log("\na failed check still moves when the server was last checked");
{
  const A = await workspace("checked");
  const fixture = await startScriptedServer();
  await connect(A, { endpoint: fixture.url, label: "Checked" });
  const first = await registry.get(A, "checked");
  check(Boolean(first?.checked_at) && Boolean(first?.discovered_at), "a connect stamps when it was checked and when its tools were found", JSON.stringify(first));
  const recheck = async () => {
    await new Promise((r) => setTimeout(r, 15));
    await queue.enqueue(A, { kind: "rediscover", serverId: "checked" });
    await drain();
    return registry.get(A, "checked");
  };

  fixture.set({ hook: ({ res }) => (res.writeHead(500, { "content-type": "text/plain" }).end("down"), true) });
  const failed = await recheck();
  check(failed?.status === "error", "the server is down", String(failed?.status));
  check((failed?.checked_at ?? "") > (first?.checked_at ?? ""), "a failed re-check moves the time it was last checked", `${first?.checked_at} ${failed?.checked_at}`);
  check(failed?.discovered_at === first?.discovered_at, "and leaves the time its tools were found", `${first?.discovered_at} ${failed?.discovered_at}`);

  fixture.set({ hook: undefined });
  const back = await recheck();
  check(back?.status === "connected" && (back.checked_at ?? "") > (failed?.checked_at ?? ""), "a good re-check moves it again", `${back?.status} ${back?.checked_at}`);
  check((back?.discovered_at ?? "") > (first?.discovered_at ?? ""), "...and the tools are new", String(back?.discovered_at));
  await fixture.close();
}

console.log("\na workspace has at most its limit of discoveries running at once");
{
  const A = await workspace("limit");
  let running = 0;
  let peak = 0;
  const slow = await startScriptedServer({
    hook: async ({ rpc }) => {
      if (rpc !== "initialize") return false;
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 300));
      running--;
      return false;
    },
  });
  const loopDispatcher = new Dispatcher(new InMemoryQueueBackend());
  const loopQueue = new McpDiscoveryQueue({
    dispatcher: loopDispatcher,
    registry,
    onError: (_ctx, _payload, err) => errors.push(err),
  });
  const loop = new WorkerLoop({
    dispatcher: loopDispatcher,
    classes: [MCP_DISCOVER_CLASS],
    handlers: { [MCP_DISCOVER_CLASS]: loopQueue.handler() as never },
    idlePollMs: 20,
  });
  void loop.run();
  const labels = ["Slow1", "Slow2", "Slow3"];
  for (const label of labels) {
    const prepared = await registry.prepare(A, { endpoint: slow.url, label });
    await loopQueue.enqueue(A, { kind: "add", serverId: prepared.id, endpoint: slow.url, label, authEnvKey: prepared.authEnvKey });
  }
  const until = Date.now() + 15_000;
  const connected = async () => (await store.listServers(A)).filter((s) => s.status === "connected").length;
  while ((await connected()) < labels.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  await loop.shutdown(2000);
  check((await connected()) === labels.length, "every discovery still completes", String(await connected()));
  check(peak === 2, "but no more than two handshakes ran at once", String(peak));
  check(slow.seen.filter((r) => r.rpc === "initialize").length === labels.length, "and each server was asked once", String(slow.seen.filter((r) => r.rpc === "initialize").length));
  await slow.close();
}

console.log("\nan add in flight is visible before its handshake ends");
{
  const index = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"), "utf8");
  const add = /case "addMcpServer": \{[\s\S]*?\n {6}\}\n/.exec(index)?.[0] ?? "";
  const prepared = add.indexOf("mcpRegistry.prepare(");
  const snapshot = add.indexOf("broadcastMcpServers(ctx);", prepared);
  const queued = add.indexOf("mcpDiscovery.enqueue(");
  check(prepared > 0 && snapshot > prepared && snapshot < queued, "the reserved row is broadcast once the add is accepted, before the handshake is queued");
  check(/type: "discovering", serverId: prepared\.id/.test(add), "and the discovering message names the row it reserved");
  const settle = /async function settleMcpDiscovery\([\s\S]*?\n\}/.exec(index)?.[0] ?? "";
  check(settle.indexOf("broadcastMcpServers(ctx)") > 0 && settle.indexOf("say()") > settle.indexOf("broadcastMcpServers(ctx)") && settle.indexOf('type: "discovered"') > settle.indexOf("say()"), "a finished check sends its snapshot, then its message, then that it is over");
  check((index.match(/settleMcpDiscovery\(ctx, payload\.serverId/g) ?? []).length === 2, "...whether the handshake returned or threw");

  const A = await workspace("inflight");
  const slow = await startScriptedServer({
    hook: async ({ rpc }) => {
      if (rpc === "initialize") await new Promise((r) => setTimeout(r, 200));
      return false;
    },
  });
  const accepted = await registry.prepare(A, { endpoint: slow.url, label: "Pending" });
  const listed = await registry.list(A);
  check(listed.some((s) => s.id === accepted.id && s.status === "connecting"), "the snapshot taken then lists it as connecting", JSON.stringify(listed.map((s) => [s.id, s.status])));
  await queue.enqueue(A, { kind: "add", serverId: accepted.id, endpoint: slow.url, label: "Pending", authEnvKey: accepted.authEnvKey });
  await drain();
  check((await registry.get(A, accepted.id))?.status === "connected", "and the same row becomes connected when the handshake ends");
  await slow.close();
}

console.log("\nadds that derive one id each keep their own row");
{
  const A = await workspace("collide");
  const fixture = await startScriptedServer();
  const paths = ["/ok", "/dupes", "/colliding"];
  const added = await Promise.all(paths.map((path) => registry.prepare(A, { endpoint: `${fixture.origin}${path}` })));
  check(new Set(added.map((a) => a.id)).size === 3, "three adds on one host get three ids", added.map((a) => a.id).join());
  for (const [index, prepared] of added.entries()) {
    await queue.enqueue(A, { kind: "add", serverId: prepared.id, endpoint: `${fixture.origin}${paths[index]}`, authEnvKey: prepared.authEnvKey });
  }
  const before = await registry.list(A);
  check(before.length === 3, "each is visible the moment it is accepted", String(before.length));
  check(before.every((row) => row.status === "connecting"), "as connecting", before.map((row) => row.status).join());
  await drain();
  const rows = await registry.list(A);
  check(rows.length === 3, "and three rows exist once they finish", String(rows.length));
  check(rows.every((row) => row.status === "connected"), "all connected", rows.map((row) => row.status).join());
  check(new Set(rows.map((row) => row.endpoint)).size === 3, "each with its own endpoint");

  const labelled = await Promise.all(["/a", "/b"].map((path) => registry.prepare(A, { endpoint: `${fixture.origin}${path}`, label: "Same Label" })));
  check(new Set(labelled.map((a) => a.id)).size === 2, "two adds with one label get two ids", labelled.map((a) => a.id).join());

  const gone = await registry.prepare(A, { endpoint: `${fixture.origin}/gone`, label: "Gone" });
  await queue.enqueue(A, { kind: "add", serverId: gone.id, endpoint: `${fixture.origin}/gone`, authEnvKey: null });
  await registry.removeServer(A, gone.id);
  await drain();
  check((await registry.get(A, gone.id)) === null, "disconnecting one still waiting to connect keeps it gone");
  await fixture.close();
}

console.log("\ndisconnecting during a re-check stays disconnected");
{
  const A = await workspace("zombie");
  const fixture = await startScriptedServer();
  await connect(A, { endpoint: fixture.url, label: "Zombie" });
  fixture.set({
    hook: async ({ rpc }) => {
      if (rpc === "tools/list") await new Promise((done) => setTimeout(done, 700));
      return false;
    },
  });
  await queue.enqueue(A, { kind: "rediscover", serverId: "zombie" });
  const running = drain();
  await new Promise((done) => setTimeout(done, 250));
  await registry.removeServer(A, "zombie");
  await running;
  check((await registry.get(A, "zombie")) === null, "the row stays gone once the slow handshake ends");
  check((await store.listTools(A, "zombie")).length === 0, "and no tools come back with it");

  await connect(A, { endpoint: fixture.url, label: "Queued" });
  await queue.enqueue(A, { kind: "rediscover", serverId: "queued" });
  await registry.removeServer(A, "queued");
  await queue.forget(A, "queued");
  check((await dispatcher.pendingCount(MCP_DISCOVER_CLASS, A.workspaceId)) === 0, "a re-check still waiting in the queue is dropped with it");
  await fixture.close();
}

console.log("\na slow job does not undo a credential added while it ran");
{
  const A = await workspace("stale");
  const fixture = await startScriptedServer();
  await connect(A, { endpoint: fixture.url, label: "Stale" });
  fixture.set({
    hook: async ({ rpc }) => {
      if (rpc === "tools/list") await new Promise((done) => setTimeout(done, 700));
      return false;
    },
  });
  await queue.enqueue(A, { kind: "rediscover", serverId: "stale" });
  const running = drain();
  await new Promise((done) => setTimeout(done, 250));
  await registry.setCredential(A, "stale", "added-while-it-ran");
  await running;
  const row = await registry.get(A, "stale");
  check(row?.auth_env_key === authEnvKeyFor("stale"), "the key name survives the job", String(row?.auth_env_key));
  check(row?.configured === true, "and the panel still says a credential is stored");
  await fixture.close();
}

console.log("\nan add still connecting cannot bring a row back or undo a credential");
{
  const A = await workspace("firsthand");
  const fixture = await startScriptedServer();
  fixture.set({
    hook: async ({ rpc }) => {
      if (rpc === "tools/list") await new Promise((done) => setTimeout(done, 700));
      return false;
    },
  });
  const slowAdd = async (label: string, during: (id: string) => Promise<unknown>, token?: string) => {
    const prepared = await registry.prepare(A, { endpoint: fixture.url, label, ...(token ? { token } : {}) });
    await queue.enqueue(A, { kind: "add", serverId: prepared.id, endpoint: fixture.url, label, authEnvKey: prepared.authEnvKey });
    const running = drain();
    await new Promise((done) => setTimeout(done, 250));
    await during(prepared.id);
    await running;
    return prepared;
  };

  const gone = await slowAdd("Gone Mid Connect", (id) => registry.removeServer(A, id));
  check((await registry.get(A, gone.id)) === null, "a server disconnected during its first handshake stays gone");
  check((await store.listTools(A, gone.id)).length === 0, "and none of its tools come back");

  const keyed = await slowAdd("Keyed Mid Connect", (id) => registry.setCredential(A, id, "added-mid-connect"));
  const row = await registry.get(A, keyed.id);
  check(Boolean(row?.auth_env_key), "a credential added during the first handshake keeps its key name", String(row?.auth_env_key));
  check(row?.configured === true, "and the panel still says one is stored");

  const given = await slowAdd("Given At Connect", async () => null, "given-at-connect");
  const linked = await registry.get(A, given.id);
  check(linked?.auth_env_key === given.authEnvKey && linked?.configured === true, "a token given at connect stays linked", String(linked?.auth_env_key));
  check(linked?.status === "connected", "and that add still connects", String(linked?.status));
  await fixture.close();
}

console.log("\nparallel adds cannot pass a plan's server limit");
{
  const A = await workspace("quota");
  const fixture = await startScriptedServer();
  const added = await Promise.all(
    Array.from({ length: 8 }, (_, index) => registry.prepare(A, { endpoint: `${fixture.origin}/s${index}`, label: `Server ${index}`, maxServers: 3 })),
  );
  check(added.filter((a) => a.ok).length === 3, "eight together on a limit of three leave three", String(added.filter((a) => a.ok).length));
  check((await registry.list(A)).length === 3, "and three rows");
  check(added.filter((a) => !a.ok).every((a) => a.atLimit === true), "the rest are told it was the limit");
  const unlimited = await registry.prepare(A, { endpoint: `${fixture.origin}/open`, label: "Open" });
  check(unlimited.ok, "no limit means no refusal");
  await fixture.close();
}

console.log("\non the local store two workspaces on one server name keep their own token");
{
  const envPath = join(dir, "isolated.env");
  const dotenv = new DotEnvSecretStore({ envPath, writer: fileCredentialWriter(envPath) });
  const local = new McpRegistry(store, dotenv);
  const A = await workspace("env-a");
  const B = await workspace("env-b");
  const fixture = await startScriptedServer();
  await local.addServer(A, { endpoint: fixture.url, label: "Linear", token: "TOKEN-OF-WORKSPACE-A" });
  await local.addServer(B, { endpoint: fixture.url, label: "Linear", token: "TOKEN-OF-WORKSPACE-B" });
  const keyA = (await local.get(A, "linear"))?.auth_env_key;
  const keyB = (await local.get(B, "linear"))?.auth_env_key;
  check(Boolean(keyA && keyB) && keyA !== keyB, "they are stored under different names", `${keyA} ${keyB}`);
  fixture.seen.length = 0;
  await local.rediscover(A, "linear");
  check(fixture.seen.every((r) => r.auth === "Bearer TOKEN-OF-WORKSPACE-A"), "workspace A presents its own token", String(fixture.seen[0]?.auth));
  await local.setCredential(B, "linear", null);
  fixture.seen.length = 0;
  await local.rediscover(A, "linear");
  check(fixture.seen.every((r) => r.auth === "Bearer TOKEN-OF-WORKSPACE-A"), "and B removing its token leaves A's alone", String(fixture.seen[0]?.auth));
  check((await local.get(A, "linear"))?.configured === true, "so A still reads configured");
  await local.removeServer(A, "linear");
  await local.removeServer(B, "linear");
  await fixture.close();
}

console.log("\non the local store a name two workspaces already share is taken apart");
{
  const envPath = join(dir, "shared.env");
  const dotenv = new DotEnvSecretStore({ envPath, writer: fileCredentialWriter(envPath), refs });
  const local = new McpRegistry(store, dotenv, undefined, refs);
  const A = await workspace("shared-a");
  const B = await workspace("shared-b");
  const C = await workspace("shared-c");
  const fixture = await startScriptedServer();
  for (const ctx of [A, B]) await local.addServer(ctx, { endpoint: fixture.url, label: "Tracker" });
  await local.addServer(C, { endpoint: fixture.url, label: "Solo" });
  const shared = authEnvKeyFor("tracker");
  await dotenv.set(A, shared, "TOKEN-OF-WORKSPACE-A");
  await dotenv.set(B, shared, "TOKEN-OF-WORKSPACE-B");
  for (const ctx of [A, B]) await store.setServerAuthEnvKey(ctx, "tracker", shared);
  const solo = authEnvKeyFor("solo");
  await dotenv.set(C, solo, "TOKEN-OF-WORKSPACE-C");
  await store.setServerAuthEnvKey(C, "solo", solo);
  const unshared = await local.unshareCredentials([A, B, C]);
  check(JSON.stringify(unshared) === JSON.stringify([shared]), "the shared name is found, and only that one", JSON.stringify(unshared));
  for (const [label, ctx] of [["A", A], ["B", B]] as const) {
    const row = await local.get(ctx, "tracker");
    check(row?.auth_env_key === null && row?.configured === false, `${label} no longer points at the shared name`, JSON.stringify({ key: row?.auth_env_key, configured: row?.configured }));
    check((await refs.get(ctx, shared)) === undefined, `and ${label}'s Secrets list no longer shows it`);
  }
  check(!(shared in (await dotenv.getForPlatformCall(A, [shared]))), "the value nobody can tell the owner of is gone");
  fixture.seen.length = 0;
  await local.rediscover(A, "tracker");
  check(fixture.seen.length > 0 && fixture.seen.every((r) => !r.auth), "so A presents nobody's token", JSON.stringify(fixture.seen.map((r) => r.auth)));
  fixture.seen.length = 0;
  await local.rediscover(C, "solo");
  check(fixture.seen.length > 0 && fixture.seen.every((r) => r.auth === "Bearer TOKEN-OF-WORKSPACE-C"), "a name only one workspace holds keeps working", JSON.stringify(fixture.seen.map((r) => r.auth)));
  check((await local.unshareCredentials([A, B, C])).length === 0, "and a second pass finds nothing to do");
  for (const ctx of [A, B]) await local.removeServer(ctx, "tracker");
  await local.removeServer(C, "solo");
  await fixture.close();
}

console.log("\na grant is refused on a project that could never call it");
{
  const bridge = { path: "tools/mcp_bridge.py", content: "MCP_TOOLS = []\n" };
  const wired = { path: "tools/__init__.py", content: "from .mcp_bridge import MCP_TOOLS\nTOOLS = [*MCP_TOOLS]\n" };
  const unwired = { path: "tools/__init__.py", content: "TOOLS = []\n" };
  const agent = { path: "agent.py", content: "x = 1\n" };
  check(projectCanCallMcp([agent, bridge, wired]), "a project with the bridge wired in can");
  check(!projectCanCallMcp([agent, unwired]), "one generated without it cannot");
  check(!projectCanCallMcp([agent, bridge, unwired]), "nor one with the file and no wiring");
  const index = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"), "utf8");
  const fn = /async function setAgentTools\([\s\S]*?\n\}/.exec(index)?.[0] ?? "";
  check(/granted\.length > 0[\s\S]{0,200}projectCanCallMcp/.test(fn), "and the command refuses before it writes the grant");
  check(fn.indexOf("projectCanCallMcp") < fn.indexOf("agentRepo.setMcpTools"), "...before the column changes");
}

console.log("\nthe host owned files cannot be reached by another spelling");
{
  const blocked = readOnlyPaths(["tools/gmail.py"]);
  const spellings = [
    "mcp_tools.json", "MCP_TOOLS.JSON", "mcp_tools.JSON", "Mcp_Tools.json", "mcp_to~1.jso", "MCP_TO~1.JSO",
    "tools/mcp_bridge.py", "tools/MCP_BRIDGE.PY", "Tools/mcp_bridge.py", "tools/mcp_br~1.py", "TOOLS~1/mcp_bridge.py",
    "tools/GMAIL.PY", "Dockerfile".toLowerCase(),
  ];
  for (const path of spellings) check(isHostOwnedPath(path, blocked), `${path} is refused`);
  for (const path of ["agent.py", "tools/mcp_helpers.py", "prompts/system.md", "tools/my~notes.py"]) {
    check(!isHostOwnedPath(path, blocked), `${path} is an ordinary file`);
  }
  check(safeObjectPath("mcp_tools.json::$DATA") === null, "an alternate data stream is not a path");
  check(safeObjectPath("agent.py:x") === null, "and neither is anything with a colon");
  const editor = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "editor.ts"), "utf8");
  check(/isHostOwnedPath\(safe, blocked\)/.test(editor), "the edit loop asks this rather than an exact match");

  const pullFrom = (path: string) =>
    new GithubPuller({
      repo: { linkFor: async () => ({ id: "link", repo_full_name: "o/r", branch: "main", subdirectory: "" }), record: async () => undefined } as never,
      identity: { apiFor: async () => ({ api: { refSha: async () => "head", tree: async () => [{ path, sha: "blob", size: 14 }], blob: async () => '{"servers":[]}' } }) } as never,
      agents: { bySlug: async () => ({ id: "pulled-agent", slug: "pulled", current_version: 1, connectors: [] }) } as never,
      projects: {
        readCurrent: async () => [{ path: "mcp_tools.json", content: '{"servers":[{"id":"alpha"}]}' }],
        discardStaging: async () => undefined,
      } as never,
      runtimeDir: dir,
      connectorFilesFor: () => [],
      log: () => undefined,
    }).pull(systemContextFor(randomUUID(), newRequestId()), { agentId: "pulled" }, () => undefined);
  for (const path of ["MCP_TOOLS.JSON", "mcp_to~1.jso", "Tools/mcp_bridge.py"]) {
    const pulled = await pullFrom(path);
    check(pulled.refusal?.check === "protected", `a pull carrying ${path} is refused as a protected file`, JSON.stringify(pulled).slice(0, 160));
  }
  check((await pullFrom("agent.py")).refusal?.check !== "protected", "and a pull carrying an ordinary file is not");
}

console.log("\na replica holds the asks another replica raised, until they close");
{
  const peers = new PeerConfirms();
  const at = Date.parse("2026-11-05T10:00:00.000Z");
  const ask = (nonce: string, barred?: string[]) => ({
    channel: "mcp", type: "confirmRequest", runId: "run-1", nonce, server: "alpha", tool: "send",
    args: "{}", impactReason: null, timeoutS: 120, requestedAt: new Date(at).toISOString(), serverNow: at, agentSlug: "agent",
    ...(barred ? { __barredUsers: barred } : {}),
  });
  peers.observe("ws-1", ask("aaa"), at);
  peers.observe("ws-1", ask("bbb", ["barred-user"]), at);
  check(peers.find("ws-1", "run-1", "aaa", at)?.agentSlug === "agent", "an ask seen over the bridge can be found");
  check(peers.find("ws-2", "run-1", "aaa", at) === null, "but never from another workspace");
  const listed = peers.listFor("ws-1", "someone", at);
  check(listed.length === 2, "a tab connecting to this replica is told about both", String(listed.length));
  check(listed.every((event) => !("__barredUsers" in event) && !("channel" in event)), "without the delivery fields");
  check(peers.listFor("ws-1", "barred-user", at).length === 1, "a barred member is not told about the one they cannot see");
  peers.observe("ws-1", { channel: "mcp", type: "confirmResolved", runId: "run-1", nonce: "aaa", verdict: "once" }, at);
  check(peers.find("ws-1", "run-1", "aaa", at) === null, "an answer closes it here too");
  check(peers.find("ws-1", "run-1", "bbb", at + 121_000) === null, "and one nobody answered lapses with its clock");
  check(peers.listFor("ws-1", "someone", at + 121_000).length === 0, "so a dead replica's ask does not linger");
  peers.observe("ws-1", { channel: "trace", event: {} }, at);
  const index = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"), "utf8");
  check(/peerConfirms\.find\(ctx\.workspaceId, cmd\.runId, cmd\.nonce\)/.test(index), "an answer for another replica's ask is looked up here");
  check(/channel: CONFIRM_ANSWER_CHANNEL/.test(index), "and forwarded over the bridge");
  check(/payload as \{ channel\?: unknown \}\)\.channel === CONFIRM_ANSWER_CHANNEL/.test(index), "and the owning replica acts on it");
  check(/peerConfirms\.listFor\(/.test(index), "and a reconnecting tab is told about asks held elsewhere");
}

console.log("\nan advertised schema is normalised or refused at the door");
{
  const A = await workspace("shapes");
  const named = (name: string, inputSchema: unknown) => ({ name, description: "Reads.", inputSchema });
  const fixture = await startScriptedServer({
    tools: [
      named("read_bare", { type: "object" }),
      named("read_untyped", { properties: { a: { type: "string" } } }),
      named("read_list", { type: ["object", "null"], properties: {} }),
      named("read_required", { type: "object", properties: { a: {} }, required: "a" }),
      named("read_string", { type: "string" }),
      named("read_array", { type: "array", items: {} }),
    ],
  });
  await connect(A, { endpoint: fixture.url, label: "Shapes" });
  const row = await registry.get(A, "shapes");
  const schema = (name: string) => row?.tools.find((t) => t.name === name)?.input_schema as Record<string, unknown> | undefined;
  check(schema("read_bare")?.["type"] === "object" && typeof schema("read_bare")?.["properties"] === "object", "a bare object gets properties");
  check(schema("read_untyped")?.["type"] === "object", "an untyped schema with properties is an object");
  check(schema("read_list")?.["type"] === "object", "a type list holding object is an object");
  check(!("required" in (schema("read_required") ?? { required: 1 })), "a required that is not a list is dropped");
  check(!schema("read_string"), "a tool whose arguments are not an object is refused");
  check(!schema("read_array"), "and so is an array");
  await fixture.close();
}

console.log("\nparallel adds on Postgres stop at the plan's limit");
await withScratchPostgres(async (pg) => {
  const pgStore = new McpStore(pg);
  const ws = await new IdentityRepository(pg).createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `e2e limit ${randomUUID().slice(0, 6)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  for (let round = 1; round <= 3; round++) {
    const limit = round * 3;
    const reserved = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pgStore.reserveServer(ctx, {
          id: `limit_${round}_${i}`, label: `Limit ${round} ${i}`, endpoint: `https://example.com/${round}/${i}`, transport: "http",
          auth_env_key: null, server_name: null, server_version: null, protocol_version: null,
          status: "connecting", last_error: null, discovered_at: null,
        }, limit),
      ),
    );
    const rows = (await pgStore.listServers(ctx)).length;
    check(rows === limit && reserved.filter(Boolean).length === 3, `ten adds at once stop at a limit of ${limit}`, `${rows} rows, ${reserved.filter(Boolean).length} reserved`);
  }
});

check(errors.length === 0, "no handler threw", String(errors[0] ?? ""));

await db.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
