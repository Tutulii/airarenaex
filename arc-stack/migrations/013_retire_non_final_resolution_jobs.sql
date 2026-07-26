-- A live-health observation must never be processed as a settlement job.
-- This migration retires jobs created by the pre-close scheduling regression
-- and releases their markets for the corrected watcher to observe after close.

WITH non_final_jobs AS (
  SELECT id
    FROM arc_jobs
   WHERE kind = 'RESOLVE_MARKET'
     AND status IN ('PENDING', 'RUNNING', 'FAILED')
     AND (
       COALESCE((payload->'primary'->>'finalResult')::boolean, false) = false
       OR COALESCE((payload->'witness'->>'finalResult')::boolean, false) = false
     )
)
UPDATE arc_markets AS market
   SET resolution_job_id = NULL,
       updated_at = clock_timestamp()
 WHERE market.status = 'OPEN'
   AND market.resolution_job_id IN (SELECT id FROM non_final_jobs);

UPDATE arc_jobs
   SET status = 'DEAD',
       last_error = 'non_final_resolution_job_retired',
       locked_at = NULL,
       locked_by = NULL,
       updated_at = clock_timestamp()
 WHERE kind = 'RESOLVE_MARKET'
   AND status IN ('PENDING', 'RUNNING', 'FAILED')
   AND (
     COALESCE((payload->'primary'->>'finalResult')::boolean, false) = false
     OR COALESCE((payload->'witness'->>'finalResult')::boolean, false) = false
   );
