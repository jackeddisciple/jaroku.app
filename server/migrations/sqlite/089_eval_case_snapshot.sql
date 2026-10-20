-- 089_eval_case_snapshot — what each eval actually ran with, kept on the eval.
--
-- The Postgres migration of the same number says why. Existing jobs are filled from the cases as
-- they are now; a job whose case is already gone stays null.
--
-- AND ON THIS DRIVER, THE FOREIGN KEY FROM A JOB TO ITS CASE GOES. Postgres never had it. Here it
-- made a case — or a whole dataset — that an eval had run impossible to delete: `node:sqlite` has
-- foreign keys on, so the delete failed with "constraint failed". Now that a job keeps its own copy
-- of the case there is nothing for that key to protect. SQLite cannot drop a constraint in place, so
-- the table is written again, in the idiom of 006 and 066 and for 066's reason: `DROP TABLE` performs
-- an implicit delete, and every score row referencing a job counts as a violation that rows inserted
-- under the rebuilt table's name never cancel, so the migration failed at COMMIT on any database
-- that had a scored eval. The scores step aside into a holding table first and come back once the
-- new table carries the same ids. Both indexes are recreated, because `DROP TABLE` takes them too.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE eval_scores_hold AS SELECT * FROM eval_scores;
DELETE FROM eval_scores;

CREATE TABLE eval_jobs_rebuilt (
  id               TEXT PRIMARY KEY,
  eval_id          TEXT NOT NULL,
  example_id       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  run_id           TEXT,
  cost_usd         REAL,
  tokens           INTEGER,
  latency_ms       REAL,
  cost_complete    INTEGER NOT NULL DEFAULT 1,
  error            TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  retry_not_before TEXT,
  spent_usd        REAL NOT NULL DEFAULT 0,
  position         INTEGER NOT NULL DEFAULT 0,
  workspace_id     TEXT NOT NULL DEFAULT '',
  input            TEXT,
  expected         TEXT,
  FOREIGN KEY (eval_id) REFERENCES eval_runs(id)
);

INSERT INTO eval_jobs_rebuilt (
  id, eval_id, example_id, provider, model, status, attempt, run_id, cost_usd, tokens, latency_ms,
  cost_complete, error, started_at, ended_at, retry_not_before, spent_usd, position, workspace_id,
  input, expected
)
SELECT
  j.id, j.eval_id, j.example_id, j.provider, j.model, j.status, j.attempt, j.run_id, j.cost_usd,
  j.tokens, j.latency_ms, j.cost_complete, j.error, j.started_at, j.ended_at, j.retry_not_before,
  j.spent_usd, j.position, j.workspace_id,
  (SELECT e.input FROM dataset_examples e WHERE e.id = j.example_id AND e.workspace_id = j.workspace_id),
  (SELECT e.expected FROM dataset_examples e WHERE e.id = j.example_id AND e.workspace_id = j.workspace_id)
FROM eval_jobs j;

DROP TABLE eval_jobs;
ALTER TABLE eval_jobs_rebuilt RENAME TO eval_jobs;
CREATE INDEX eval_jobs_ws_status ON eval_jobs (workspace_id, eval_id, status);
CREATE INDEX eval_jobs_ws_run    ON eval_jobs (workspace_id, run_id);

INSERT INTO eval_scores SELECT * FROM eval_scores_hold;
DROP TABLE eval_scores_hold;

ALTER TABLE eval_runs ADD COLUMN dataset_name TEXT;

UPDATE eval_runs
   SET dataset_name = (SELECT d.name FROM datasets d
                        WHERE d.id = eval_runs.dataset_id AND d.workspace_id = eval_runs.workspace_id)
 WHERE dataset_name IS NULL;
