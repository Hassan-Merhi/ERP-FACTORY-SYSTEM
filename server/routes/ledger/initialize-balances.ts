/**
 * ledgerRoutesLegacy: AccountingBalanceInit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db, type RawQueryRow } from "../../db";
import { toFiniteNumber } from "@shared/typeGuards";

/**
 * Per-account opening balance plus its posted debit/credit totals.
 *
 * Every amount here is a `numeric` column or a `SUM(numeric)`, which the driver
 * returns as a decimal string, and the opening columns are nullable for an
 * account that never had one set.
 */
interface AccountBalanceAggregateRow {
  opening_balance: string | null;
  opening_balance_side: string | null;
  total_debit: string | null;
  total_credit: string | null;
}
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import {
  locations,
  inventory,
  ledgerAccounts,
  employees,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  containers,
  vouchers,
  voucherEntries,
  salesItems,
  bankAccounts,
  salaryAdvances,
} from "@shared/schema";
import { eq, and, or, inArray, sql, isNull, isNotNull } from "drizzle-orm";

export function registerAccountingBalanceInitRoutes(app: Express) {
  // Initialize Accounting Balances - creates Owner's Capital accounts to balance the Import Cycle
  app.post("/api/admin/initialize-accounting-balances", requireAuth, requireRole("Admin"), async (req, res) => {
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
        const companyId = company.id;

        // Single-query aggregate replaces N+1 (fetch accounts → per-account entry fetch)
        const getAccountTypeBalance = async (accountType: string, isLiability: boolean = false) => {
          const rows = await db.execute<RawQueryRow<AccountBalanceAggregateRow>>(sql`
              SELECT
                la.opening_balance,
                la.opening_balance_side,
                COALESCE(SUM(CAST(ve.debit_amount  AS numeric)), 0) AS total_debit,
                COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_credit
              FROM ledger_accounts la
              LEFT JOIN voucher_entries ve
                ON  ve.ledger_account_id = la.id
                AND ve.voucher_id IN (
                  SELECT id FROM vouchers
                   WHERE company_id  = ${companyId}
                     AND optional    = false
                     AND deleted_at IS NULL
                )
              WHERE la.company_id   = ${companyId}
                AND la.account_type = ${accountType}
                AND la.deleted_at  IS NULL
              GROUP BY la.id, la.opening_balance, la.opening_balance_side
            `);

          let totalBalance = 0;
          for (const row of rows.rows) {
            const openingBalanceRaw = toFiniteNumber(row.opening_balance) ?? 0;
            const openingSide = row.opening_balance_side || "Dr";
            const signedOpening = isLiability
              ? openingSide === "Cr"
                ? openingBalanceRaw
                : -openingBalanceRaw
              : openingSide === "Dr"
                ? openingBalanceRaw
                : -openingBalanceRaw;
            const debit = toFiniteNumber(row.total_debit) ?? 0;
            const credit = toFiniteNumber(row.total_credit) ?? 0;
            totalBalance += signedOpening + (isLiability ? credit - debit : debit - credit);
          }
          return totalBalance;
        };

        // Helper function: Get Import Charges balance (only under IMPORT_CHARGES parent account)
        // This must match the calculation in the import-cycle-balance endpoint
        const getImportChargesBalance = async () => {
          // First find the IMPORT_CHARGES parent account
          const [importChargesParent] = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                eq(ledgerAccounts.code, "IMPORT_CHARGES"),
                isNull(ledgerAccounts.deletedAt)
              )
            )
            .limit(1);

          if (!importChargesParent) {
            return 0; // No import charges yet
          }

          // Get all accounts under IMPORT_CHARGES parent (including the parent itself)
          const importChargeAccounts = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                or(eq(ledgerAccounts.id, importChargesParent.id), eq(ledgerAccounts.parentId, importChargesParent.id)),
                isNull(ledgerAccounts.deletedAt)
              )
            );

          if (importChargeAccounts.length === 0) {
            return 0;
          }

          const accountIds = importChargeAccounts.map((a) => a.id);

          // Get opening balances
          let totalBalance = importChargeAccounts.reduce((sum, account) => {
            const openingBalanceRaw = parseFloat(account.openingBalance || "0");
            const openingSide = account.openingBalanceSide || "Dr";
            // Expense accounts: Dr opening = positive
            return sum + (openingSide === "Dr" ? openingBalanceRaw : -openingBalanceRaw);
          }, 0);

          // Get all voucher entries for these accounts
          const entries = await db
            .select({
              creditAmount: voucherEntries.creditAmount,
              debitAmount: voucherEntries.debitAmount,
            })
            .from(voucherEntries)
            .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
            .where(
              and(
                inArray(voucherEntries.ledgerAccountId, accountIds),
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt),
                eq(vouchers.optional, false)
              )
            );

          // Expense accounts: Debits increase (positive), Credits decrease (negative)
          totalBalance += entries.reduce((sum, entry) => {
            const credit = parseFloat(entry.creditAmount || "0");
            const debit = parseFloat(entry.debitAmount || "0");
            return sum + debit - credit;
          }, 0);

          return totalBalance;
        };

        // Calculate all balances (same logic as import-cycle-balance endpoint)
        // 1. Supplier Balance - calculated from voucher entries only (company-scoped)
        // NOTE: Supplier opening balances are global and cannot be attributed to a single company
        // Future enhancement: Add per-company supplier opening balances table
        const supplierEntries = await db
          .select({
            creditAmount: voucherEntries.creditAmount,
            debitAmount: voucherEntries.debitAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              isNotNull(voucherEntries.supplierId),
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              eq(vouchers.optional, false)
            )
          );

        // Supplier is a liability: Credits increase (we owe more), Debits decrease (we paid)
        const supplierBalance = supplierEntries.reduce((sum, entry) => {
          const credit = parseFloat(entry.creditAmount || "0");
          const debit = parseFloat(entry.debitAmount || "0");
          return sum + credit - debit;
        }, 0);

        // 2. Stock OTW
        const otwContainers = await db
          .select()
          .from(containers)
          .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
        const stockOtwValue = otwContainers.reduce((sum, container) => {
          return sum + parseFloat(container.grandTotal || "0");
        }, 0);

        // 3-10: All independent — run in parallel
        const [
          dutyAgentBalance,
          transporterAgentBalance,
          loansBalance,
          cashBalance,
          ledgerBankBalance,
          standaloneBankAccountEntries,
          standaloneBankAccountsForBalance,
          directExpenseBalance,
          indirectExpenseBalance,
          incomeBalance,
        ] = await Promise.all([
          getAccountTypeBalance("Duty Agent", true),
          getAccountTypeBalance("Transporter Agent", true),
          getAccountTypeBalance("Loans", true),
          getAccountTypeBalance("Cash", false),
          getAccountTypeBalance("Bank", false),
          db
            .select({
              bankAccountId: voucherEntries.bankAccountId,
              creditAmount: voucherEntries.creditAmount,
              debitAmount: voucherEntries.debitAmount,
            })
            .from(voucherEntries)
            .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
            .innerJoin(bankAccounts, eq(voucherEntries.bankAccountId, bankAccounts.id))
            .where(
              and(
                isNotNull(voucherEntries.bankAccountId),
                isNull(voucherEntries.ledgerAccountId),
                isNull(bankAccounts.linkedLedgerId),
                eq(bankAccounts.companyId, companyId),
                isNull(bankAccounts.deletedAt),
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt),
                eq(vouchers.optional, false)
              )
            ),
          db
            .select()
            .from(bankAccounts)
            .where(
              and(
                eq(bankAccounts.companyId, companyId),
                isNull(bankAccounts.deletedAt),
                isNull(bankAccounts.linkedLedgerId)
              )
            ),
          getImportChargesBalance(),
          getAccountTypeBalance("Indirect Expense", false),
          getAccountTypeBalance("Income", true),
        ]);

        const standaloneBankOpeningBalance = standaloneBankAccountsForBalance.reduce((sum, account) => {
          const openingBalanceRaw = parseFloat(account.openingBalance || "0");
          const openingSide = account.openingBalanceSide || "Dr";
          return sum + (openingSide === "Dr" ? openingBalanceRaw : -openingBalanceRaw);
        }, 0);
        const standaloneBankVoucherBalance = standaloneBankAccountEntries.reduce((sum, entry) => {
          const credit = parseFloat(entry.creditAmount || "0");
          const debit = parseFloat(entry.debitAmount || "0");
          return sum + debit - credit;
        }, 0);
        const bankBalance = ledgerBankBalance + standaloneBankOpeningBalance + standaloneBankVoucherBalance;

        // 11. Stock on Floor
        // Calculate from quantity * averageRate to ensure accuracy (totalValue can get out of sync)
        const inventoryItems = await db
          .select({
            quantity: inventory.quantity,
            averageRate: inventory.averageRate,
          })
          .from(inventory)
          .innerJoin(locations, eq(inventory.locationId, locations.id))
          .where(and(eq(inventory.companyId, companyId), isNull(locations.deletedAt)));

        const stockOnFloorValue = inventoryItems.reduce((sum, item) => {
          const qty = parseFloat(item.quantity || "0");
          const rate = parseFloat(item.averageRate || "0");
          return sum + qty * rate;
        }, 0);

        // 12. COGS
        const cogsData = await db
          .select({
            totalCost: salesItems.totalCost,
          })
          .from(salesItems)
          .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
          .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));

        const cogsBalance = cogsData.reduce((sum, item) => {
          return sum + parseFloat(item.totalCost || "0");
        }, 0);

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

        const consumptionBalance = consumptionData.reduce((sum, item) => {
          const qty = parseFloat(item.quantity || "0");
          const adjustmentType = (item.adjustmentType || "").toLowerCase();
          // Pure Consumption: always count (totalAmount is positive, represents consumed value)
          // Mixed: only count items with negative quantity (consumption items)
          if (adjustmentType === "consumption" || (adjustmentType === "mixed" && qty < 0)) {
            return sum + Math.abs(parseFloat(item.totalAmount || "0"));
          }
          return sum;
        }, 0);

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

        const productionBalance = productionData.reduce((sum, item) => {
          const qty = parseFloat(item.quantity || "0");
          const adjustmentType = (item.adjustmentType || "").toLowerCase();
          // Pure Production: always count (totalAmount is positive, represents produced value)
          // Mixed: only count items with positive quantity (production items)
          if (adjustmentType === "production" || (adjustmentType === "mixed" && qty > 0)) {
            return sum + parseFloat(item.totalAmount || "0");
          }
          return sum;
        }, 0);

        // 14. Salary Advances
        const advancesData = await db
          .select({
            remainingBalance: salaryAdvances.remainingBalance,
          })
          .from(salaryAdvances)
          .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false)));

        const salaryAdvancesBalance = advancesData.reduce((sum, advance) => {
          return sum + parseFloat(advance.remainingBalance || "0");
        }, 0);

        // 15. Payroll Liabilities
        const employeesData = await db
          .select({
            currentBalance: employees.currentBalance,
          })
          .from(employees)
          .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));

        const payrollLiabilitiesBalance = employeesData.reduce((sum, emp) => {
          const balance = parseFloat(emp.currentBalance || "0");
          return sum + (balance > 0 ? balance : 0);
        }, 0);

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
        const totalAssets =
          stockOtwValue +
          cashBalance +
          bankBalance +
          stockOnFloorValue +
          assetBalance +
          indirectExpenseBalance +
          governmentTaxesBalance +
          cogsBalance +
          salaryAdvancesBalance;

        // Calculate liabilities WITHOUT profit (to avoid circular dependency)
        const totalLiabilitiesWithoutProfit =
          supplierBalance +
          dutyAgentBalance +
          transporterAgentBalance +
          loansBalance +
          liabilityBalance +
          incomeBalance +
          payrollLiabilitiesBalance;

        // Total liabilities includes profit for display purposes
        const totalLiabilities = totalLiabilitiesWithoutProfit + profitBalance;

        // Calculate the net import cycle balance (imbalance)
        const netImportCycleBalance = totalAssets - totalLiabilities;

        // The TARGET profit to zero the balance: Profit = Assets - Liabilities_without_profit
        const targetProfitSigned = totalAssets - totalLiabilitiesWithoutProfit;

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
          const currentBalance = parseFloat(profitAccount.openingBalance || "0");
          const currentSide = profitAccount.openingBalanceSide || "Cr";

          // Calculate the current opening balance as a signed value
          // For Profit accounts: Cr is positive (normal), Dr is negative
          const currentOpeningSigned = currentSide === "Cr" ? currentBalance : -currentBalance;

          // profitBalance = opening balance + voucher entries
          // So netEntries = profitBalance - currentOpeningSigned
          const netEntries = profitBalance - currentOpeningSigned;

          // We want total Profit balance (opening + entries) = targetProfitSigned
          // So: newOpening + netEntries = targetProfitSigned
          // Therefore: newOpening = targetProfitSigned - netEntries
          const newOpeningSigned = targetProfitSigned - netEntries;

          // Convert to absolute value and side (positive = Cr for equity/profit accounts)
          const newOpeningBalance = Math.abs(newOpeningSigned).toFixed(2);
          const newOpeningBalanceSide: "Dr" | "Cr" = newOpeningSigned >= 0 ? "Cr" : "Dr";

          // Update the account using raw query since storage.updateLedgerAccount may not support all fields
          await db
            .update(ledgerAccounts)
            .set({
              openingBalance: newOpeningBalance,
              openingBalanceSide: newOpeningBalanceSide,
            })
            .where(eq(ledgerAccounts.id, profitAccount.id));

          results.push({
            companyId,
            companyName: company.name,
            imbalance: netImportCycleBalance,
            accountCreated: false,
            accountUpdated: true,
            accountCode: profitAccount.code,
            accountName: profitAccount.name,
            previousBalance: `${currentBalance.toFixed(2)} ${currentSide}`,
            openingBalance: newOpeningBalance,
            openingBalanceSide: newOpeningBalanceSide,
            message: `Updated ${profitAccount.code} - ${profitAccount.name}: ${currentBalance.toFixed(2)} ${currentSide} → ${newOpeningBalance} ${newOpeningBalanceSide}`,
            components: componentsBreakdown,
          });
          continue;
        }

        // No existing Profit account - generate unique code for new capital account
        const nextCodeNum = 1;
        const accountCode = `CAP-${String(nextCodeNum).padStart(3, "0")}`;
        const accountName = "Owner's Capital";

        // Set Profit = Assets - Liabilities_without_profit to zero the import cycle
        // Positive target = Cr (equity), Negative target = Dr
        const openingBalanceSide: "Dr" | "Cr" = targetProfitSigned >= 0 ? "Cr" : "Dr";
        const openingBalanceAmount = Math.abs(targetProfitSigned).toFixed(2);

        // Create the Owner's Capital account
        await storage.createLedgerAccount({
          companyId,
          code: accountCode,
          name: accountName,
          accountType: "Profit",
          openingBalance: openingBalanceAmount,
          openingBalanceSide: openingBalanceSide,
          active: true,
        });

        results.push({
          companyId,
          companyName: company.name,
          imbalance: netImportCycleBalance,
          accountCreated: true,
          accountCode,
          accountName,
          openingBalance: openingBalanceAmount,
          openingBalanceSide,
          message: `Created ${accountCode} - ${accountName} with opening balance ${openingBalanceAmount} ${openingBalanceSide}`,
          components: componentsBreakdown,
        });
      }

      // Generate SQL summary for production database
      const sqlStatements: string[] = [];
      for (const result of results) {
        if (result.accountCreated) {
          sqlStatements.push(
            `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)\nVALUES (${result.companyId}, '${result.accountCode}', '${result.accountName}', 'Profit', ${result.openingBalance}, '${result.openingBalanceSide}', true);`
          );
        } else if (result.accountUpdated) {
          sqlStatements.push(
            `UPDATE ledger_accounts SET opening_balance = '${result.openingBalance}', opening_balance_side = '${result.openingBalanceSide}'\nWHERE company_id = ${result.companyId} AND code = '${result.accountCode}';`
          );
        }
      }

      res.json({
        message: `Processed ${results.length} companies`,
        results,
        sqlForProduction:
          sqlStatements.length > 0 ? sqlStatements.join("\n\n") : "No accounts needed to be created or updated",
      });
    } catch (error: unknown) {
      logger.error("Error initializing accounting balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Employees
}
