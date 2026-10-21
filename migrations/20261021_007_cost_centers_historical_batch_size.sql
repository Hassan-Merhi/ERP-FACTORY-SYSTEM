-- Cost Centers: historical allocation batches may hold up to 10,000 eligible
-- expense lines (was 100). Only the analytical batch table's CHECK changes;
-- no accounting table or row is touched. Safe to re-run.
ALTER TABLE cost_center_historical_batches
  DROP CONSTRAINT IF EXISTS cost_center_historical_batches_count_ck;
ALTER TABLE cost_center_historical_batches
  ADD CONSTRAINT cost_center_historical_batches_count_ck
  CHECK (candidate_count BETWEEN 1 AND 10000);
