import { infrastructurePostingIdentity } from "../../services/accounting/infrastructureVoucherIdentity";
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { logger } from "../../lib/logger";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  logAudit,
  getCurrentExchangeRate,
  syncEmployeeBalancesFromEntries,
  snapshotVoucherEntries,
  buildVoucherChangesForCreate,
} from "../_helpers";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { vouchers, voucherEntries, customers, type InsertVoucher } from "@shared/schema";
import { eq, and } from "drizzle-orm";

import Decimal from "decimal.js";
import { normalizeVoucherEntryAmounts } from "../../services/accounting/currencyAmounts";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { stockVoucherTypeRefusal } from "../../services/accounting/stockVoucherTypes";
import {
  validateManualVoucherEntryAmounts,
  type ValidatedManualVoucherTotals,
} from "../../services/accounting/manualVoucherEntryValidation";

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherCreateRoutes(app: Express) {
  app.post("/api/vouchers", requireAuth, async (req, res) => {
    try {
      const isPOS = req.user?.role === "POS";
      const voucherType = req.body.voucherType;
      if (isPOS && voucherType !== "StockTransfer" && voucherType !== "Stock Transfer" && voucherType !== "Transfer") {
        return res.status(403).json({ message: "Access denied: This resource is not available for POS users" });
      }
      // Wave 12: stock adjustment types come only from POST /api/stock-adjustments.
      const stockTypeRefusal = stockVoucherTypeRefusal(voucherType);
      if (stockTypeRefusal) return res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);
      // vouchers.company_id, voucher_number, voucher_type, voucher_date and
      // total_amount are NOT NULL with no default, and none of them was
      // checked before the insert, so a body missing them failed the query as
      // a 500. Validated field by field rather than through
      // insertVoucherSchema: that schema's voucherType enum omits
      // "StockTransfer" and "Transfer", which the POS branch above accepts, so
      // parsing with it would reject POS stock transfers.
      const requiredVoucherFields: Array<[string, unknown]> = [
        ["companyId", req.body.companyId ?? req.session.currentCompanyId],
        ["voucherNumber", req.body.voucherNumber],
        ["voucherType", voucherType],
        ["voucherDate", req.body.voucherDate],
        ["totalAmount", req.body.totalAmount],
      ];
      const missingVoucherField = requiredVoucherFields.find(
        ([, value]) => value === undefined || value === null || value === ""
      );
      if (missingVoucherField) {
        return res.status(400).json({ message: "Invalid request data", field: missingVoucherField[0] });
      }

      // The body used to be spread straight into the insert, so a caller could
      // set any column (deleted_at, shift_id, source_module, ...). Only the
      // header fields the voucher forms send are accepted, and the company is
      // always the session's.
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      if (req.body.companyId != null && Number(req.body.companyId) !== companyId) {
        return res.status(403).json({ message: "Vouchers can only be created in the selected company" });
      }
      // Stock forms send float products (qty * rate); the column keeps cents,
      // so round exactly as the database would rather than refuse them.
      let totalAmount: string;
      try {
        const parsedTotal = new Decimal(String(req.body.totalAmount).trim());
        // Mixed production/consumption vouchers are net-valued: production
        // minus consumption. Their legitimate header total can therefore be
        // negative (for example, consuming $393.43 and producing $99.53 gives
        // -$293.90). Other voucher types keep the non-negative boundary.
        const allowsSignedTotal = String(voucherType).trim().toLowerCase() === "mixed";
        if (!parsedTotal.isFinite() || (!allowsSignedTotal && parsedTotal.isNegative())) {
          throw new Error("invalid");
        }
        totalAmount = parsedTotal.toFixed(2);
      } catch {
        return res.status(400).json({ message: "Invalid request data", field: "totalAmount" });
      }
      if (req.body.optional !== undefined && typeof req.body.optional !== "boolean") {
        return res.status(400).json({ message: "Invalid request data", field: "optional" });
      }
      const textField = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
      const exchangeRate = await getCurrentExchangeRate(companyId);
      const voucher = await storage.createVoucher({
        companyId,
        voucherNumber: String(req.body.voucherNumber),
        // insertVoucherSchema's enum omits types this route legitimately
        // receives (StockTransfer/Transfer from POS, Production, Mixed).
        voucherType: String(voucherType) as InsertVoucher["voucherType"],
        voucherDate: String(req.body.voucherDate),
        totalAmount,
        description: textField(req.body.description),
        optional: req.body.optional ?? false,
        currency:
          typeof req.body.currency === "string" && /^[A-Z]{3}$/.test(req.body.currency) ? req.body.currency : "USD",
        locationId: Number.isInteger(req.body.locationId) ? req.body.locationId : undefined,
        locationName: textField(req.body.locationName),
        effectiveDate: textField(req.body.effectiveDate) ?? null,
        exchangeRate: exchangeRate == null ? undefined : String(exchangeRate),
        sourceModule: "ERP",
        postingSource: infrastructurePostingIdentity(
          "manual-voucher",
          `${companyId}:${req.body.voucherNumber}`,
          "create"
        ),
      });
      res.json(voucher);
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Create a voucher with entries in one transaction
  app.post("/api/vouchers/with-entries", requireAuth, requireNonPOS, async (req, res) => {
    const _t = Date.now();
    const _uid = req.user?.id;
    const _cid = req.session.currentCompanyId;
    logger.info("Voucher with-entries create started", {
      module: "vouchers",
      action: "createWithEntries",
      userId: _uid,
      companyId: _cid,
    });
    try {
      const { voucher, entries } = req.body;
      // Wave 12: stock adjustment types come only from POST /api/stock-adjustments.
      const stockTypeRefusal = stockVoucherTypeRefusal(voucher?.voucherType);
      if (stockTypeRefusal) return res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Validate voucher data
      if (!voucher || !entries || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "Voucher and entries are required" });
      }

      // Payloads the central engine does not take land here, so apply its
      // amount rules: exact decimal balance, no negative or both-sided lines.
      let validatedTotals: ValidatedManualVoucherTotals;
      try {
        validatedTotals = validateManualVoucherEntryAmounts(entries, { optional: voucher.optional === true });
      } catch (validationError: unknown) {
        if (validationError instanceof PostingValidationError) {
          return res.status(400).json({ message: validationError.message, code: validationError.code });
        }
        throw validationError;
      }

      // Get current exchange rate before starting the transaction
      const exchangeRate = await getCurrentExchangeRate(req.session.currentCompanyId!);

      // Use the caller-supplied currency/rate if present (multi-currency create path).
      // Fall back to the current company rate (legacy USD-only path).
      const voucherCurrency: string = (voucher.currency as string | undefined) || "USD";
      const voucherHistoricalRate: string | null =
        voucher.exchangeRate != null
          ? String(voucher.exchangeRate)
          : exchangeRate != null
            ? String(exchangeRate)
            : null;

      // Create voucher + all entries atomically inside a single transaction.
      // Any thrown error automatically rolls back both the voucher row and
      // all entry rows — no manual cleanup required.
      const { createdVoucher, createdEntries } = await db.transaction(async (tx) => {
        const [txVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            locationId: voucher.locationId || null,
            voucherNumber: voucher.voucherNumber,
            voucherType: voucher.voucherType,
            voucherDate: voucher.voucherDate,
            description: voucher.description || null,
            totalAmount: Decimal.max(validatedTotals.debitTotal, validatedTotals.creditTotal).toFixed(2),
            optional: voucher.optional ?? false,
            currency: voucherCurrency,
            exchangeRate: voucherHistoricalRate,
          })
          .returning();

        const txEntries: (typeof voucherEntries.$inferSelect)[] = [];

        // Create voucher entries
        for (const entry of entries) {
          // Cross-field validation: when an entry references a customer/
          // supplier/employee that has a linked ledger account, fill in
          // the missing ledger so the linked-ledger view stays consistent.
          // Reject the request if the user provided a *different* ledger
          // than the one the party is linked to.
          let ledgerAccountId = entry.ledgerAccountId || null;

          if (entry.customerId) {
            // Scope the customer lookup by current company to prevent
            // cross-company customer IDs from being used in this voucher.
            const [linkedCust] = await tx
              .select({ ledgerAccountId: customers.ledgerAccountId })
              .from(customers)
              .where(and(eq(customers.id, entry.customerId), eq(customers.companyId, req.session.currentCompanyId!)))
              .limit(1);
            if (!linkedCust) {
              throw new Error(`Customer ${entry.customerId} not found in current company.`);
            }
            const linkedLedgerId = linkedCust.ledgerAccountId ?? null;
            if (linkedLedgerId) {
              if (ledgerAccountId && ledgerAccountId !== linkedLedgerId) {
                throw new Error(
                  `Customer ${entry.customerId} is linked to ledger ${linkedLedgerId}, ` +
                    `but the entry specifies ledger ${ledgerAccountId}. ` +
                    `Use the customer's linked ledger or remove the customer reference.`
                );
              }
              ledgerAccountId = linkedLedgerId;
            }
          }

          // Normalize dual-currency fields.
          // If the caller already provides transactionCurrency (new multi-currency frontend),
          // use those fields as-is. Otherwise derive from the voucher's currency/rate.
          let dualCurrencyFields: Record<string, unknown> = {};
          if (!entry.transactionCurrency) {
            try {
              const debitAmt = String(entry.debitAmount || "0");
              const creditAmt = String(entry.creditAmount || "0");
              const totalAmt = parseFloat(debitAmt) + parseFloat(creditAmt);
              if (totalAmt > 0) {
                const norm = normalizeVoucherEntryAmounts({
                  transactionCurrency: voucherCurrency,
                  baseCurrency: "USD",
                  transactionDebitAmount: debitAmt,
                  transactionCreditAmount: creditAmt,
                  historicalRate: voucherHistoricalRate,
                });
                dualCurrencyFields = {
                  transactionCurrency: norm.transactionCurrency,
                  transactionDebitAmount: norm.transactionDebitAmount,
                  transactionCreditAmount: norm.transactionCreditAmount,
                  baseDebitAmount: norm.baseDebitAmount,
                  baseCreditAmount: norm.baseCreditAmount,
                  historicalExchangeRate: norm.historicalExchangeRate,
                  rateConvention: norm.rateConvention,
                };
              }
            } catch (normErr: unknown) {
              // A USD entry without a company rate can still post its amounts
              // as-is. A foreign-currency entry cannot: without a rate its
              // amount would be stored as if it were USD.
              if (voucherCurrency.toUpperCase() !== "USD") {
                throw new PostingValidationError(
                  "POSTING_EXCHANGE_RATE_REQUIRED",
                  `Cannot post a ${voucherCurrency} voucher without a valid exchange rate: ${getErrorMessage(normErr)}`
                );
              }
            }
          } else {
            // Caller provided full dual-currency data (new frontend)
            dualCurrencyFields = {
              transactionCurrency: entry.transactionCurrency,
              transactionDebitAmount: entry.transactionDebitAmount ?? null,
              transactionCreditAmount: entry.transactionCreditAmount ?? null,
              baseDebitAmount: entry.baseDebitAmount ?? null,
              baseCreditAmount: entry.baseCreditAmount ?? null,
              historicalExchangeRate: entry.historicalExchangeRate ?? null,
              rateConvention: entry.rateConvention ?? null,
            };
          }

          const [txEntry] = await tx
            .insert(voucherEntries)
            .values({
              voucherId: txVoucher.id,
              ledgerAccountId,
              bankAccountId: entry.bankAccountId || null,
              fixedAssetId: entry.fixedAssetId || null,
              supplierId: entry.supplierId || null,
              employeeId: entry.employeeId || null,
              customerId: entry.customerId || null,
              factorySupplierId: entry.factorySupplierId || null,
              debitAmount: entry.debitAmount || "0",
              creditAmount: entry.creditAmount || "0",
              narration: entry.narration || null,
              ...dualCurrencyFields,
            })
            .returning();
          txEntries.push(txEntry);
        }

        // Sync employee balances from voucher entries (only for non-optional
        // vouchers), in this transaction (wave 12).
        if (!txVoucher.optional) {
          await syncEmployeeBalancesFromEntries(txEntries, req.session.currentCompanyId!, false, tx);
        }

        // Wave 16 (B): the creation is audited in this transaction.
        const createEntriesSnap = await snapshotVoucherEntries(txEntries, tx);
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "create",
            tableName: "vouchers",
            recordId: txVoucher.id,
            recordIdentifier: txVoucher.voucherNumber,
            changes: buildVoucherChangesForCreate(txVoucher, createEntriesSnap),
          },
          tx
        );

        return { createdVoucher: txVoucher, createdEntries: txEntries };
      });

      const result = { voucher: createdVoucher, entries: createdEntries };

      // Fire-and-forget intercompany notification check (Payment/Receipt only)
      triggerIntercompanyNotifications(
        req.session.currentCompanyId!,
        createdVoucher.id,
        createdVoucher.voucherNumber,
        createdVoucher.voucherDate,
        createdVoucher.totalAmount || "0",
        createdVoucher.description,
        createdEntries.map((e) => e.ledgerAccountId),
        createdVoucher.voucherType
      ).catch(() => {});

      // Fire-and-forget: auto-rerun FIFO allocation for any Loans accounts touched
      autoReallocateLoansAccounts(
        req.session.currentCompanyId!,
        createdEntries.map((e) => e.ledgerAccountId)
      ).catch(() => {});

      logger.info("Voucher with-entries create succeeded", {
        module: "vouchers",
        action: "createWithEntries",
        userId: _uid,
        companyId: _cid,
        voucherId: createdVoucher.id,
        durationMs: Date.now() - _t,
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error("Voucher with-entries create failed", {
        module: "vouchers",
        action: "createWithEntries",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      if (error instanceof PostingValidationError) {
        return res.status(400).json({ message: error.message, code: error.code });
      }
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Create Payment or Receipt voucher with all entries in one batch
}
