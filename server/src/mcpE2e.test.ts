import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import { runScope } from "./mcpScope.ts";
import { buildManifest, grantWithout, withGrantOnly, withoutMcpGrant } from "./mcpManifest.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { startScriptedServer } from "../fixtures/mcp/scriptedServer.ts";

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

check(errors.length === 0, "no handler threw", String(errors[0] ?? ""));

await db.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
