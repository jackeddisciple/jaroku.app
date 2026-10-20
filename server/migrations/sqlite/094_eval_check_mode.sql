-- 094_eval_check_mode — checking answers against `expected`, without a model.
--
-- The Postgres migration of the same number says why. Null is "not checked".

ALTER TABLE datasets ADD COLUMN check_mode TEXT;
ALTER TABLE eval_runs ADD COLUMN check_mode TEXT;
