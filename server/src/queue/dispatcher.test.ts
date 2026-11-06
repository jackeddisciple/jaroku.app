// The fair dispatcher's conformance suite, against every backend.
//
// THREE RUNS, NOT ONE-AND-A-SKIP. InMemoryQueueBackend always. RedisQueueBackend against
// fixtures/redis/mockRedis.ts always — which executes redisBackend.ts's real Lua source in a real
// Lua VM, so the atomic admit, the leases and the purge are genuinely exercised on a machine with
// no Redis installed. And RedisQueueBackend against a REAL Redis when JAROKU_REDIS_URL points at
// one, which is still the authority and still what a hosted deployment runs.
//
// Before the fixture existed this file printed "SKIPPED" for everything but the in-memory backend,
// which meant the hosted backend's Lua — the load-bearing half of Session 5 — had no coverage at
// all on any machine without Docker.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:dispatcher

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { MockRedis } from "../../fixtures/redis/mockRedis.ts";
import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { RedisQueueBackend } from "./redisBackend.ts";
import { openRedis, pingRedis, redisUrlFromEnv } from "./redis.ts";
import { runQueueConformance } from "./conformance.ts";
import { Dispatcher, type Admission } from "./dispatcher.ts";
import { semaphoreKey } from "./semaphores.ts";
import type { QueueBackend } from "./backend.ts";
import type { JobClass } from "./jobs.ts";

let failures = 0;

async function workspaceCap(label: string, backend: QueueBackend): Promise<number> {
  let failed = 0;
  const check = (ok: boolean, msg: string, detail = ""): void => {
    if (ok) console.log(`  ok   [${label}] ${msg}`);
    else {
      failed++;
      console.log(`  FAIL [${label}] ${msg}${detail ? ` | ${detail}` : ""}`);
    }
  };
  for (const jobClass of ["mcp.discover", "run.eval"] as JobClass[]) {
    for (;;) {
      const leaseId = randomUUID();
      const stale = await backend.tryAdmit(jobClass, { leaseId, leaseTtlMs: 60_000, maxGlobalInFlight: null });
      if (!stale) break;
      await backend.ack(jobClass, leaseId);
    }
  }
  const dispatcher = new Dispatcher(backend);
  const A = `cap-a-${randomUUID()}`;
  const B = `cap-b-${randomUUID()}`;
  for (let i = 0; i < 3; i++) await dispatcher.enqueue("mcp.discover", A, { i }, { idempotencyKey: `a-${i}` });
  await dispatcher.enqueue("mcp.discover", B, { i: 0 }, { idempotencyKey: "b-0" });

  const held: Admission<unknown>[] = [];
  for (let i = 0; i < 6; i++) {
    const admitted = await dispatcher.tryAdmit("mcp.discover");
    if (admitted) held.push(admitted);
  }
  const fromA = held.filter((a) => a.job.workspaceId === A);
  check(fromA.length === 2, "one workspace has at most two discoveries in flight", String(fromA.length));
  check(held.some((a) => a.job.workspaceId === B), "another workspace is still served beside it");
  check((await dispatcher.pendingCount("mcp.discover", A)) === 1, "the third waits on the queue rather than being lost");

  await dispatcher.ack("mcp.discover", fromA[0]!.leaseId);
  const next = await dispatcher.tryAdmit("mcp.discover");
  check(next?.job.workspaceId === A, "and is admitted once one of the two finishes", String(next?.job.workspaceId));
  check((await dispatcher.tryAdmit("mcp.discover")) === null, "after which nothing is left waiting");
  for (const a of [...held, ...(next ? [next] : [])]) await dispatcher.ack("mcp.discover", a.leaseId);
  const slot = semaphoreKey("mcp.discover", { kind: "workspace", workspaceId: A });
  check((await backend.semaphoreCount(slot)) === 0, "every slot is handed back when its job is acknowledged");

  for (let i = 0; i < 4; i++) await dispatcher.enqueue("run.eval", A, { i }, { idempotencyKey: `e-${randomUUID()}` });
  const evals: Admission<unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    const admitted = await dispatcher.tryAdmit("run.eval");
    if (admitted) evals.push(admitted);
  }
  check(evals.length === 4, "a class the dispatcher does not cap per workspace admits as it always has", String(evals.length));
  for (const e of evals) await dispatcher.ack("run.eval", e.leaseId);
  return failed;
}

console.log("\nInMemoryQueueBackend");
failures += (await runQueueConformance("in-memory", new InMemoryQueueBackend())).failures;

console.log("\nRedisQueueBackend, on the in-process Lua fixture");
failures += (
  await runQueueConformance("redis-lua", new RedisQueueBackend(new MockRedis() as unknown as Redis))
).failures;

console.log("\nthe dispatcher holds a workspace to its own discovery limit");
failures += await workspaceCap("in-memory", new InMemoryQueueBackend());
failures += await workspaceCap("redis-lua", new RedisQueueBackend(new MockRedis() as unknown as Redis));

const url = redisUrlFromEnv();
if (!url) {
  console.log(
    `\nNOTE: no JAROKU_REDIS_URL, so the run above used the in-process Lua fixture rather than a\n` +
      `real broker. \`docker compose up -d redis\` and JAROKU_REDIS_URL=redis://127.0.0.1:6380 runs\n` +
      `the identical scenarios against the real thing.`,
  );
} else {
  const client = openRedis({ url });
  if (!(await pingRedis(client))) {
    console.log(`\nSKIPPED: JAROKU_REDIS_URL is set but unreachable at ${url}`);
    client.disconnect();
  } else {
    console.log("\nRedisQueueBackend");
    try {
      failures += (await runQueueConformance("redis", new RedisQueueBackend(client))).failures;
      failures += await workspaceCap("redis", new RedisQueueBackend(client));
    } finally {
      client.disconnect();
    }
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
