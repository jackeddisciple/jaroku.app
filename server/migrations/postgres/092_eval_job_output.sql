-- 092_eval_job_output — what the agent answered, kept on the job.
--
-- WHAT FOR. The drill-down's own header says it is where you find out "what each one actually
-- answered", and it showed a status, a cost and a latency: the answer was only in the trace, one
-- click and a tab away, and nowhere in an export. The agent's final answer — the same text the judge
-- is shown, from judge/output.ts — is kept on the job when its run ends, so a result can be read, and
-- checked against what was expected, without opening the trace.
--
-- Nullable, an expand step. Null is "not kept": a job from before this, or one whose run said nothing.

ALTER TABLE eval_jobs ADD COLUMN output text;
