/**
 * ledgerRoutesLegacy: AccountingBalanceInit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { companyStockValue } from "../../services/inventory/stockValuation";
import { MoneyDecimal, moneyString, sumMoney, toMoney } from "../../lib/money";

/**
 * Per-account opening balance plus its posted debit/credit totals.
 *
 * Every amount here is a `numeric` column or a `SUM(numeric)`, which the driver
 * returns as a decimal string, and the opening columns are nullable for an
 * account that never had one set.
 */
export interface AccountBalanceAggregateRow {
  opening_balance: string | null;
  opening_balance_side: string | null;
  total_debit: string | null;
  total_credit: string | null;
}
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import {
  ledgerAccounts,
  employees,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  vouchers,
  salesItems,
  salaryAdvances,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { initializeBalancesStep } from "./initializeBalancesStep";

const initializeBalancesInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerAccountingBalanceInitRoutes(app: Express) {
  // Initialize Accounting Balances - read-only: reports each company's import-cycle
  // difference and what a balancing entry would need. It no longer writes plugs.
  app.post(
    "/api/admin/initialize-accounting-balances",
    requireAuth,
    requireRole("Admin"),
    validateRequest(initializeBalancesInput),
    async (req, res) => {
      try {
        const results: Array<{
          companyId: number;
          companyName: string;
          imbalance: number;
          accountCreated: boolean;
          accountUpdated?: boolean;
          accountCode?: string;
          accountName?: string;
          previousBalance?: string;
          openingBalance?: string;
          openingBalanceSide?: string;
          proposedOpeningBalance?: string;
          proposedOpeningBalanceSide?: string;
          message: string;
          components?: {
            assets: { name: string; value: number }[];
            liabilities: { name: string; value: number }[];
            totalAssets: number;
            totalLiabilities: number;
          };
        }> = [];

        // Get all companies
        const allCompanies = await storage.getAllCompanies();

        for (const company of allCompanies) {
          const ib1 = await initializeBalancesStep({ company });
          const {
            ledgerBankBalance,
            standaloneBankOpeningBalance,
            standaloneBankVoucherBalance,
            companyId,
            getAccountTypeBalance,
            stockOtwValue,
            cashBalance,
            directExpenseBalance,
            indirectExpenseBalance,
            supplierBalance,
            dutyAgentBalance,
            transporterAgentBalance,
            loansBalance,
            incomeBalance,
          } = ib1;
          const bankBalance = toMoney(ledgerBankBalance)
            .plus(standaloneBankOpeningBalance)
            .plus(standaloneBankVoucherBalance)
            .toNumber();

          // 11. Stock on Floor
          // Wave 11: the one stock valuation (stockValuation.ts, SUM(total_value)).
          const stockOnFloorValue = Number(await companyStockValue(db, companyId));

          // 12. COGS
          const cogsData = await db
            .select({
              totalCost: salesItems.totalCost,
            })
            .from(salesItems)
            .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
            .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));

          const cogsBalance = cogsData
            .reduce((sum, item) => sum.plus(toMoney(item.totalCost)), new MoneyDecimal(0))
            .toNumber();

          // 12b. Consumption expense (from stock adjustment items)
          // Includes: pure Consumption vouchers AND Mixed voucher items with negative quantity
          const consumptionData = await db
            .select({
              totalAmount: stockAdjustmentItems.totalAmount,
              quantity: stockAdjustmentItems.quantity,
              adjustmentType: stockAdjustmentVouchers.adjustmentType,
            })
            .from(stockAdjustmentItems)
            .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
            .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
            .where(
              and(
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt),
                eq(vouchers.optional, false),
                sql`(LOWER(${stockAdjustmentVouchers.adjustmentType}) = 'consumption' OR LOWER(${stockAdjustmentVouchers.adjustmentType}) = 'mixed')`
              )
            );

          const consumptionBalance = consumptionData
            .reduce((sum, item) => {
              const qty = toMoney(item.quantity).toNumber();
              const adjustmentType = (item.adjustmentType || "").toLowerCase();
              // Pure Consumption: always count (totalAmount is positive, represents consumed value)
              // Mixed: only count items with negative quantity (consumption items)
              if (adjustmentType === "consumption" || (adjustmentType === "mixed" && qty < 0)) {
                return sum.plus(toMoney(item.totalAmount).abs());
              }
              return sum;
            }, new MoneyDecimal(0))
            .toNumber();

          // 12c. Production balance (from stock adjustment items)
          // Includes: pure Production vouchers AND Mixed voucher items with positive quantity
          const productionData = await db
            .select({
              totalAmount: stockAdjustmentItems.totalAmount,
              quantity: stockAdjustmentItems.quantity,
              adjustmentType: stockAdjustmentVouchers.adjustmentType,
            })
            .from(stockAdjustmentItems)
            .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
            .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
            .where(
              and(
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt),
                eq(vouchers.optional, false),
                sql`(LOWER(${stockAdjustmentVouchers.adjustmentType}) = 'production' OR LOWER(${stockAdjustmentVouchers.adjustmentType}) = 'mixed')`
              )
            );

          const productionBalance = productionData
            .reduce((sum, item) => {
              const qty = toMoney(item.quantity).toNumber();
              const adjustmentType = (item.adjustmentType || "").toLowerCase();
              // Pure Production: always count (totalAmount is positive, represents produced value)
              // Mixed: only count items with positive quantity (production items)
              if (adjustmentType === "production" || (adjustmentType === "mixed" && qty > 0)) {
                return sum.plus(toMoney(item.totalAmount));
              }
              return sum;
            }, new MoneyDecimal(0))
            .toNumber();

          // 14. Salary Advances
          const advancesData = await db
            .select({
              remainingBalance: salaryAdvances.remainingBalance,
            })
            .from(salaryAdvances)
            .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false)));

          const salaryAdvancesBalance = advancesData
            .reduce((sum, advance) => sum.plus(toMoney(advance.remainingBalance)), new MoneyDecimal(0))
            .toNumber();

          // 15. Payroll Liabilities
          const employeesData = await db
            .select({
              currentBalance: employees.currentBalance,
            })
            .from(employees)
            .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));

          const payrollLiabilitiesBalance = employeesData
            .reduce((sum, emp) => {
              const balance = toMoney(emp.currentBalance);
              return balance.gt(0) ? sum.plus(balance) : sum;
            }, new MoneyDecimal(0))
            .toNumber();

          // 16-19. Other account type balances
          const assetBalance = await getAccountTypeBalance("Asset", false);
          const governmentTaxesBalance = await getAccountTypeBalance("Government Taxes", false);
          const liabilityBalance = await getAccountTypeBalance("Liability", true);
          const profitBalance = await getAccountTypeBalance("Profit", true);

          // Build components breakdown for verification
          // NOTE: Production and Consumption are shown for reference but NOT included in the balance calculation
          //       Their effects are already reflected in stockOnFloorValue (inventory movements)
          const assetComponents = [
            { name: "Stock OTW", value: stockOtwValue },
            { name: "Cash", value: cashBalance },
            { name: "Bank", value: bankBalance },
            { name: "Stock on Floor", value: stockOnFloorValue },
            { name: "Assets", value: assetBalance },
            { name: "Direct Expenses", value: directExpenseBalance },
            { name: "Indirect Expenses", value: indirectExpenseBalance },
            { name: "Government Taxes", value: governmentTaxesBalance },
            { name: "COGS", value: cogsBalance },
            { name: "Salary Advances", value: salaryAdvancesBalance },
            { name: "Consumption (info only)", value: consumptionBalance },
            { name: "Production (info only)", value: productionBalance },
          ].filter((c) => Math.abs(c.value) >= 0.01);

          const liabilityComponents = [
            { name: "Supplier Balance", value: supplierBalance },
            { name: "Duty Agent", value: dutyAgentBalance },
            { name: "Transporter Agent", value: transporterAgentBalance },
            { name: "Loans", value: loansBalance },
            { name: "Liabilities", value: liabilityBalance },
            { name: "Profit/Equity", value: profitBalance },
            { name: "Income", value: incomeBalance },
            { name: "Payroll Liabilities", value: payrollLiabilitiesBalance },
          ].filter((c) => Math.abs(c.value) >= 0.01);

          // NOTE: Production and Consumption are EXCLUDED from the balance calculation
          // Their effects are already reflected in stockOnFloorValue (inventory movements)
          // They are tracked for informational/diagnostic purposes only
          // T003: directExpenseBalance is intentionally EXCLUDED here (matches the canonical import-cycle-balance formula).
          // Import charges (duties, transport, etc.) are already capitalized into stockOnFloorValue — including
          // them again in assets double-counts those costs and causes the profit recalculation to overshoot.
          const totalAssets = sumMoney([
            stockOtwValue,
            cashBalance,
            bankBalance,
            stockOnFloorValue,
            assetBalance,
            indirectExpenseBalance,
            governmentTaxesBalance,
            cogsBalance,
            salaryAdvancesBalance,
          ]).toNumber();

          // Calculate liabilities WITHOUT profit (to avoid circular dependency)
          const totalLiabilitiesWithoutProfit = sumMoney([
            supplierBalance,
            dutyAgentBalance,
            transporterAgentBalance,
            loansBalance,
            liabilityBalance,
            incomeBalance,
            payrollLiabilitiesBalance,
          ]).toNumber();

          // Total liabilities includes profit for display purposes
          const totalLiabilities = toMoney(totalLiabilitiesWithoutProfit).plus(profitBalance).toNumber();

          // Calculate the net import cycle balance (imbalance)
          const netImportCycleBalance = toMoney(totalAssets).minus(totalLiabilities).toNumber();

          // The TARGET profit to zero the balance: Profit = Assets - Liabilities_without_profit
          const targetProfitSigned = toMoney(totalAssets).minus(totalLiabilitiesWithoutProfit).toNumber();

          const componentsBreakdown = {
            assets: assetComponents,
            liabilities: liabilityComponents,
            totalAssets,
            totalLiabilities,
          };

          // If imbalance is very small (< $1), consider it balanced
          if (Math.abs(netImportCycleBalance) < 1) {
            results.push({
              companyId,
              companyName: company.name,
              imbalance: netImportCycleBalance,
              accountCreated: false,
              message: "Already balanced (imbalance < $1)",
              components: componentsBreakdown,
            });
            continue;
          }

          // Check if any Profit account exists - if so, update the first one instead of creating new
          const existingProfitAccounts = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                eq(ledgerAccounts.accountType, "Profit"),
                isNull(ledgerAccounts.deletedAt)
              )
            );

          if (existingProfitAccounts.length > 0) {
            // Update the first/main Profit account instead of creating new
            const profitAccount = existingProfitAccounts[0];
            const currentBalance = toMoney(profitAccount.openingBalance).toNumber();
            const currentSide = profitAccount.openingBalanceSide || "Cr";

            // Calculate the current opening balance as a signed value
            // For Profit accounts: Cr is positive (normal), Dr is negative
            const currentOpeningSigned = currentSide === "Cr" ? currentBalance : -currentBalance;

            // profitBalance = opening balance + voucher entries
            // So netEntries = profitBalance - currentOpeningSigned
            const netEntries = toMoney(profitBalance).minus(currentOpeningSigned);

            // We want total Profit balance (opening + entries) = targetProfitSigned
            // So: newOpening + netEntries = targetProfitSigned
            // Therefore: newOpening = targetProfitSigned - netEntries
            const newOpeningSigned = toMoney(targetProfitSigned).minus(netEntries);

            // Convert to absolute value and side (positive = Cr for equity/profit accounts)
            const newOpeningBalance = moneyString(newOpeningSigned.abs());
            const newOpeningBalanceSide: "Dr" | "Cr" = newOpeningSigned.gte(0) ? "Cr" : "Dr";

            // Report only. Rewriting an opening balance to make the books "balance"
            // hides the real difference (2026-10 accounting audit); the difference
            // must be investigated and corrected with a reviewed, posted entry.
            results.push({
              companyId,
              companyName: company.name,
              imbalance: netImportCycleBalance,
              accountCreated: false,
              accountUpdated: false,
              accountCode: profitAccount.code,
              accountName: profitAccount.name,
              previousBalance: `${currentBalance.toFixed(2)} ${currentSide}`,
              proposedOpeningBalance: newOpeningBalance,
              proposedOpeningBalanceSide: newOpeningBalanceSide,
              message: "Not changed. Investigate the difference and post a correcting entry.",
              components: componentsBreakdown,
            });
            continue;
          }

          // No existing Profit account.
          const accountName = "Owner's Capital";

          // Set Profit = Assets - Liabilities_without_profit to zero the import cycle
          // Positive target = Cr (equity), Negative target = Dr
          const openingBalanceSide: "Dr" | "Cr" = targetProfitSigned >= 0 ? "Cr" : "Dr";
          const openingBalanceAmount = moneyString(Math.abs(targetProfitSigned));

          // Report only: no balancing capital account is created (see above).
          results.push({
            companyId,
            companyName: company.name,
            imbalance: netImportCycleBalance,
            accountCreated: false,
            proposedOpeningBalance: openingBalanceAmount,
            proposedOpeningBalanceSide: openingBalanceSide,
            accountName,
            message: "Not changed. Investigate the difference and post a correcting entry.",
            components: componentsBreakdown,
          });
        }

        res.json({
          message: "No balances were changed",
          results,
        });
      } catch (error: unknown) {
        logger.error("Error initializing accounting balances:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Employees
}
