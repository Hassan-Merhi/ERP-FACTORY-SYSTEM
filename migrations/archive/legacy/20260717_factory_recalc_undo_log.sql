-- Factory raw-stock recalculation history/undo storage.
-- Apply this migration before deploying code that uses the History & Undo tab.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS factory_recalc_undo_log (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER      NOT NULL,
  user_id              INTEGER,
  username             TEXT,
  description          TEXT         NOT NULL,
  container_count      INTEGER      NOT NULL DEFAULT 0,
  container_numbers    TEXT[]       NOT NULL DEFAULT '{}',
  snapshot             JSONB        NOT NULL,
  applied_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  undone_at             TIMESTAMPTZ,
  undone_by_user_id    INTEGER,
  undone_by_username   TEXT
);

CREATE INDEX IF NOT EXISTS factory_recalc_undo_log_company_applied_idx
  ON factory_recalc_undo_log (company_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS factory_recalc_undo_log_company_active_idx
  ON factory_recalc_undo_log (company_id, undone_at)
  WHERE undone_at IS NULL;
