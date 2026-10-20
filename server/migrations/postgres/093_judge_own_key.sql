-- 093_judge_own_key — the workspace's own Anthropic key, for the eval judge only.
--
-- WHAT FOR. With no platform key for the judge, every eval in production came back unscored — the
-- Quality column, the rubric editor and "best quality" did nothing — and the only way to judge on the
-- workspace's own key was `own_key_for_platform`, which also moves generation, edits and chat onto it.
-- This is the narrower switch the Evals tab offers: the judge, and nothing else, spends the key.
--
-- Defaulted false, an expand step: nothing changes for a workspace until somebody turns it on.

ALTER TABLE workspace_balances
  ADD COLUMN judge_own_key boolean NOT NULL DEFAULT false;
