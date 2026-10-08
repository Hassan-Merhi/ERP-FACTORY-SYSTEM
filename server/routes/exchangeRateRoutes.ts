/**
 * Exchange-rate routes.
 *
 * Daily exchange-rate existence check, listing, latest-rate lookup, and
 * create/update. Extracted from authRoutes.ts as a sub-registrar; behaviour is
 * unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, ne, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { getCompanyBusinessDate } from "../lib/dateUtils";
import { exchangeRates, insertExchangeRateSchema, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, debitMinusCredit, signedOpeningBalance, toMoney } from "../lib/money";

export function registerExchangeRateRoutes(app: Express) {
  // Check if today's exchange rate exists
  app.get("/api/exchange-rates/check-today", requireAuth, async (req, res) => {
    try {
      const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }

      const company = await storage.getCompanyById(companyId);
      if (!company?.displayCurrency || company.displayCurrency === "none") {
        return res.json({ hasRate: true });
      }

      // "Today" is the company's own business date (its configured timezone), never the
      // requesting browser's clock — otherwise two users in different timezones/devices
      // could disagree on whether "today's" rate has been set for this shared company.
      const companySettings = await storage.getCompanySettings(companyId);
      const today = getCompanyBusinessDate(companySettings?.timezone);

      const latestRate = await storage.getLatestExchangeRate(
        companyId,
        company.baseCurrency || "",
        company.displayCurrency
      );

      if (!latestRate) {
        return res.json({ hasRate: false, today });
      }

      const rateDate = new Date(latestRate.effectiveDate).toISOString().split("T")[0];
      const hasRate = rateDate === today;

      res.json({ hasRate, latestRate, today });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Exchange Rates - Get all rates for current company
  app.get("/api/exchange-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }
      const rates = await storage.getExchangeRates(companyId);
      res.json(rates);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get latest exchange rate for a currency pair
  app.get("/api/exchange-rates/latest", requireAuth, async (req, res) => {
    try {
      // Allow companyId from query param (for frontend context) or fall back to session
      const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }
      const { fromCurrency, toCurrency } = req.query;
      if (!fromCurrency || !toCurrency) {
        return res.status(400).json({ message: "fromCurrency and toCurrency are required" });
      }
      const rate = await storage.getLatestExchangeRate(companyId, fromCurrency as string, toCurrency as string);
      res.json(rate || null);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Create a new exchange rate
  app.post("/api/exchange-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "Company not selected" });
      }
      const rateData = {
        ...req.body,
        companyId,
      };

      // Validate input with Zod schema
      const validationResult = insertExchangeRateSchema.safeParse(rateData);
      if (!validationResult.success) {
        return res.status(400).json({
          message: "Validation error",
          errors: validationResult.error.issues,
        });
      }

      // Atomic upsert — relies on the exchange_rates_company_date_pair_unique DB
      // constraint so two users saving the same company/date/pair concurrently can
      // never create duplicate rows; the second save simply updates the first's row.
      const rate = await storage.upsertExchangeRate(validationResult.data);

      // --- Auto-revalue Cash accounts when exchange rate changes ---
      // Runs before the response so balance queries see the updated data immediately.
      // Wrapped in try/catch so a revaluation failure never fails the main request.
      // NOTE: the body below MUST stay inside this async IIFE — a bare `return` used to
      // sit directly in the route handler's try block, which meant every early-exit path
      // (no previous rate yet, no cash accounts, no meaningful change, etc.) returned from
      // the whole POST handler and skipped res.json(rate) entirely, hanging the request
      // forever. That silently broke "Set Today's Rate" on the very first save for any
      // company (no previous rate to compare against) until the client eventually timed out.
      try {
        await (async () => {
          const { fromCurrency, toCurrency } = validationResult.data;
          const newRate = toMoney(validationResult.data.rate);

          // Get the previous rate (second most-recent for this currency pair)
          const [prevRateRow] = await db
            .select()
            .from(exchangeRates)
            .where(
              and(
                eq(exchangeRates.companyId, companyId),
                eq(exchangeRates.fromCurrency, fromCurrency),
                eq(exchangeRates.toCurrency, toCurrency),
                ne(exchangeRates.id, rate.id)
              )
            )
            .orderBy(sql`${exchangeRates.effectiveDate} DESC`)
            .limit(1);

          if (!prevRateRow) return; // First-ever rate — nothing to revalue
          const oldRate = toMoney(prevRateRow.rate);
          if (oldRate.minus(newRate).abs().lt("0.0001") || newRate.lte(0)) return; // No meaningful change

          // Find all Cash-type ledger accounts for this company
          const cashAccounts = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                eq(ledgerAccounts.accountType, "Cash"),
                isNull(ledgerAccounts.deletedAt)
              )
            );

          if (cashAccounts.length === 0) return;

          // Compute balance per account and calculate revaluation adjustment
          // Exact decimals, each adjustment at cents: the voucher total is the sum
          // of the cents actually posted, so header and lines always agree.
          const adjustments: Array<{ accountId: number; diff: Decimal }> = [];
          let totalAbsDiff: Decimal = new MoneyDecimal(0);

          for (const account of cashAccounts) {
            // Get all non-deleted, non-optional voucher entries for this account
            const entries = await db
              .select({
                debitAmount: voucherEntries.debitAmount,
                creditAmount: voucherEntries.creditAmount,
              })
              .from(voucherEntries)
              .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
              .where(
                and(
                  eq(voucherEntries.ledgerAccountId, account.id),
                  eq(vouchers.companyId, companyId),
                  isNull(vouchers.deletedAt),
                  eq(vouchers.optional, false)
                )
              );

            // Opening balance (Asset/Cash: Dr = positive)
            const signedOpening = signedOpeningBalance(account.openingBalance, account.openingBalanceSide);

            // Sum debit - credit for asset accounts
            const voucherBalance = debitMinusCredit(entries);

            const usdBalance = signedOpening.plus(voucherBalance);

            if (usdBalance.abs().lt("0.01")) continue; // Skip zero-balance accounts

            // Reconstruct approximate CFA amount and compute new USD value
            // cfaAmount = usdBalance * oldRate  (how many CFA we hold)
            // newUsd     = cfaAmount / newRate   (what those CFA are worth now)
            const cfaAmount = usdBalance.times(oldRate);
            const newUsd = cfaAmount.div(newRate);
            // positive = FX gain, negative = FX loss
            const diff = newUsd.minus(usdBalance).toDecimalPlaces(2);

            if (diff.abs().lt("0.01")) continue;

            adjustments.push({ accountId: account.id, diff });
            totalAbsDiff = totalAbsDiff.plus(diff.abs());
          }

          if (adjustments.length === 0 || totalAbsDiff.lt("0.01")) return;

          // Find or create the FX Revaluation ledger account
          let [fxAccount] = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                eq(ledgerAccounts.code, "FX-REVALUATION"),
                isNull(ledgerAccounts.deletedAt)
              )
            );

          if (!fxAccount) {
            [fxAccount] = await db
              .insert(ledgerAccounts)
              .values({
                companyId,
                code: "FX-REVALUATION",
                name: "FX Revaluation Gain/Loss",
                accountType: "Indirect Expense",
                openingBalance: "0",
                openingBalanceSide: "Dr",
              })
              .returning();
          }

          // Create a revaluation Journal voucher
          const voucherNumber = `FX-REVAL-${Date.now()}`;
          const voucherDate = validationResult.data.effectiveDate;
          const rateChangeDesc = newRate.gt(oldRate)
            ? `Rate ↑ ${oldRate.toNumber().toLocaleString()} → ${newRate.toNumber().toLocaleString()} ${toCurrency} (FX loss)`
            : `Rate ↓ ${oldRate.toNumber().toLocaleString()} → ${newRate.toNumber().toLocaleString()} ${toCurrency} (FX gain)`;

          const [revalVoucher] = await db
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber,
              voucherType: "Journal",
              voucherDate,
              description: `FX Revaluation — ${rateChangeDesc}`,
              totalAmount: totalAbsDiff.toFixed(2),
              currency: "USD",
              optional: false,
              sourceModule: "ERP",
            })
            .returning();

          // Build voucher entries for every adjusted cash account
          const entryRows = [];
          for (const { accountId, diff } of adjustments) {
            if (diff.lt(0)) {
              // FX loss: Credit cash, Debit FX expense
              entryRows.push({
                voucherId: revalVoucher.id,
                ledgerAccountId: accountId,
                debitAmount: "0",
                creditAmount: diff.abs().toFixed(2),
                narration: "FX revaluation adjustment",
              });
              entryRows.push({
                voucherId: revalVoucher.id,
                ledgerAccountId: fxAccount.id,
                debitAmount: diff.abs().toFixed(2),
                creditAmount: "0",
                narration: "FX revaluation adjustment",
              });
            } else {
              // FX gain: Debit cash, Credit FX account
              entryRows.push({
                voucherId: revalVoucher.id,
                ledgerAccountId: accountId,
                debitAmount: diff.toFixed(2),
                creditAmount: "0",
                narration: "FX revaluation adjustment",
              });
              entryRows.push({
                voucherId: revalVoucher.id,
                ledgerAccountId: fxAccount.id,
                debitAmount: "0",
                creditAmount: diff.toFixed(2),
                narration: "FX revaluation adjustment",
              });
            }
          }

          await db.insert(voucherEntries).values(entryRows);
          logger.info(
            `[FX Revaluation] Created voucher ${voucherNumber}: ${adjustments.length} cash account(s) adjusted, total Δ ${totalAbsDiff.toFixed(2)}`
          );
        })();
      } catch (revalErr) {
        logger.error("[FX Revaluation] Error during auto-revaluation:", { error: revalErr });
      }

      res.json(rate);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
