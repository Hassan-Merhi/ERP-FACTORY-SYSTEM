/**
 * SP migration routes - unique profit opening balance endpoint.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import { pn, getCompanyRow, logRun, trackRow } from "./_helpers";
import { parseMoneyInput } from "../../lib/money";

export function registerSpMigrationSalesRoutes(app: Express) {
  // The Phase 2 migration registrar owns gc-sales-readonly and gc-containers
  // earlier in application startup. Retain only the unique profit-opening route.

  // ── Profit-share opening balance ────────────────────────────────────────
  // POST /api/sp/migration/gc-profit-opening
  // Posts: Dr GC-PROFCLR (accumulated profit) / Cr GC-OURPFT (our share) + Cr GC-SUPPFT (supplier share)
  app.post(
    "/api/sp/migration/gc-profit-opening",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const {
          targetCompanyId,
          cutoffDate,
          accumulatedProfit,
          ourSplitPct,
          ourShareAmount: ourShareAmountRaw,
          supplierShareAmount: supplierShareAmountRaw,
          notes: profitNotes,
        } = req.body ?? {};
        const targetId = parseInt(String(targetCompanyId ?? ""), 10);
        // Request values: parsed like parseFloat, and NaN (rejected below) when missing or malformed.
        const profit = parseMoneyInput(accumulatedProfit)?.toNumber() ?? NaN;
        const ourPct =
          ourSplitPct !== undefined && ourSplitPct !== null && ourSplitPct !== ""
            ? (parseMoneyInput(ourSplitPct)?.toNumber() ?? NaN)
            : 50;

        // Manual split amounts take priority over the percentage when both are provided.
        const manualOurShare =
          ourShareAmountRaw !== undefined && ourShareAmountRaw !== null && ourShareAmountRaw !== ""
            ? (parseMoneyInput(ourShareAmountRaw)?.toNumber() ?? NaN)
            : null;
        const manualSupplierShare =
          supplierShareAmountRaw !== undefined && supplierShareAmountRaw !== null && supplierShareAmountRaw !== ""
            ? (parseMoneyInput(supplierShareAmountRaw)?.toNumber() ?? NaN)
            : null;
        const usingManualSplit = manualOurShare !== null && manualSupplierShare !== null;

        if (!targetId) return res.status(400).json({ message: "targetCompanyId is required" });
        if (!cutoffDate) return res.status(400).json({ message: "cutoffDate is required" });
        if (isNaN(profit) || profit < 0)
          return res.status(400).json({ message: "accumulatedProfit must be a non-negative number" });
        if (!usingManualSplit && (isNaN(ourPct) || ourPct < 0 || ourPct > 100))
          return res.status(400).json({ message: "ourSplitPct must be between 0 and 100" });
        if (usingManualSplit) {
          if (isNaN(manualOurShare!) || manualOurShare! < 0)
            return res.status(400).json({ message: "ourShareAmount must be a non-negative number" });
          if (isNaN(manualSupplierShare!) || manualSupplierShare! < 0)
            return res.status(400).json({ message: "supplierShareAmount must be a non-negative number" });
          if (Math.abs(manualOurShare! + manualSupplierShare! - profit) > 0.01) {
            return res.status(400).json({
              message: `Our share + supplier share (${(manualOurShare! + manualSupplierShare!).toFixed(2)}) must equal accumulated profit (${profit.toFixed(2)}).`,
            });
          }
        }

        const targetComp = await getCompanyRow(targetId);
        if (!targetComp) return res.status(404).json({ message: "Target company not found" });
        if (targetComp.company_type !== "supplier_partner")
          return res.status(400).json({ message: "Target must be a supplier_partner company" });

        const acctRows = (
          await db.execute(sql`
          SELECT sub_type, id FROM ledger_accounts
          WHERE company_id = ${targetId} AND deleted_at IS NULL
            AND sub_type IN ('gc_our_profit_share', 'gc_supplier_profit_share', 'gc_accumulated_profit_clearing')
        `)
        ).rows;
        const bySubType = new Map(acctRows.map((r) => [r.sub_type, pn(r.id)]));
        const ourAcctId = bySubType.get("gc_our_profit_share");
        const supAcctId = bySubType.get("gc_supplier_profit_share");
        const clrAcctId = bySubType.get("gc_accumulated_profit_clearing");
        if (!ourAcctId || !supAcctId || !clrAcctId) {
          return res.status(400).json({
            message: "GC profit-share accounts not found in target company. Run the account creation step first.",
          });
        }

        const runId = await logRun(
          targetId,
          targetId,
          "gc_profit_opening",
          "running",
          0,
          null,
          `User: ${req.session?.userId ?? "unknown"} | Target: ${targetComp.name}`
        );

        const ourShare = usingManualSplit
          ? Math.round(manualOurShare! * 100) / 100
          : Math.round(profit * (ourPct / 100) * 100) / 100;
        const supplierShare = usingManualSplit
          ? Math.round(manualSupplierShare! * 100) / 100
          : Math.round((profit - ourShare) * 100) / 100;
        const splitDescLabel = usingManualSplit ? "manual split" : `${ourPct}% / ${100 - ourPct}% split`;

        // Deterministic voucher number (no timestamp) so re-running for the same
        // target + cutoff date is idempotent instead of creating a duplicate journal.
        const voucherNumber = `GC-PROFIT-OPN-${targetId}-${cutoffDate}`;
        const existing = (
          await db.execute(
            sql`SELECT id FROM vouchers WHERE company_id = ${targetId} AND voucher_number = ${voucherNumber} LIMIT 1`
          )
        ).rows[0];
        if (existing) {
          await db
            .execute(
              sql`UPDATE sp_migration_rehearsal_runs SET status = 'failed', error_message = 'Duplicate — already posted', completed_at = now() WHERE id = ${runId}`
            )
            .catch(() => {});
          return res.status(409).json({
            message: `A profit-share opening balance for ${cutoffDate} has already been posted (voucher ${voucherNumber}). Roll it back first if you need to re-post with different figures.`,
            voucherId: pn(existing.id),
            voucherNumber,
          });
        }

        const afterCommit: Array<() => Promise<void>> = [];
        const voucherId = await db.transaction(async (tx) => {
          const [vRow] = (
            await tx.execute(sql`
          INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module)
          VALUES (${targetId}, ${voucherNumber}, 'Journal', ${cutoffDate},
                  ${`GC accumulated profit-share opening balance as of ${cutoffDate} (${splitDescLabel})${profitNotes ? " — " + profitNotes : ""}`},
                  ${profit.toFixed(2)}, 'USD', 'SP_MIGRATION')
          RETURNING id
        `)
          ).rows;
          const voucherId = pn(vRow.id);
          afterCommit.push(() => trackRow(runId, "vouchers", voucherId));

          const clrEntry = (
            await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${voucherId}, ${clrAcctId}, ${profit.toFixed(2)}, '0.00', 'Accumulated profit clearing')
          RETURNING id
        `)
          ).rows[0];
          afterCommit.push(() => trackRow(runId, "voucher_entries", pn(clrEntry.id)));

          const ourEntry = (
            await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${voucherId}, ${ourAcctId}, '0.00', ${ourShare.toFixed(2)}, 'Our profit share opening balance')
          RETURNING id
        `)
          ).rows[0];
          afterCommit.push(() => trackRow(runId, "voucher_entries", pn(ourEntry.id)));

          const supEntry = (
            await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${voucherId}, ${supAcctId}, '0.00', ${supplierShare.toFixed(2)}, 'Supplier profit share opening balance')
          RETURNING id
        `)
          ).rows[0];
          afterCommit.push(() => trackRow(runId, "voucher_entries", pn(supEntry.id)));
          return voucherId;
        });
        for (const record of afterCommit) await record();

        await db.execute(sql`
          UPDATE sp_migration_rehearsal_runs SET status = 'completed', rows_created = 4, completed_at = now() WHERE id = ${runId}
        `);

        return res.json({
          success: true,
          runId,
          voucherId,
          voucherNumber,
          accumulatedProfit: profit,
          ourShare,
          supplierShare,
          ourSplitPct: ourPct,
        });
      } catch (err: unknown) {
        logger.error("[SP Migration] gc-profit-opening error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
