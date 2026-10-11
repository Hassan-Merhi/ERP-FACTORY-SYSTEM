import { Client } from "pg";

import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { resolveDatabaseSsl } from "../lib/databaseSsl.mjs";
import { markStartupMigrationsComplete, recordStartupMigrationFailures } from "../startupMigrationReport";

export async function runStartupMigrations(migrations: readonly string[], onComplete: () => void) {
  // Use a dedicated single Client for migrations — completely separate from the
  // shared connection pool so migrations never starve user requests of connections.
  const connectionString =
    process.env.DATABASE_URL ||
    `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;
  let migrationClient = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
  });

  try {
    await migrationClient.connect();
    // 30 s lock_timeout: generous enough for a busy production DB to release
    // in-flight queries before the DDL lock is granted, but still bounded so a
    // truly stuck table doesn't hang the server indefinitely.
    await migrationClient.query(`SET lock_timeout = '30s'`);
    await migrationClient.query(`SET statement_timeout = '120s'`);
    // Convert any "ALTER TABLE t ADD COLUMN IF NOT EXISTS col ..."  to a DO
    // block that first checks information_schema.columns.  If the column
    // already exists the DO block is a no-op and never requests an ACCESS
    // EXCLUSIVE lock, preventing it from blocking concurrent SELECT queries.
    const addColRe = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+([\s\S]+?)\s*$/i;
    function safeMigration(sql: string): string {
      const m = sql.match(addColRe);
      if (!m) return sql;
      const [, table, column, rest] = m;
      return `DO $mig$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = '${table}' AND column_name = '${column}'
  ) THEN
    ALTER TABLE ${table} ADD COLUMN ${column} ${rest};
  END IF;
END $mig$`;
    }

    const failedMigrations: Array<{ sql: string; error: string }> = [];

    for (const migration of migrations) {
      try {
        await migrationClient.query(safeMigration(migration));
      } catch (err: unknown) {
        const errMsg: string = getErrorMessage(err) ?? String(err);
        const errCode: string = (err as { code?: string }).code ?? "";
        // PG connection-drop codes: 57P01 admin_shutdown, 08006 connection_failure,
        // 08003 connection_does_not_exist, 08001 unable_to_connect
        const isConnDrop =
          ["57P01", "08006", "08003", "08001", "08004"].includes(errCode) ||
          /terminating connection|connection.*reset|could not connect|connection closed|socket.*hang/i.test(errMsg);

        // PG lock_timeout code is 55P03
        const isLockTimeout =
          errCode === "55P03" || /lock timeout|canceling statement due to lock timeout/i.test(errMsg);

        if (isConnDrop) {
          // Reconnect and retry once — if retry also fails, record as a failure
          logger.error(`[Migration] Connection dropped — reconnecting... (${errMsg.split("\n")[0]})`);
          try {
            await migrationClient.end().catch(() => {});
            migrationClient = new Client({
              connectionString,
              ssl: resolveDatabaseSsl(connectionString),
            });
            await migrationClient.connect();
            await migrationClient.query(`SET lock_timeout = '30s'`);
            await migrationClient.query(`SET statement_timeout = '120s'`);
            await migrationClient.query(safeMigration(migration));
            logger.info(`[Migration] Reconnected and retried successfully`);
          } catch (retryErr: unknown) {
            const retryMsg: string = getErrorMessage(retryErr) ?? String(retryErr);
            failedMigrations.push({
              sql: migration.trim().substring(0, 120),
              error: retryMsg.split("\n")[0],
            });
          }
        } else if (isLockTimeout) {
          // Lock timeout — wait 5 s for in-flight queries to drain, then retry once
          logger.warn(`[Migration] Lock timeout — waiting 5s before retry... (${migration.trim().substring(0, 80)})`);
          await new Promise((r) => setTimeout(r, 5000));
          try {
            await migrationClient.query(safeMigration(migration));
            logger.info(`[Migration] Lock-timeout retry succeeded`);
          } catch (retryErr: unknown) {
            const retryMsg: string = getErrorMessage(retryErr) ?? String(retryErr);
            failedMigrations.push({
              sql: migration.trim().substring(0, 120),
              error: `lock-timeout retry failed: ${retryMsg.split("\n")[0]}`,
            });
          }
        } else {
          // All other errors (syntax error, constraint, etc.) are
          // recorded as failures so the ops team has full visibility at ERROR level.
          failedMigrations.push({
            sql: migration.trim().substring(0, 120),
            error: errMsg.split("\n")[0],
          });
        }
      }
    }

    recordStartupMigrationFailures(failedMigrations); // published to /api/health/db

    if (failedMigrations.length > 0) {
      logger.error(`✗ ${failedMigrations.length} migration(s) failed at startup:`);
      for (const { sql, error } of failedMigrations) {
        logger.error(`  SQL: ${sql}`);
        logger.error(`  ERR: ${error}`);
      }
    } else {
      logger.info("✓ Database tables and columns verified/migrated");
    }

    // ── Post-migration critical-table existence check ────────────────────────
    // If any IC tables are missing (e.g. migration silently failed on a prior
    // deploy) log a clear startup ERROR so the ops team can act immediately.
    try {
      const IC_TABLES = ["intercompany_account_links", "intercompany_link_recipients", "intercompany_payment_requests"];
      const tableCheck = await migrationClient.query(
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [IC_TABLES]
      );
      const found = new Set<string>(tableCheck.rows.map((r) => r.table_name as string));
      const missing = IC_TABLES.filter((t) => !found.has(t));
      if (missing.length > 0) {
        logger.error(
          `✗ Missing critical tables after migration: ${missing.join(", ")} — ` +
            `IC notification feature will not work. Run the CREATE TABLE statements manually.`
        );
      }
    } catch (tableCheckErr: unknown) {
      logger.error(`[Migration] ✗ Could not verify IC table existence: ${getErrorMessage(tableCheckErr)}`);
    }

    // Backfill POS_EXPENSE daybook entries for any factory POS sales
    // that have expenses_json stored but no corresponding daybook rows yet
    try {
      await migrationClient.query(`
          INSERT INTO factory_daybook_entries
            (company_id, tx_date, tx_type, reference_id, reference_table,
             description, currency_code, amount_currency, fx_rate_to_usd, amount_usd)
          SELECT
            s.company_id,
            s.tx_date,
            'POS_EXPENSE',
            s.id,
            'factory_pos_sales',
            CONCAT(
              COALESCE(NULLIF(exp->>'description',''), 'Deduction'),
              ' – POS ', s.sale_number,
              CASE WHEN s.customer_name IS NOT NULL
                   THEN CONCAT(' (', s.customer_name, ')')
                   ELSE '' END
            ),
            COALESCE(s.currency_code, 'USD'),
            ROUND((exp->>'amount')::numeric, 2),
            1,
            ROUND((exp->>'amount')::numeric, 2)
          FROM factory_pos_sales s,
               jsonb_array_elements(s.expenses_json::jsonb) AS exp
          WHERE s.expenses_json IS NOT NULL
            AND s.expenses_json <> 'null'
            AND (exp->>'amount')::numeric > 0
            AND NOT EXISTS (
              SELECT 1 FROM factory_daybook_entries d
              WHERE d.reference_table = 'factory_pos_sales'
                AND d.reference_id = s.id
                AND d.tx_type = 'POS_EXPENSE'
            )
        `);
    } catch {
      /* table may not exist yet — skip */
    }

    // Ensure customer invoice sequences start at 11827 (or higher if already advanced)
    try {
      await migrationClient.query(`
          UPDATE customer_invoice_sequences
          SET next_number = 11827
          WHERE next_number < 11827
        `);
    } catch {
      /* skip if table not ready */
    }

    // Retired (2026-10 accounting audit): a step here swapped debit and credit on
    // every TR-IN voucher whose TRANSFER-CLEARING line was a debit, on every boot.
    // It was not one-shot, so it would also invert any later legitimate entry of
    // that shape. Posted entries are corrected with a reversing entry instead.

    // Fix: cascade overpaid rental months to the correct next available month.
    // Handles two cases:
    //   A) Current/past month with paid > expected (expected > 0)
    //   B) Future prepaid month with paid > contract rental_amount (expected = 0)
    // For each overpaid row the excess is moved to the FIRST month that still has
    // remaining capacity (paid < rental_amount), searching forward month by month.
    // Safe to re-run — idempotent as long as data is already clean.
    // Written as plain JS (not PL/pgSQL) so every step is logged and errors are visible.
    try {
      const now = new Date();
      const nowYear = now.getFullYear();
      const nowMonth = now.getMonth() + 1;

      const overpaidResult = await migrationClient.query(
        `
          SELECT
            pml.id,
            pml.company_id,
            pml.module,
            pml.contract_id,
            pml.unit_id,
            pml.year,
            pml.month,
            pml.expected_amount::numeric AS expected_amount,
            pml.paid_amount::numeric     AS paid_amount,
            pc.rental_amount::numeric    AS rental_amount
          FROM property_monthly_ledger pml
          JOIN property_contracts pc ON pc.id = pml.contract_id
          WHERE (
            (
              pml.expected_amount::numeric > 0
              AND pml.paid_amount::numeric > pml.expected_amount::numeric
              AND (pml.year < $1 OR (pml.year = $1 AND pml.month <= $2))
            )
            OR
            (
              pml.expected_amount::numeric = 0
              AND pml.paid_amount::numeric > pc.rental_amount::numeric
              AND pc.rental_amount::numeric > 0
            )
          )
          ORDER BY pml.contract_id, pml.year, pml.month
        `,
        [nowYear, nowMonth]
      );

      logger.info(`[RentalFix] Found ${overpaidResult.rows.length} overpaid ledger row(s) to fix`);

      for (const row of overpaidResult.rows) {
        const paidAmt = Number(row.paid_amount);
        const expectedAmt = Number(row.expected_amount);
        const rentalAmt = Number(row.rental_amount);

        const capacity = expectedAmt > 0 ? expectedAmt : rentalAmt;
        const excess = paidAmt - capacity;

        if (excess < 0.005) continue;

        logger.info(
          `[RentalFix] contract=${row.contract_id} ledger=${row.id} ` +
            `month=${row.year}/${row.month} paid=${paidAmt} capacity=${capacity} excess=${excess}`
        );

        // 1. Reduce the overpaid row
        await migrationClient.query(`UPDATE property_monthly_ledger SET paid_amount = paid_amount - $1 WHERE id = $2`, [
          excess.toFixed(2),
          row.id,
        ]);

        // 2. Search forward for the first month with remaining capacity
        let checkYear = row.year;
        let checkMonth = row.month + 1;
        if (checkMonth > 12) {
          checkMonth = 1;
          checkYear++;
        }

        let targetYear: number | null = null;
        let targetMonth: number | null = null;

        for (let i = 0; i < 200; i++) {
          const slotResult = await migrationClient.query(
            `SELECT paid_amount::numeric AS paid_amount
               FROM property_monthly_ledger
               WHERE contract_id = $1 AND year = $2 AND month = $3`,
            [row.contract_id, checkYear, checkMonth]
          );

          const slotPaid = slotResult.rows.length > 0 ? Number(slotResult.rows[0].paid_amount) : null;

          // Available if: row doesn't exist yet, OR paid < rental_amount
          if (slotPaid === null || slotPaid < rentalAmt) {
            targetYear = checkYear;
            targetMonth = checkMonth;
            break;
          }

          checkMonth++;
          if (checkMonth > 12) {
            checkMonth = 1;
            checkYear++;
          }
        }

        if (targetYear === null || targetMonth === null) {
          logger.warn(`[RentalFix] No target slot found for contract=${row.contract_id} ledger=${row.id} — skipping`);
          continue;
        }

        logger.info(`[RentalFix] → moving excess $${excess} to ${targetYear}/${targetMonth}`);

        // 3. Create or top-up the target month
        await migrationClient.query(
          `
            INSERT INTO property_monthly_ledger
              (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, 0, $7, NOW())
            ON CONFLICT (contract_id, year, month)
            DO UPDATE SET paid_amount = property_monthly_ledger.paid_amount + EXCLUDED.paid_amount
          `,
          [row.company_id, row.module, row.contract_id, row.unit_id, targetYear, targetMonth, excess.toFixed(2)]
        );

        // 4. Reassign the most-recent payment from the overpaid month → target month
        const newLedger = await migrationClient.query(
          `SELECT id FROM property_monthly_ledger
             WHERE contract_id = $1 AND year = $2 AND month = $3`,
          [row.contract_id, targetYear, targetMonth]
        );
        if (newLedger.rows.length > 0) {
          const newLedgerId = newLedger.rows[0].id;
          await migrationClient.query(
            `
              UPDATE property_payments
              SET for_year = $1, for_month = $2, ledger_row_id = $3
              WHERE id = (
                SELECT id FROM property_payments
                WHERE contract_id = $4 AND for_year = $5 AND for_month = $6
                ORDER BY created_at DESC
                LIMIT 1
              )
            `,
            [targetYear, targetMonth, newLedgerId, row.contract_id, row.year, row.month]
          );
        }

        logger.info(
          `[RentalFix] Done: contract=${row.contract_id} fixed ${row.year}/${row.month} → ${targetYear}/${targetMonth}`
        );
      }

      logger.info("[RentalFix] Rental overpayment fix complete");
    } catch (e: unknown) {
      logger.error("[RentalFix] Migration error:", { error: getErrorMessage(e) });
    }

    // One-time: convert all PARTIALLY_OFFLOADED containers to OFFLOADED.
    // "Partially offloaded" is no longer a distinct status — partial offloads
    // are treated as fully OFFLOADED.
    try {
      await migrationClient.query(`
          UPDATE factory_containers
          SET status = 'OFFLOADED'
          WHERE status = 'PARTIALLY_OFFLOADED'
        `);
    } catch {
      /* skip if table not ready */
    }

    // ── Fix misallocated property payments ──────────────────────────────────────
    // Phase 1 (JS): For each active contract, re-process payments in date order
    // and assign each to the oldest outstanding month, updating ledger_row_id,
    // for_year, and for_month on misallocated payment records.
    // Phase 2 (SQL): After ledger_row_id is correct, sync each ledger row's
    // paid_amount to the actual sum of payments pointing to it.
    // Safe to re-run — idempotent once data is correct.
    try {
      const contractsResult = await migrationClient.query(`
          SELECT pc.id, pc.company_id, pc.rental_amount::numeric AS rental_amount
          FROM property_contracts pc
          WHERE pc.status = 'ACTIVE'
        `);

      let pmtFixed = 0;

      for (const contract of contractsResult.rows) {
        const cid = Number(contract.id);
        const compId = Number(contract.company_id);

        // Load all payments that link to a ledger row (rent + guarantee-applied)
        const pmts = (
          await migrationClient.query(
            `
            SELECT id, amount::numeric AS amount, for_year, for_month, ledger_row_id
            FROM property_payments
            WHERE contract_id = $1 AND company_id = $2
              AND ledger_row_id IS NOT NULL
            ORDER BY payment_date, id
          `,
            [cid, compId]
          )
        ).rows;
        if (!pmts.length) continue;

        // Load all ledger rows ordered oldest first
        const ledger = (
          await migrationClient.query(
            `
            SELECT id, year, month, expected_amount::numeric AS expected
            FROM property_monthly_ledger
            WHERE contract_id = $1 AND company_id = $2
            ORDER BY year, month
          `,
            [cid, compId]
          )
        ).rows;
        if (!ledger.length) continue;

        // In-memory map: key="year-month", value={id, expected, paid(reset to 0)}
        const lmap = new Map<string, { id: number; expected: number; paid: number }>();
        for (const r of ledger) {
          lmap.set(`${r.year}-${r.month}`, { id: Number(r.id), expected: Number(r.expected), paid: 0 });
        }

        // Re-allocate: each payment fills the oldest outstanding month
        for (const pmt of pmts) {
          let rem = Number(pmt.amount);
          let firstChunk = true;

          while (rem > 0.005) {
            // Find oldest month with remaining capacity
            let tgt: { key: string; year: number; month: number; id: number; expected: number; paid: number } | null =
              null;
            for (const [key, row] of lmap) {
              if (row.expected - row.paid > 0.005) {
                const [y, m] = key.split("-").map(Number);
                tgt = { key, year: y, month: m, ...row };
                break;
              }
            }
            if (!tgt) break;

            const chunk = Math.min(rem, tgt.expected - tgt.paid);
            tgt.paid += chunk;
            rem = Math.round((rem - chunk) * 100) / 100;
            lmap.set(tgt.key, { ...tgt });

            if (firstChunk) {
              firstChunk = false;
              // Update payment if it points to wrong ledger row
              const origLedgerId = Number(pmt.ledger_row_id);
              const origForYear = Number(pmt.for_year);
              const origForMonth = Number(pmt.for_month);
              if (origLedgerId !== tgt.id || origForYear !== tgt.year || origForMonth !== tgt.month) {
                await migrationClient.query(
                  `
                    UPDATE property_payments
                    SET ledger_row_id = $1, for_year = $2, for_month = $3
                    WHERE id = $4
                  `,
                  [tgt.id, tgt.year, tgt.month, Number(pmt.id)]
                );
                pmtFixed++;
                logger.info(
                  `[AllocationFix] pmt=${pmt.id} contract=${cid} moved ${origForYear}/${origForMonth} → ${tgt.year}/${tgt.month}`
                );
              }
            }
          }
        }
      }

      if (pmtFixed > 0) {
        logger.info(`[AllocationFix] Phase 1 complete — reassigned ${pmtFixed} payment record(s)`);
      }

      // Phase 2: sync every ledger row's paid_amount to sum of its linked payments
      const syncResult = await migrationClient.query(`
          UPDATE property_monthly_ledger pml
          SET paid_amount = COALESCE((
            SELECT SUM(pp.amount::numeric)
            FROM property_payments pp
            WHERE pp.ledger_row_id = pml.id
          ), 0)
          WHERE ABS(pml.paid_amount::numeric - COALESCE((
            SELECT SUM(pp.amount::numeric)
            FROM property_payments pp
            WHERE pp.ledger_row_id = pml.id
          ), 0)) > 0.01
        `);
      const ledgerFixed = syncResult.rowCount ?? 0;

      if (pmtFixed > 0 || ledgerFixed > 0) {
        logger.info(`[AllocationFix] Phase 2 complete — corrected ${ledgerFixed} ledger paid_amount(s)`);
      } else {
        logger.info(`[AllocationFix] All payment allocations and ledger amounts are correct`);
      }
    } catch (e: unknown) {
      logger.error("[AllocationFix] Error:", { error: getErrorMessage(e) });
    }

    // Retired (2026-10 accounting audit): three boot-time repairs used to run here
    // on every boot, outside a transaction, and rewrite posted history:
    //   - merge PRODUCTION_ADJUSTMENT / CONSUMPTION_EXPENSE into STOCK_ADJUSTMENT by
    //     re-pointing voucher_entries and soft-deleting the old accounts;
    //   - rewrite BONUS_EXPENSE account types;
    //   - re-route credit-note variance lines to a "Sales Returns" account.
    // Re-pointing or reclassifying posted entries at deploy time changes historical
    // statements without a journal or an audit trail. Any such correction is now a
    // reviewed, posted entry; the accounting integrity diagnostic reports the cases.

    // ── Auto-fix orphaned RESERVED_FOR_ORDER bales ───────────────────────────
    // Bales stuck in RESERVED_FOR_ORDER with no active customer order referencing
    // them (order deleted / container row deleted) are returned to IN_STOCK.
    try {
      const orphanResult = await migrationClient.query(`
          UPDATE factory_bales
          SET status = 'IN_STOCK', updated_at = NOW()
          WHERE status = 'RESERVED_FOR_ORDER'
            AND deleted_at IS NULL
            AND id NOT IN (
              SELECT cob.bale_id
              FROM customer_order_bales cob
              INNER JOIN customer_orders co ON co.id = cob.order_id
              WHERE co.deleted_at IS NULL
                AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
            )
          RETURNING id
        `);
      const fixed = orphanResult.rows.length;
      if (fixed > 0) {
        logger.info(`[BaleOrphanFix] Restored ${fixed} orphaned RESERVED_FOR_ORDER bale(s) → IN_STOCK`);
      }
    } catch (e: unknown) {
      logger.error("[BaleOrphanFix] Error:", { error: getErrorMessage(e) });
    }

    // ── Back-fill insurance_members from existing "Insurance - …" accounts ───
    // When ledger accounts named "Insurance - <name>" exist under a factory
    // company but have no corresponding insurance_members row (e.g. after a
    // DB restore or a bulk import), create the member rows so the Insurance
    // page shows them.  Idempotent: skipped if a member already points to
    // the account.  Must run BEFORE the orphan-cleanup below.
    try {
      const memberBackfill = await migrationClient.query(`
          INSERT INTO insurance_members (company_id, name, active, ledger_account_id, start_date, amount)
          SELECT la.company_id,
                 SUBSTRING(la.name FROM 13),
                 true,
                 la.id,
                 CURRENT_DATE,
                 0
          FROM ledger_accounts la
          JOIN companies c ON c.id = la.company_id
          WHERE la.name LIKE 'Insurance - %'
            AND la.deleted_at IS NULL
            AND c.company_type IN ('factory', 'factory_v2')
            AND NOT EXISTS (
              SELECT 1 FROM insurance_members im
              WHERE im.ledger_account_id = la.id
            )
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
      if (memberBackfill.rowCount && memberBackfill.rowCount > 0) {
        logger.info(
          `[InsuranceMemberBackfill] Created ${memberBackfill.rowCount} missing insurance_members row(s) from ledger accounts`
        );
      }
    } catch (e: unknown) {
      logger.error("[InsuranceMemberBackfill] Error:", { error: getErrorMessage(e) });
    }

    // Wave 16 (A): the InsuranceFix step that soft-deleted "Insurance - %"
    // ledger accounts with no member row was retired. It ignored opening
    // balances (an account with an opening and no postings lost it from every
    // report) and changed accounts at boot with no audit. Such accounts stay;
    // delete one deliberately from the chart of accounts if it is unwanted.

    // Auto-fix sequence desyncs (can happen after data restores / bulk imports with explicit IDs)
    const seqFixes: Array<[string, string]> = [
      ["ledger_accounts", "ledger_accounts_id_seq"],
      ["factory_suppliers", "factory_suppliers_id_seq"],
      ["factory_containers", "factory_containers_id_seq"],
      ["factory_supplier_payments", "factory_supplier_payments_id_seq"],
      ["factory_supplier_fx_transfers", "factory_supplier_fx_transfers_id_seq"],
      ["factory_container_other_charges", "factory_container_other_charges_id_seq"],
      ["vouchers", "vouchers_id_seq"],
      ["voucher_entries", "voucher_entries_id_seq"],
      ["login_history", "login_history_id_seq"],
    ];
    for (const [table, seq] of seqFixes) {
      try {
        await migrationClient.query(
          `SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table}), 1))`
        );
      } catch {
        /* table may not exist yet on first run — skip */
      }
    }
  } catch (err: unknown) {
    logger.error("Migration connection error:", { error: getErrorMessage(err) });
  } finally {
    await migrationClient.end();
    onComplete();
    markStartupMigrationsComplete();
  }
}

// Pre-warm the DB connection pool so the first user request
// (e.g. login) doesn't bear the cost of the initial TCP handshake + SSL
// negotiation to the database. Retries up to 3 times with a short delay
// so Render's database has time to wake from cold-start sleep.
export async function warmupDb() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query("SELECT 1");
      logger.info(`✓ DB connection pool warmed up (attempt ${attempt})`);
      return;
    } catch (err: unknown) {
      logger.warn(`⚠️  DB warmup attempt ${attempt} failed: ${getErrorMessage(err)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  logger.error("✗ DB warmup failed after 3 attempts — queries will connect lazily");
}
