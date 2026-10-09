/**
 * Persistent safety state for exact Historical Replay: the consumed-token
 * ledger and the replay columns of the raw-stock recalc undo log.
 *
 * Authored as migrations/0007_factory_historical_replay_safety.sql, which no
 * wired runner executes, so fresh databases (CI, new installs) got the older
 * undo-log shape from ensureUndoLogTable(): integer user ids, no
 * operation_type / algorithm_version / scope_fingerprint, and no token table
 * at all. Production was repaired by hand and matches this file exactly.
 * ensureUndoLogTable() now runs these statements on every boot, and the
 * ordered startup pass includes them. Every statement is idempotent.
 */
export const historicalReplaySafetySchema: string[] = [
  `CREATE TABLE IF NOT EXISTS "factory_replay_consumed_tokens" (
  "token_hash" TEXT PRIMARY KEY,
  "company_id" INTEGER NOT NULL,
  "user_id" TEXT,
  "replay_algorithm_version" TEXT NOT NULL,
  "scope_fingerprint" TEXT NOT NULL,
  "consumed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `ALTER TABLE "factory_replay_consumed_tokens"
  ADD COLUMN IF NOT EXISTS "user_id" TEXT`,
  `ALTER TABLE "factory_replay_consumed_tokens"
  ADD COLUMN IF NOT EXISTS "replay_algorithm_version" TEXT`,
  `ALTER TABLE "factory_replay_consumed_tokens"
  ADD COLUMN IF NOT EXISTS "scope_fingerprint" TEXT`,
  `ALTER TABLE "factory_replay_consumed_tokens"
  ADD COLUMN IF NOT EXISTS "consumed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE "factory_replay_consumed_tokens"
  ALTER COLUMN "user_id" TYPE TEXT USING "user_id"::TEXT`,
  `CREATE INDEX IF NOT EXISTS "factory_replay_consumed_tokens_company_consumed_idx"
  ON "factory_replay_consumed_tokens" ("company_id", "consumed_at" DESC)`,
  `CREATE TABLE IF NOT EXISTS "factory_recalc_undo_log" (
  "id" SERIAL PRIMARY KEY,
  "company_id" INTEGER NOT NULL,
  "user_id" TEXT,
  "username" TEXT,
  "description" TEXT NOT NULL,
  "container_count" INTEGER NOT NULL DEFAULT 0,
  "container_numbers" TEXT[] NOT NULL DEFAULT '{}',
  "snapshot" JSONB NOT NULL,
  "operation_type" TEXT NOT NULL DEFAULT 'RAW_STOCK_RECALC',
  "algorithm_version" TEXT,
  "scope_fingerprint" TEXT,
  "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "undone_at" TIMESTAMPTZ,
  "undone_by_user_id" TEXT,
  "undone_by_username" TEXT
)`,
  `ALTER TABLE "factory_recalc_undo_log"
  ADD COLUMN IF NOT EXISTS "user_id" TEXT`,
  `ALTER TABLE "factory_recalc_undo_log"
  ADD COLUMN IF NOT EXISTS "undone_by_user_id" TEXT`,
  `ALTER TABLE "factory_recalc_undo_log"
  ADD COLUMN IF NOT EXISTS "operation_type" TEXT NOT NULL DEFAULT 'RAW_STOCK_RECALC'`,
  `ALTER TABLE "factory_recalc_undo_log"
  ADD COLUMN IF NOT EXISTS "algorithm_version" TEXT`,
  `ALTER TABLE "factory_recalc_undo_log"
  ADD COLUMN IF NOT EXISTS "scope_fingerprint" TEXT`,
  `ALTER TABLE "factory_recalc_undo_log"
  ALTER COLUMN "user_id" TYPE TEXT USING "user_id"::TEXT`,
  `ALTER TABLE "factory_recalc_undo_log"
  ALTER COLUMN "undone_by_user_id" TYPE TEXT USING "undone_by_user_id"::TEXT`,
  `CREATE INDEX IF NOT EXISTS "factory_recalc_undo_log_company_applied_idx"
  ON "factory_recalc_undo_log" ("company_id", "applied_at" DESC)`,
  `CREATE INDEX IF NOT EXISTS "factory_recalc_undo_log_exact_fingerprint_idx"
  ON "factory_recalc_undo_log" ("company_id", "scope_fingerprint")
  WHERE "operation_type" = 'HISTORICAL_REPLAY_EXACT'`,
];
