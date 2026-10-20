-- 093_judge_own_key — the workspace's own Anthropic key, for the eval judge only.
--
-- The Postgres migration of the same number says why.

ALTER TABLE workspace_balances
  ADD COLUMN judge_own_key INTEGER NOT NULL DEFAULT 0;
