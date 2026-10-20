-- 091_eval_rubric_snapshot — the rubric an eval was scored against, kept on the eval.
--
-- The Postgres migration of the same number says why. Existing evals are filled from their rubric
-- as it is now.

ALTER TABLE eval_runs ADD COLUMN rubric TEXT;

UPDATE eval_runs
   SET rubric = (SELECT r.criteria FROM rubrics r
                  WHERE r.id = eval_runs.rubric_id AND r.workspace_id = eval_runs.workspace_id)
 WHERE rubric IS NULL;
