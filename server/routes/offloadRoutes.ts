/**
 * Container-offload routes.
 *
 * Offload daybook listing/detail, offload optional-toggle, container
 * offload-diagnostics, and the post-offload voucher backfill/repair admin
 * endpoints. Extracted from debugRoutes.ts as a sub-registrar.
 *
 * The optional-toggle effect set lives in
 * services/containers/offloadOptionalToggle.ts so the state guard and the row
 * locks are transaction-owned; this file only resolves the caller identity and
 * maps the outcome onto a response.
 */
import type { Express } from "express";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";
import { getOrCreateLedgerAccount } from "./factory/_helpers";
import { toMoney } from "../lib/money";
import { sendCompanyAccessError } from "../security/companyAccessBoundary";
import { ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { resultRows } from "../lib/queryResult";
import { normFactoryEntry } from "../services/factory/factoryVoucherEntryAmounts";
import { FactoryFxRateRequiredError, factoryDocumentRate } from "../services/factory/factoryDocumentFxRate";
import { registerOffloadRoutesPart1 } from "./registerOffloadRoutesPart1";
import { registerOffloadRoutesPart2 } from "./registerOffloadRoutesPart2";

const backfillPostOffloadVouchersInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerOffloadRoutes(app: Express) {
  registerOffloadRoutesPart1(app);
  registerOffloadRoutesPart2(app);
  registerOffloadRoutesPart3(app);
}

function registerOffloadRoutesPart3(app: Express) {
  // Net Profit (P&L) Report - Tally Prime style

  // Backfill missing vouchers for post-offload charges that already have a ledgerAccountId
  // but whose voucher was created in the wrong company (factory instead of ledger account's company).
  // Idempotent: skips any charge that already has a voucher crediting the chosen ledger account.
  app.post(
    "/api/admin/backfill-postoffload-vouchers",
    requireAuth,
    requireRole("Admin", "Developer"),
    validateRequest(backfillPostOffloadVouchersInput),
    async (req, res) => {
      const selectedCompanyId = req.session.currentCompanyId;
      if (!selectedCompanyId) return res.status(400).json({ message: "No company selected" });
      // Company 12's June POC backfill ran already and produced a duplicate
      // charge #64. The October correction was later retired. Never replay
      // that one-time route: use a separately approved source-specific repair.
      if (Number(selectedCompanyId) === 12) {
        return res.status(409).json({
          code: "HISTORICAL_POC_BACKFILL_REPLAY_DISABLED",
          message:
            "Historical company-12 post-offload vouchers have already been backfilled. Replaying would risk duplicate payable and expense entries; use the private reconciliation audit.",
        });
      }
      try {
        let scanned = 0,
          created = 0,
          skippedExisting = 0,
          errors = 0,
          refusedNoRate = 0;
        const errorDetails: string[] = [];

        // Fetch all post-offload charges that have a ledger account chosen
        const chargesRes = await db.execute(sql`
        SELECT
          c.id,
          c.container_id,
          c.description,
          c.amount,
          c.currency_code,
          c.fx_rate_to_usd,
          c.fx_rate_confirmed,
          c.ledger_account_id,
          c.created_at,
          fc.container_number
        FROM factory_offload_additional_charges c
        JOIN factory_containers fc ON fc.id = c.container_id
        WHERE c.ledger_account_id IS NOT NULL AND c.deleted_at IS NULL
          AND c.company_id = ${selectedCompanyId} AND fc.company_id = ${selectedCompanyId}
        ORDER BY c.id
      `);
        type OffloadChargeRow = {
          id: number;
          container_id: number;
          description: string | null;
          amount: string | null;
          currency_code: string | null;
          fx_rate_to_usd: string | null;
          fx_rate_confirmed: boolean | null;
          ledger_account_id: number;
          created_at: Date | string | null;
          container_number: string;
        };
        const rows = resultRows<OffloadChargeRow>(chargesRes);

        for (const row of rows) {
          scanned++;
          try {
            const chargeId: number = row.id;
            const containerId: number = row.container_id;
            const containerNumber: string = row.container_number || `#${containerId}`;
            const ledgerAccountId: number = row.ledger_account_id;
            const description: string = row.description || "Post-offload charge";
            const amount = toMoney(row.amount);
            const chargeCcy: string = row.currency_code || "USD";
            const voucherDate: string = row.created_at
              ? new Date(row.created_at).toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10);

            if (amount.lessThanOrEqualTo(0)) {
              skippedExisting++;
              continue;
            }

            // Resolve the ledger account's company
            const [acctRow] = await db
              .select({ companyId: ledgerAccounts.companyId })
              .from(ledgerAccounts)
              .where(eq(ledgerAccounts.id, ledgerAccountId));
            if (!acctRow || Number(acctRow.companyId) !== Number(selectedCompanyId)) {
              errors++;
              errorDetails.push(`chargeId=${chargeId}: ledger account missing or belongs to another company`);
              continue;
            }
            const voucherCompanyId = acctRow.companyId;

            // Exact source-identity preflight. The legacy description-only
            // check missed charge 64 because voucher 9309 had NULL description.
            // Do NOT filter retired vouchers here: a user may have deliberately
            // retired a posting, which requires review before any recreation.
            const existingCheck = await db.execute(sql`
            SELECT v.id
            FROM vouchers v
            WHERE v.company_id = ${voucherCompanyId}
              AND (
                v.voucher_number LIKE ${`FACTORY-POC-${containerId}-${chargeId}-%`}
                OR v.voucher_number = ${`FACTORY-POC-BACKFILL-${containerId}-${chargeId}`}
                OR v.voucher_number LIKE ${`FACTORY-OC-${containerId}-${chargeId}-%`}
              )
            LIMIT 1
          `);
            const existingRows = resultRows(existingCheck);
            if (existingRows.length > 0) {
              skippedExisting++;
              continue;
            }

            // Wave 17 (D): a non-USD charge is posted normalized at its own confirmed
            // rate, else at the factory's confirmed rate on or before the voucher
            // date; with no such rate it is refused (listed, nothing posted). It
            // used to be posted in the legacy shape.
            let chargeFx: string;
            try {
              chargeFx = (
                await factoryDocumentRate(db, voucherCompanyId, chargeCcy, voucherDate, {
                  rate: row.fx_rate_to_usd,
                  confirmed: row.fx_rate_confirmed,
                })
              ).rate;
            } catch (rateError) {
              if (!(rateError instanceof FactoryFxRateRequiredError)) throw rateError;
              refusedNoRate++;
              errorDetails.push(
                `chargeId=${chargeId}: ${rateError.code} (${rateError.currency} on ${rateError.documentDate})`
              );
              continue;
            }

            // Get or create FACTORY_CHARGES_PAYABLE in the ledger account's company
            const cpAcctId = await getOrCreateLedgerAccount(
              voucherCompanyId,
              "FACTORY_CHARGES_PAYABLE",
              "Factory Charges Payable"
            );

            // Insert the voucher
            const voucherNum = `FACTORY-POC-BACKFILL-${containerId}-${chargeId}`;
            const voucher = await db.transaction(async (tx) => {
              const [posted] = await tx
                .insert(vouchers)
                .values({
                  companyId: voucherCompanyId,
                  voucherType: "Journal",
                  voucherNumber: voucherNum,
                  voucherDate,
                  description: `${description} (post-offload) — container ${containerNumber}`,
                  totalAmount: amount.toFixed(),
                  currency: chargeCcy,
                  exchangeRate: chargeFx,
                  sourceModule: "FACTORY",
                })
                .returning();

              // DR FACTORY_CHARGES_PAYABLE
              await tx.insert(voucherEntries).values({
                voucherId: posted.id,
                ledgerAccountId: cpAcctId,
                ...normFactoryEntry(chargeCcy, amount.toFixed(), "0", chargeFx),
                narration: `${description} payable — container ${containerNumber}`,
              });
              // CR chosen ledger account
              await tx.insert(voucherEntries).values({
                voucherId: posted.id,
                ledgerAccountId,
                ...normFactoryEntry(chargeCcy, "0", amount.toFixed(), chargeFx),
                narration: `${description} — container ${containerNumber}`,
              });
              return posted;
            });

            created++;
            logger.info(
              `[POC backfill] voucherId=${voucher.id} chargeId=${chargeId} container=${containerNumber} voucherCompanyId=${voucherCompanyId} cpAcctId=${cpAcctId}`
            );
          } catch (err: unknown) {
            errors++;
            errorDetails.push(`chargeId=${row.id}: ${getErrorMessage(err)}`);
            logger.error(`[POC backfill] error on chargeId=${row.id}:`, { error: err });
          }
        }

        res.json({ scanned, created, skippedExisting, errors, refusedNoRate, errorDetails });
      } catch (error: unknown) {
        logger.error("Backfill post-offload vouchers error:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );
}
