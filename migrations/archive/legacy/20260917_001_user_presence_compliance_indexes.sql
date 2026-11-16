-- Remote support / compliance exposure — user_presence hot-path indexes.
--
-- Purpose:
--   The Active Users panel and the screen-feed tenant gate both filter
--   user_presence by last_seen (and often company_id / user_id). Without these
--   indexes every heartbeat cleanup and Watch panel refresh is a sequential
--   scan of the full presence table.
--
-- Safety:
--   * Index-only migration; no data or accounting logic is changed.
--   * Every statement is idempotent (IF NOT EXISTS).
--   * Safe to re-run. Also applied at boot via startup-schema so fresh databases
--     and long-lived production instances converge without a separate runner.

CREATE INDEX IF NOT EXISTS user_presence_last_seen_idx
  ON user_presence (last_seen);

CREATE INDEX IF NOT EXISTS user_presence_company_last_seen_idx
  ON user_presence (company_id, last_seen);

CREATE INDEX IF NOT EXISTS user_presence_user_last_seen_idx
  ON user_presence (user_id, last_seen);
