// Telling an eval's runs apart from the runs an agent does for people.
//
// AN EVAL'S JOBS ARE ORDINARY RUNS, by design — one way to run an agent, one trace. But they are not
// the agent's working life: fifteen runs of a test set counted toward its health ("Degraded" because
// a comparison stopped over budget), its "last model" (whatever the eval tried last), the Activity
// leaderboard's success rate and the model mix. Those figures describe how the agent does its job, so
// they leave eval runs out. Spend does not — what an eval cost is money spent.
//
// An eval's run is one a job of `eval_jobs` points at. The job keeps its latest attempt's run, so an
// earlier attempt of a retried job is not recognised here — a small undercount of what is left out,
// in exchange for no column on `runs`, the largest table there is.

/** SQL: the `runs` row under `alias` is not one of an eval's. Scoped by workspace like every read. */
export function notEvalRun(alias: string, runIdColumn = "id"): string {
  return `NOT EXISTS (SELECT 1 FROM eval_jobs ej WHERE ej.run_id = ${alias}.${runIdColumn} AND ej.workspace_id = ${alias}.workspace_id)`;
}

/** SQL: the eval this `runs` row belongs to, or NULL — for a list that tags rather than leaves out. */
export function evalIdOfRun(alias: string): string {
  return `(SELECT ej.eval_id FROM eval_jobs ej WHERE ej.run_id = ${alias}.id AND ej.workspace_id = ${alias}.workspace_id LIMIT 1)`;
}
