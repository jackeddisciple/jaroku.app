-- 089_eval_case_snapshot — what each eval actually ran with, kept on the eval.
--
-- WHAT FOR. An eval's results were built from its dataset's CURRENT cases, so editing a case
-- rewrote the input and expected output of every eval that had already run on it, deleting a case
-- dropped its row from past results while its job still counted in what was spent, and deleting
-- the dataset left its evals with no rows at all. The case a job ran is now copied onto the job
-- when the eval starts, and the dataset's name onto the eval, so a past comparison stays the
-- comparison that ran.
--
-- Nullable, an expand step. Existing jobs are filled from the cases as they are now — the closest
-- record left of what they ran — and a job whose case is already gone stays null.

ALTER TABLE eval_jobs ADD COLUMN input text;
ALTER TABLE eval_jobs ADD COLUMN expected text;
ALTER TABLE eval_runs ADD COLUMN dataset_name text;

UPDATE eval_jobs
   SET input = (SELECT e.input FROM dataset_examples e
                 WHERE e.id = eval_jobs.example_id AND e.workspace_id = eval_jobs.workspace_id),
       expected = (SELECT e.expected FROM dataset_examples e
                    WHERE e.id = eval_jobs.example_id AND e.workspace_id = eval_jobs.workspace_id)
 WHERE input IS NULL;

UPDATE eval_runs
   SET dataset_name = (SELECT d.name FROM datasets d
                        WHERE d.id = eval_runs.dataset_id AND d.workspace_id = eval_runs.workspace_id)
 WHERE dataset_name IS NULL;
