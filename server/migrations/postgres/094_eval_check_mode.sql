-- 094_eval_check_mode — checking answers against `expected`, without a model.
--
-- WHAT FOR. A case's expected output was only ever handed to the judge, so with no judge it did
-- nothing. A dataset can now say how an answer is checked against it — exact, contains, the word, or a
-- pattern — and each eval keeps the mode it ran with, so changing it later does not re-grade the past.
--
-- Nullable, an expand step. Null is "not checked", which is what every dataset and eval was.

ALTER TABLE datasets ADD COLUMN check_mode text;
ALTER TABLE eval_runs ADD COLUMN check_mode text;
