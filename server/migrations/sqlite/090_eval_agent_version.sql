-- 090_eval_agent_version — which version of the agent an eval ran against.
--
-- The Postgres migration of the same number says why. Null is "from before this was recorded".

ALTER TABLE eval_runs ADD COLUMN agent_version INTEGER;
