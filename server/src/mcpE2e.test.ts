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
import { buildManifest } from "./mcpManifest.ts";
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

check(errors.length === 0, "no handler threw", String(errors[0] ?? ""));

await db.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
