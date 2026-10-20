-- 090_eval_agent_version — which version of the agent an eval ran against.
--
-- WHAT FOR. An eval compares models on an agent, and the agent changes: an edit between two evals
-- moves every number, and nothing recorded which code either of them ran. The version the agent was
-- on when the eval started is kept with the eval, so two comparisons across an edit can be told
-- apart — and a comparison that looks like a regression can be checked against the edit that caused it.
--
-- Nullable, an expand step. Null is "from before this was recorded"; nothing is backfilled, because
-- the version an old eval ran against is not known.

ALTER TABLE eval_runs ADD COLUMN agent_version integer;
