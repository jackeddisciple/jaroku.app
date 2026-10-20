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
import { EvalStore, checkDatasetName, uniqueDatasetName } from "./evalStore.ts";
import { ActivityStore } from "./activity/activityStore.ts";
import { resolveWindow } from "./activity/range.ts";

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
  // AN IMPORT ARRIVES IN THE FILE'S ORDER, and an edit does not move a row.
  const imported = await evals.createDataset(ctx, "quiet", "Imported");
  const lines = Array.from({ length: 12 }, (_, i) => ({ input: `order-check ${String(i + 1).padStart(2, "0")}` }));
  await evals.addExamples(ctx, imported.id, [...lines, { input: 'Quote, "with" commas' }]);
  const order = (await evals.listExamples(ctx, imported.id)).map((e) => e.input);
  check(`[${label}] thirteen imported rows keep the file's order`,
    JSON.stringify(order) === JSON.stringify([...lines.map((l) => l.input), 'Quote, "with" commas']), order.join(" | "));
  const first = (await evals.listExamples(ctx, imported.id))[0]!;
  await evals.updateExample(ctx, first.id, { input: "order-check 01 (edited)" });
  check(`[${label}] and editing the first leaves it first`, (await evals.listExamples(ctx, imported.id))[0]?.id === first.id);
  // A COPY: the cases in order, the check, the rubric — and a name of its own.
  await evals.setCheckMode(ctx, imported.id, "word");
  await evals.putRubric(ctx, { dataset_id: imported.id, name: "Custom", criteria: [{ id: "tone", label: "Tone", description: "kind", weight: 1 }] });
  const copy = (await evals.duplicateDataset(ctx, imported.id))!;
  check(`[${label}] a duplicate takes a name of its own`, copy.name === "Imported copy", copy.name);
  const copied = (await evals.listExamples(ctx, copy.id)).map((e) => e.input);
  const original = (await evals.listExamples(ctx, imported.id)).map((e) => e.input);
  check(`[${label}] and the cases, in order`, JSON.stringify(copied) === JSON.stringify(original), `${copied.length}`);
  check(`[${label}] and the check and rubric`, (await evals.getDataset(ctx, copy.id))?.check_mode === "word" && (await evals.rubricForDataset(ctx, copy.id))?.criteria[0]?.id === "tone");
  check(`[${label}] a second duplicate does not repeat the name`, (await evals.duplicateDataset(ctx, imported.id))?.name === "Imported copy 2");
  check(`[${label}] and an eval from before reads null, not version 0`,
    (await evals.getEvalRun(ctx, old))?.agent_version === null, String((await evals.getEvalRun(ctx, old))?.agent_version));
  // THE ACTIVITY FEED NAMES AN EVAL BY ITS DATASET — the union's COALESCE over a correlated subquery
  // is a shape the two drivers type differently, so it is read on both — here with no name kept.
  const named = await evals.createEvalRun(ctx, {
    dataset_id: imported.id, agent_id: "quiet", rubric_id: rubric, targets: [], budget_usd: null, dataset_name: null,
  });
  const feed = await new ActivityStore(db).feed(ctx, resolveWindow("30d", new Date(Date.now() + 1000), null), { kinds: ["eval"] });
  const row = feed.rows.find((r) => r.id === `eval:${named.id}`);
  check(`[${label}] an eval reads in the Activity feed by its dataset's name`, row?.object === "Imported", JSON.stringify(row));
}

console.log("\na new dataset's name is one this agent does not have");
{
  // From the count: delete one of three, add one, and there were two "Test set 3".
  check("the first is Test set", uniqueDatasetName([]) === "Test set");
  check("after a delete it skips the names still in use",
    uniqueDatasetName(["Test set", "Test set 3"]) === "Test set 2" && uniqueDatasetName(["Test set", "Test set 2", "Test set 3"]) === "Test set 4");
  check("a typed name is made unique the same way", uniqueDatasetName(["Screening"], "Screening") === "Screening 2");
  check("a blank name is refused in words", "error" in checkDatasetName("   "));
  check("so is one past 80 characters", "error" in checkDatasetName("x".repeat(115)));
  const tidy = checkDatasetName("  Screening   cases ");
  check("and a name is tidied", !("error" in tidy) && tidy.name === "Screening cases");
}

await suite("sqlite", await openTestSqlite());
await withScratchPostgres((db) => suite("postgres", db));

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
