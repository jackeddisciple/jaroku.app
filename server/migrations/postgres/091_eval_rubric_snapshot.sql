-- 091_eval_rubric_snapshot — the rubric an eval was scored against, kept on the eval.
--
-- WHAT FOR. An eval named its rubric by id, and the rubric is editable: a criterion edited while
-- the eval was still being judged changed what the rest of it was scored on, a removed criterion
-- left past verdicts with scores nothing could label, and a dataset's own rubric could never be
-- reset to the built-in one without taking the history that pointed at it along. The criteria an
-- eval starts with are now copied onto it, and its judge and its results read that copy.
--
-- Nullable, an expand step. Existing evals are filled from their rubric as it is now — the closest
-- record left of what they were judged on.

ALTER TABLE eval_runs ADD COLUMN rubric json;

UPDATE eval_runs
   SET rubric = (SELECT r.criteria FROM rubrics r
                  WHERE r.id = eval_runs.rubric_id AND r.workspace_id = eval_runs.workspace_id)
 WHERE rubric IS NULL;
