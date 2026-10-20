// The eval history: which evals a list shows, and what a deleted dataset leaves behind.
//
// Three things went wrong here, each of them a list that stopped answering:
//
//   * THE FILTER RAN AFTER THE WINDOW. The workspace's newest fifty were read and one dataset's
//     picked out of them, so with fifty evals elsewhere "older…" widened the window for ever and
//     never added one of this dataset's.
//   * A DELETED DATASET'S EVALS WERE UNREACHABLE. The tab lists evals by dataset, and the dataset is
//     gone — so each row now says whether its dataset still exists, and an agent-wide list finds them.
//   * ITS RUBRIC STAYED BEHIND, orphaned, unless an eval scored with it.
//
// Run on SQLite and, when JAROKU_PG_URL is set, on a scratch Postgres: the existence check is a
// correlated subquery in a SELECT list, which is exactly the shape that differs between the two.
//
//   npm run test:eval-history

import type { Db } from "./db/db.ts";
import { openTestSqlite, testContext, withScratchPostgres } from "./db/testDb.ts";
import { EvalStore } from "./evalStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const evals = new EvalStore(db);
  await evals.init();
  const ctx = testContext();
  const rubric = (await evals.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] })).id;
  const run = async (agent: string, datasetId: string, rubricId = rubric) =>
    (await evals.createEvalRun(ctx, {
      dataset_id: datasetId, agent_id: agent, rubric_id: rubricId,
      targets: [{ provider: "fake", model: "fake" }], budget_usd: 1,
    })).id;

  const mine = await evals.createDataset(ctx, "quiet", "Screening cases");
  const theirs = await evals.createDataset(ctx, "noisy", "Lots");
  const old = await run("quiet", mine.id);
  await db.forWorkspace(ctx.workspaceId).run(`UPDATE eval_runs SET started_at = ? WHERE id = ?`, ["2026-01-01T00:00:00.000Z", old]);
  for (let i = 0; i < 6; i++) await run("noisy", theirs.id);

  const windowOfFive = await evals.listEvalRuns(ctx, { limit: 5, datasetId: mine.id });
  check(`[${label}] a dataset's list is filtered before the window, not after it`,
    windowOfFive.length === 1 && windowOfFive[0]?.id === old, JSON.stringify(windowOfFive.map((e) => e.id)));
  const agentWide = await evals.listEvalRuns(ctx, { limit: 5, agentId: "quiet" });
  check(`[${label}] so is an agent's`, agentWide.length === 1 && agentWide[0]?.agent_id === "quiet");
  check(`[${label}] with its dataset there`, agentWide[0]?.dataset_gone === false);

  // A rubric of its own that an eval scored with, and one nothing ever used.
  const scored = await evals.putRubric(ctx, { dataset_id: mine.id, name: "Custom", criteria: [] });
  await run("quiet", mine.id, scored.id);
  const spare = await evals.createDataset(ctx, "quiet", "Spare");
  const unused = await evals.putRubric(ctx, { dataset_id: spare.id, name: "Custom", criteria: [] });

  await evals.deleteDataset(ctx, mine.id);
  await evals.deleteDataset(ctx, spare.id);
  const afterDelete = await evals.listEvalRuns(ctx, { agentId: "quiet" });
  check(`[${label}] a deleted dataset's evals are still listed for its agent`, afterDelete.length === 2, `${afterDelete.length}`);
  check(`[${label}] and say their dataset is gone`, afterDelete.every((e) => e.dataset_gone), JSON.stringify(afterDelete.map((e) => e.dataset_gone)));
  check(`[${label}] the rubric an eval scored with is kept, as history`, (await evals.getRubric(ctx, scored.id)) !== undefined);
  check(`[${label}] and the one nothing used is not left orphaned`, (await evals.getRubric(ctx, unused.id)) === undefined);

  // WHICH VERSION IT RAN AGAINST (migration 090) — a number on both drivers, and null when unknown.
  const versioned = await evals.createEvalRun(ctx, {
    dataset_id: theirs.id, agent_id: "noisy", rubric_id: rubric, targets: [], budget_usd: null, agent_version: 7,
  });
  check(`[${label}] an eval keeps the agent version it ran against`, (await evals.getEvalRun(ctx, versioned.id))?.agent_version === 7);
  // THE CRITERIA IT WAS SCORED ON (migration 091), kept through an edit and a reset of the rubric.
  const custom = await evals.putRubric(ctx, { dataset_id: theirs.id, name: "Custom", criteria: [{ id: "tone", label: "Tone", description: "kind", weight: 1 }] });
  const judged = await evals.createEvalRun(ctx, {
    dataset_id: theirs.id, agent_id: "noisy", rubric_id: custom.id, targets: [], budget_usd: null, rubric: custom.criteria,
  });
  await evals.putRubric(ctx, { id: custom.id, dataset_id: theirs.id, name: "Custom", criteria: [{ id: "speed", label: "Speed", description: "fast", weight: 1 }] });
  await evals.deleteRubricForDataset(ctx, theirs.id);
  const kept = (await evals.getEvalRun(ctx, judged.id))?.rubric;
  check(`[${label}] an eval keeps the criteria it was scored on through an edit and a reset`,
    kept?.length === 1 && kept[0]?.id === "tone", JSON.stringify(kept));
  check(`[${label}] and the reset removed the dataset's own rubric`, (await evals.rubricForDataset(ctx, theirs.id)) === undefined);
  check(`[${label}] and an eval from before reads null, not version 0`,
    (await evals.getEvalRun(ctx, old))?.agent_version === null, String((await evals.getEvalRun(ctx, old))?.agent_version));
}

await suite("sqlite", await openTestSqlite());
await withScratchPostgres((db) => suite("postgres", db));

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
