/** Exact legacy startup-only rental overpayment and partial-offload repairs. */
import type { Client } from "pg";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";

export async function runLegacyRentalOverpaymentFix(migrationClient: Client): Promise<void> {
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
}

export async function runLegacyPartialOffloadStatusFix(migrationClient: Client): Promise<void> {
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
}
