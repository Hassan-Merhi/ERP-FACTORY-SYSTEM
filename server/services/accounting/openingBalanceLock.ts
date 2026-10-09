import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";
import { CLOSED_PERIOD_ERROR_CODE } from "../../lib/closedPeriodError";
import { CLOSED_PERIOD_LOCK_NAMESPACE } from "./closedPeriodGuard";

/**
 * Opening balances under the period lock (wave 12, re-audit section 8).
 *
 * Master opening balances (ledger accounts, customers, suppliers, bank
 * accounts, employees) are dated before the books start, so they sit inside
 * the first closed period: changing one after a close changes balances the
 * closing journal already moved. Rule chosen: once a company has ANY closed
 * fiscal period, no opening on those tables may be created non-zero, changed,
 * or moved to another company. Corrections are posted as a journal dated in
 * an open period, or the period is reopened.
 *
 * Enforced by BEFORE triggers so every writer (master edit routes,
 * zero-balances, imports, resets) is covered. The bypass is the closed-period
 * guard's: the maintenance scope or a transaction-local
 * `app.closed_period_override = 'on'` (used by the fiscal reopen when it
 * restores a legacy close's zeroed openings). The rejection carries the
 * closed-period SQLSTATE and marker, so routes map it to 409 with
 * closedPeriodErrorResponse / errorStatus. A shared advisory lock on the
 * company serialises the check against a concurrent close.
 */

export const OPENING_BALANCE_LOCK_TABLES = [
  "ledger_accounts",
  "customers",
  "suppliers",
  "bank_accounts",
  "employees",
] as const;

export const OPENING_BALANCE_LOCK_VERSION = "2026-10-opening-balance-lock-v1";

export const openingBalanceLockTriggerName = (table: string) => `${table}_opening_balance_lock`;

export const OPENING_BALANCE_LOCK_DDL: readonly string[] = [
  `CREATE OR REPLACE FUNCTION erp_assert_opening_balance_open(p_company_id integer) RETURNS void
   LANGUAGE plpgsql AS $fn$
   DECLARE
     locked_through date;
   BEGIN
     IF p_company_id IS NULL OR erp_closed_period_guard_bypassed() THEN RETURN; END IF;
     PERFORM pg_advisory_xact_lock_shared(${CLOSED_PERIOD_LOCK_NAMESPACE}, p_company_id);
     SELECT max(period_end_date) INTO locked_through
       FROM fiscal_period_closures WHERE company_id = p_company_id AND status = 'CLOSED';
     IF locked_through IS NOT NULL THEN
       RAISE EXCEPTION USING
         ERRCODE = '${CLOSED_PERIOD_ERROR_CODE}',
         MESSAGE = format(
           'ACCOUNTING_PERIOD_CLOSED: the books are closed through %s, so an opening balance cannot be created or changed',
           locked_through
         ),
         HINT = 'Post an adjusting journal dated after the closed period, or reopen the period.';
     END IF;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION erp_opening_balance_lock_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     new_amount numeric := COALESCE(NEW.opening_balance, 0);
     old_amount numeric;
   BEGIN
     IF TG_OP = 'INSERT' THEN
       IF new_amount <> 0 THEN PERFORM erp_assert_opening_balance_open(NEW.company_id); END IF;
       RETURN NEW;
     END IF;
     old_amount := COALESCE(OLD.opening_balance, 0);
     IF new_amount <> old_amount
        OR (new_amount <> 0 AND COALESCE(NEW.opening_balance_side, 'Dr') IS DISTINCT FROM COALESCE(OLD.opening_balance_side, 'Dr'))
        OR ((new_amount <> 0 OR old_amount <> 0) AND NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
       PERFORM erp_assert_opening_balance_open(OLD.company_id);
       IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
         PERFORM erp_assert_opening_balance_open(NEW.company_id);
       END IF;
     END IF;
     RETURN NEW;
   END $fn$`,
  ...OPENING_BALANCE_LOCK_TABLES.flatMap((table) => [
    `DROP TRIGGER IF EXISTS ${openingBalanceLockTriggerName(table)} ON ${table}`,
    `CREATE TRIGGER ${openingBalanceLockTriggerName(table)}
       BEFORE INSERT OR UPDATE OF opening_balance, opening_balance_side, company_id ON ${table}
       FOR EACH ROW EXECUTE FUNCTION erp_opening_balance_lock_guard()`,
  ]),
];

const INSTALL_LOCK_KEY = 2026_10_120;

type Queryable = { query: Pool["query"] };

/** The installed lock version, or null when any of its triggers is missing. */
export async function installedOpeningBalanceLockVersion(client: Queryable): Promise<string | null> {
  const names = OPENING_BALANCE_LOCK_TABLES.map((table) => `'${openingBalanceLockTriggerName(table)}'`).join(", ");
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_opening_balance_lock_guard()'), 'pg_proc') AS version
      WHERE (SELECT COUNT(DISTINCT tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${names}))
            = ${OPENING_BALANCE_LOCK_TABLES.length}`
  );
  return result.rows[0]?.version ?? null;
}

/**
 * Installs the lock on every boot, after the closed-period guard (whose bypass
 * function it uses). Idempotent; fatal on failure with a lock timeout, like the
 * closed-period guard.
 */
export async function ensureOpeningBalanceLock(pool: Pick<Pool, "connect">): Promise<true> {
  const client = await pool.connect();
  try {
    if ((await installedOpeningBalanceLockVersion(client)) === OPENING_BALANCE_LOCK_VERSION) {
      logger.info(`[startup] ✓ Opening balance lock already installed (${OPENING_BALANCE_LOCK_VERSION})`);
      return true;
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    for (const statement of OPENING_BALANCE_LOCK_DDL) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION erp_opening_balance_lock_guard() IS '${OPENING_BALANCE_LOCK_VERSION}'`);
    await client.query("COMMIT");
    logger.info(`[startup] ✓ Opening balance lock ensured (${OPENING_BALANCE_LOCK_VERSION})`);
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const reason = getErrorMessage(error);
    logger.error("[startup] ✗ Opening balance lock could not be installed; refusing to start", {
      version: OPENING_BALANCE_LOCK_VERSION,
      error: reason,
    });
    // Fatal: the caller (server/index.ts) aborts startup; the log above says why.
    throw error;
  } finally {
    client.release();
  }
}
