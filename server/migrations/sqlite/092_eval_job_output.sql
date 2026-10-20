-- 092_eval_job_output — what the agent answered, kept on the job.
--
-- The Postgres migration of the same number says why. Null is "not kept".

ALTER TABLE eval_jobs ADD COLUMN output TEXT;
