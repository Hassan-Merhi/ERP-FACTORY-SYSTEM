/**
 * importCycleRoutes: ImportCycleBalance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import {
  inventory,
  stockItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  containers,
  bankAccounts,
  vouchers,
  voucherEntries,
  salesItems,
  suppliers,
  employees,
  locations,
  salaryAdvances,
} from "@shared/schema";
import { eq, and, sql, isNull, isNotNull } from "drizzle-orm";
import type Decimal from "decimal.js";
import { getAccountNetBalanceExact } from "../../netPositionHelper";
import { classifyAccountType } from "../../services/accounting/accountClassification";
import { MoneyDecimal, debitMinusCredit, sumMoney, toMoney } from "../../lib/money";

import { _getCached, _setCached } from "./_helpers";

export function registerImportCycleBalanceRoutes(app: Express) {
  app.get("/api/stats/import-cycle-balance", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const _cacheKey = `import-cycle-balance:${companyId}`;
      const _cached = _getCached(_cacheKey);
      if (_cached) return res.json(_cached);

      // Aggregate voucher entries in PostgreSQL instead of materialising every row
      // into Node. Company 1 currently has ~19k matching entry rows; the grouped
      // result is only a few hundred rows and preserves the exact ledger and
      // pure-side supplier semantics used by this endpoint.
      const groupedBalanceRows = await pool.query<{
        kind: "ledger" | "supplier";
        entity_id: number;
        total_debit: string;
        total_credit: string;
      }>(
        `WITH entries AS MATERIALIZED (
           SELECT
             ve.ledger_account_id,
             ve.supplier_id,
             ve.debit_amount::numeric AS debit_amount,
             ve.credit_amount::numeric AS credit_amount
           FROM voucher_entries ve
           JOIN vouchers v ON v.id = ve.voucher_id
           WHERE v.company_id = $1
             AND v.optional = false
             AND v.deleted_at IS NULL
         )
         SELECT
           'ledger'::text AS kind,
           ledger_account_id AS entity_id,
           COALESCE(SUM(debit_amount), 0)::text AS total_debit,
           COALESCE(SUM(credit_amount), 0)::text AS total_credit
         FROM entries
         WHERE ledger_account_id IS NOT NULL
         GROUP BY ledger_account_id

         UNION ALL

         SELECT
           'supplier'::text AS kind,
           supplier_id AS entity_id,
           COALESCE(SUM(CASE
             WHEN debit_amount > 0 AND credit_amount = 0 THEN debit_amount
             ELSE 0
           END), 0)::text AS total_debit,
           COALESCE(SUM(CASE
             WHEN credit_amount > 0 AND debit_amount = 0 THEN credit_amount
             ELSE 0
           END), 0)::text AS total_credit
         FROM entries
         WHERE supplier_id IS NOT NULL
         GROUP BY supplier_id`,
        [companyId]
      );

      const accountBalances = new Map<number, { debit: Decimal; credit: Decimal }>();
      const supplierBalancesMap = new Map<number, { debit: Decimal; credit: Decimal }>();

      for (const row of groupedBalanceRows.rows) {
        const balance = { debit: toMoney(row.total_debit), credit: toMoney(row.total_credit) };
        if (row.kind === "ledger") accountBalances.set(Number(row.entity_id), balance);
        else supplierBalancesMap.set(Number(row.entity_id), balance);
      }

      // The account list and parent-company lookup are independent.
      const [companyAccounts, parentCompanyId] = await Promise.all([
        storage.getAllLedgerAccounts(companyId, true),
        storage.getParentCompanyId(),
      ]);

      // Signed net balance for a single account (mirrors getAccountNetBalance from netPositionHelper)
      const nb = (acc: (typeof companyAccounts)[0]) => getAccountNetBalanceExact(acc, accountBalances);

      // Sum net balances for accounts matching the given type(s)
      const sumNB = (types: string[]) =>
        sumMoney(companyAccounts.filter((a) => types.includes(a.accountType || "")).map(nb));
      const ZERO = new MoneyDecimal(0);
      const atLeastZero = (value: Decimal) => MoneyDecimal.max(ZERO, value);

      // 1. Supplier Balance — same pure-debit/credit logic as /api/stats/net-profit
      const shouldIncludeSuppliers = parentCompanyId === null || companyId === parentCompanyId;

      // These reads are independent. Keep the batch small so one analytics
      // request cannot monopolise the application pool while still eliminating
      // four sequential network/database round trips.
      const [allSuppliers, otwContainers, standaloneBankAccountEntries, standaloneBankAccounts] = await Promise.all([
        shouldIncludeSuppliers
          ? db.select().from(suppliers).where(isNull(suppliers.deletedAt)).execute()
          : Promise.resolve([]),
        db
          .select()
          .from(containers)
          .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW"))),
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
      ]);

      let supplierLiabilities = ZERO;
      let supplierAssets = ZERO;
      if (shouldIncludeSuppliers) {
        for (const sup of allSuppliers) {
          const bal = supplierBalancesMap.get(sup.id);
          if (!bal) continue;
          const netBalance = toMoney(sup.openingBalance).plus(bal.credit).minus(bal.debit);
          if (netBalance.greaterThan(0)) supplierLiabilities = supplierLiabilities.plus(netBalance);
          else if (netBalance.lessThan(0)) supplierAssets = supplierAssets.plus(netBalance.abs());
        }
      }
      const supplierBalance = supplierLiabilities.minus(supplierAssets);

      const stockOtwValue = sumMoney(
        otwContainers.map((container) => {
          const gTotal = toMoney(container.grandTotal);
          return gTotal.isZero() ? toMoney(container.itemsTotal) : gTotal;
        })
      );

      // 3-5. Duty Agent / Transporter Agent / Loans
      // NOTE: account type is "Loan" (singular) — matches netPositionHelper constants and DB values
      const dutyAgentBalance = atLeastZero(sumNB(["Duty Agent"]).negated());
      const transporterAgentBalance = atLeastZero(sumNB(["Transporter Agent"]).negated());
      const loansBalance = atLeastZero(sumNB(["Loan"]).negated());

      // 6. Cash (asset — positive debit balance)
      const cashBalance = atLeastZero(sumNB(["Cash"]));

      // 7. Bank — ledger "Bank" accounts + standalone bank accounts (no linked ledger)
      const ledgerBankBalance = atLeastZero(sumNB(["Bank"]));

      // Anything but "Dr" (the default side) counts as a credit opening.
      const standaloneBankOpeningBalance = sumMoney(
        standaloneBankAccounts.map((account) =>
          (account.openingBalanceSide || "Dr") === "Dr"
            ? toMoney(account.openingBalance)
            : toMoney(account.openingBalance).negated()
        )
      );
      const standaloneBankVoucherBalance = debitMinusCredit(standaloneBankAccountEntries);
      const bankBalance = ledgerBankBalance.plus(standaloneBankOpeningBalance).plus(standaloneBankVoucherBalance);

      // 8. Import Charges (directExpenseBalance) — accounts under IMPORT_CHARGES parent
      // Uses already-loaded companyAccounts + accountBalances map (no extra DB query)
      const importChargesParentAcc = companyAccounts.find((a) => a.code === "IMPORT_CHARGES");
      let directExpenseBalance = ZERO;
      if (importChargesParentAcc) {
        const importChargeIds = new Set([
          importChargesParentAcc.id,
          ...companyAccounts.filter((a) => a.parentId === importChargesParentAcc.id).map((a) => a.id),
        ]);
        for (const acc of companyAccounts) {
          if (importChargeIds.has(acc.id)) {
            directExpenseBalance = directExpenseBalance.plus(atLeastZero(nb(acc)));
          }
        }
      }

      // 9. Indirect Expense
      const indirectExpenseBalance = atLeastZero(sumNB(["Indirect Expense"]));

      // 10. Income (credit balance = liability / revenue received). Every income
      // account by the shared classifier: Income, Revenue and Indirect Income in
      // either storage form (an "Indirect Income"-typed account used to be left out).
      const incomeBalance = atLeastZero(
        sumMoney(
          companyAccounts.filter((a) => classifyAccountType(a.accountType, a.subType) === "income").map(nb)
        ).negated()
      );

      // 11. Stock Value on Floor (inventory in locations)
      // Only include inventory at valid, non-deleted locations (excludes orphaned inventory)
      // Calculate from quantity * averageRate to ensure accuracy (totalValue can get out of sync)
      // NOTE: Exclude the value impact of Mixed vouchers since their production/consumption net to 0
      // The remaining component reads are independent and individually short.
      // Run them as one bounded batch (six leases against a 15-connection app
      // pool) to remove the long sequential tail without recreating pool pressure.
      const [inventoryItems, cogsData, adjustmentData, advancesData, employeesData, stockItemsWithOpening] =
        await Promise.all([
          db
            .select({
              quantity: inventory.quantity,
              averageRate: inventory.averageRate,
            })
            .from(inventory)
            .innerJoin(locations, eq(inventory.locationId, locations.id))
            .where(and(eq(inventory.companyId, companyId), isNull(locations.deletedAt))),
          db
            .select({
              totalCost: salesItems.totalCost,
            })
            .from(salesItems)
            .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
            .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false))),
          db
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
                sql`LOWER(${stockAdjustmentVouchers.adjustmentType}) IN ('consumption', 'production', 'mixed')`
              )
            ),
          db
            .select({
              remainingBalance: salaryAdvances.remainingBalance,
            })
            .from(salaryAdvances)
            .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false))),
          db
            .select({
              currentBalance: employees.currentBalance,
              openingBalance: employees.openingBalance,
            })
            .from(employees)
            .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt))),
          db
            .select({
              openingValue: stockItems.openingValue,
            })
            .from(stockItems)
            .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt))),
        ]);

      const stockOnFloorValue = sumMoney(
        inventoryItems.map((item) => toMoney(item.quantity).times(toMoney(item.averageRate)))
      );

      // 12. Cost of Goods Sold (calculated from salesItems for non-optional, non-deleted sales vouchers)
      // This represents inventory that was sold and is now an expense
      const cogsBalance = sumMoney(cogsData.map((item) => item.totalCost));

      // 12b. Consumption expense (from stock adjustment items)
      // Includes: pure Consumption vouchers AND Mixed voucher items with negative quantity
      // This represents inventory that was consumed (not sold) and is now an expense
      const consumptionBalance = sumMoney(
        adjustmentData.map((item) => {
          const qty = toMoney(item.quantity);
          const adjustmentType = (item.adjustmentType || "").toLowerCase();
          // Pure Consumption: always count (totalAmount is positive, represents consumed value)
          // Mixed: only count items with negative quantity (consumption items)
          if (adjustmentType === "consumption" || (adjustmentType === "mixed" && qty.lessThan(0))) {
            return toMoney(item.totalAmount).abs();
          }
          return ZERO;
        })
      );

      // 12c. Production balance (from stock adjustment items)
      // Includes: pure Production vouchers AND Mixed voucher items with positive quantity
      // Production INCREASES inventory (stockOnFloorValue goes up)
      const productionBalance = sumMoney(
        adjustmentData.map((item) => {
          const qty = toMoney(item.quantity);
          const adjustmentType = (item.adjustmentType || "").toLowerCase();
          // Pure Production: always count (totalAmount is positive, represents produced value)
          // Mixed: only count items with positive quantity (production items)
          if (adjustmentType === "production" || (adjustmentType === "mixed" && qty.greaterThan(0))) {
            return toMoney(item.totalAmount);
          }
          return ZERO;
        })
      );

      // 13. Payroll Expenses (Expense accounts named salary / payroll / wage)
      const payrollExpenseBalance = sumMoney(
        companyAccounts
          .filter((a) => a.accountType === "Expense" && /salary|payroll|wage/i.test(a.name || ""))
          .map((a) => atLeastZero(nb(a)))
      );

      // 14. Salary Advances - outstanding advances given to employees (asset - recoverable)
      const salaryAdvancesBalance = sumMoney(advancesData.map((advance) => advance.remainingBalance));

      // 15. Payroll Liabilities - wages owed to employees (from employees.currentBalance)
      // Positive currentBalance means company owes the employee (liability)
      // Only count positive balances (amounts owed to employees)
      const payrollLiabilitiesBalance = sumMoney(
        employeesData.map((emp) => toMoney(emp.currentBalance)).filter((balance) => balance.greaterThan(0))
      );

      // 16. Asset accounts (properties, guarantees, receivables — debit side)
      const assetBalance = atLeastZero(sumNB(["Asset", "Current Asset"]));

      // 17. General Expense (Purchases — excluded from formula to avoid double-counting stockOnFloor)
      const generalExpenseBalance = atLeastZero(sumNB(["Expense"]));

      // 18. Government Taxes
      const governmentTaxesBalance = atLeastZero(sumNB(["Government Taxes"]));

      // 19. Liability accounts
      const liabilityBalance = atLeastZero(sumNB(["Liability"]).negated());

      // 20. Profit / Retained Earnings (credit balance = liability)
      const profitBalance = atLeastZero(sumNB(["Profit"]).negated());

      // 20a. Equity — transactions only (opening balances are already counted in openingBalanceEquity)
      const equityTransactionBalance = (() => {
        let total = ZERO;
        for (const acc of companyAccounts) {
          if (acc.accountType !== "Equity") continue;
          const bal = accountBalances.get(acc.id);
          if (bal) total = total.plus(bal.credit).minus(bal.debit);
        }
        return atLeastZero(total);
      })();

      // 20b. Accounts Payable — transactions only
      const apTransactionBalance = (() => {
        let total = ZERO;
        for (const acc of companyAccounts) {
          if (acc.accountType !== "Accounts Payable") continue;
          const bal = accountBalances.get(acc.id);
          if (bal) total = total.plus(bal.credit).minus(bal.debit);
        }
        return atLeastZero(total);
      })();

      // 21. Opening Balance Equity - automatically balance opening entries
      // When opening balances are added without matching entries (e.g., cash opening balance without
      // corresponding capital), this creates an imbalance. We calculate the net of all opening balances
      // and treat the difference as implicit equity/capital that should be on the liability side.
      // Calculate net opening balance equity using already-loaded companyAccounts
      let totalDrOpenings = ZERO;
      let totalCrOpenings = ZERO;

      for (const account of companyAccounts) {
        const openingBalanceRaw = toMoney(account.openingBalance);
        if (openingBalanceRaw.isZero()) continue;

        const openingSide = account.openingBalanceSide || "Dr";
        if (openingSide === "Dr") {
          totalDrOpenings = totalDrOpenings.plus(openingBalanceRaw);
        } else {
          totalCrOpenings = totalCrOpenings.plus(openingBalanceRaw);
        }
      }

      // Include employee opening balances in the equity offset calculation
      // Employee opening balances are liabilities (money owed to employees) - credit side
      const totalEmployeeOpeningBalance = sumMoney(employeesData.map((emp) => emp.openingBalance));

      // Add employee opening balances to the credit side (they're liabilities)
      totalCrOpenings = totalCrOpenings.plus(totalEmployeeOpeningBalance);

      // Opening Balance Equity = Credit side opening balances minus debit side
      // This represents the net capital/equity that balances the opening entries
      // When added to the liability side, it offsets the asset-side opening balances
      let openingBalanceEquity = totalCrOpenings.minus(totalDrOpenings);
      // Note: If openingBalanceEquity is negative, it means more assets than liabilities
      // were brought forward - this is normal (represents owner's equity)

      // 22. Opening Stock Equity - stock items with opening values that weren't imported via PO
      // These are set via "Import Opening Balances" in Stock Items and need implicit equity offset
      const openingStockValue = sumMoney(stockItemsWithOpening.map((item) => item.openingValue));

      // Add opening stock value to the equity offset (it's an asset that needs balancing)
      // This is subtracted from the liability side calculation (negative equity offset)
      openingBalanceEquity = openingBalanceEquity.minus(openingStockValue);

      // Calculate the net balance:
      // Assets: Stock OTW + Cash + Bank + Stock on Floor + Asset accounts + Salary Advances
      // Operating Expenses: Indirect Expenses + Government Taxes + COGS (but NOT directExpenseBalance)
      // Liabilities + Income: Supplier Balance + Duty Agent + Transporter Agent + Loans + Liability accounts + Profit/Equity + Income + Payroll Liabilities
      // Net = (Assets + Operating Expenses) - (Liabilities + Income) (should be 0 when balanced)
      // NOTE: generalExpenseBalance (Purchases) is EXCLUDED because it double-counts with stockOnFloorValue
      //       When containers are offloaded, Purchases expense is debited AND Stock on Floor increases
      //       The inventory value already captures the cost of goods, so we don't add Purchases again
      // NOTE: directExpenseBalance (IMPORT_CHARGES like duties, transport) is EXCLUDED because:
      //       - These costs are capitalized into inventory value (stockOnFloorValue) during container offload
      //       - When offloading, the system: DR Duty Agent/Transporter Agent (creates liability)
      //         and those costs get added to inventory value via additionalCostPerBale
      //       - So stockOnFloorValue already includes these costs - adding directExpenseBalance would double-count
      //       - Office charges stored as Loans are also capitalized into inventory via additionalCostPerBale
      // NOTE: COGS from salesItems balances the inventory reduction when goods are sold
      // NOTE: Production and Consumption are EXCLUDED from the balance formula because:
      //       - Their effects are already reflected in stockOnFloorValue (inventory movements)
      //       - Production adds to inventory, Consumption removes from inventory
      //       - These movements are tracked in stockOnFloorValue via the inventory table
      //       - consumptionBalance/productionBalance are for diagnostic display only
      // Calculate precise discrepancy trace
      // Matches the exact formula used for netImportCycleBalance:
      // Assets + Expenses - (Liabilities - OpeningBalanceEquity) = Net
      const traceAssetTotal = sumMoney([
        stockOtwValue, // Asset (debit) - containers in transit
        cashBalance, // Asset (debit) - cash on hand
        bankBalance, // Asset (debit) - bank balances
        stockOnFloorValue, // Asset - inventory at cost (includes ALL offload charges capitalized)
        assetBalance, // Asset accounts (properties, guarantees, receivables)
        salaryAdvancesBalance, // Salary Advances (asset) - recoverable from employees
      ]);
      // directExpenseBalance is EXCLUDED - already capitalized into stockOnFloorValue
      const traceExpenseTotal = sumMoney([
        indirectExpenseBalance, // Expense (debit) - operating expenses (includes PAYROLL_DEPOSIT_EXPENSE)
        payrollExpenseBalance, // Payroll/Salary expenses (Expense type) - worker salaries in import cycle
        governmentTaxesBalance, // Government Taxes (expense)
        cogsBalance, // COGS expense (debit) - balances inventory reduction on sales
      ]);
      // liabilitiesBeforeEquity is the raw sum, then we subtract openingBalanceEquity
      const traceLiabilitiesRaw = sumMoney([
        supplierBalance, // Liability (what we owe to suppliers)
        dutyAgentBalance, // Liability (what we owe to duty agents)
        transporterAgentBalance, // Liability (what we owe to transporters)
        loansBalance, // Liability (loans/borrowings - includes office charges)
        liabilityBalance, // Other Liability accounts
        profitBalance, // Profit/Equity (retained earnings)
        equityTransactionBalance, // Equity account transactions (capital injections, etc.)
        apTransactionBalance, // Accounts Payable transactions
        incomeBalance, // Income (sales revenue - credit)
        payrollLiabilitiesBalance, // Payroll Liabilities (what we owe employees)
      ]);
      // Opening Balance Equity (implicit capital from opening balances)
      const traceNetLiabilities = traceLiabilitiesRaw.minus(openingBalanceEquity);
      const netImportCycleBalance = traceAssetTotal.plus(traceExpenseTotal).minus(traceNetLiabilities);

      // The difference is reported, never plugged. This endpoint used to upsert
      // system_settings.equity_adjustment_<companyId> = -net on every read and then
      // report 0, which hid real ledger/sub-ledger differences (2026-10 accounting
      // audit). A read must not write, and an unexplained difference must stay
      // visible until it is investigated and corrected with a posted entry.
      const storedEquityAdjustment = new MoneyDecimal(0);
      const adjustedImportCycleBalance = netImportCycleBalance;

      // Round to the cent, halves toward +infinity as Math.round did.
      // T006: Threshold reduced from $5 to $0.01 — the $5 threshold was hiding real imbalances.
      // With T001/T002 preventing bad postings, accumulated errors should stay below $0.01.
      const ROUNDING_THRESHOLD = 0.01;
      let roundedBalance = adjustedImportCycleBalance.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_CEIL).toNumber();
      if (Math.abs(roundedBalance) <= ROUNDING_THRESHOLD) {
        roundedBalance = 0;
      }

      // Create precision trace showing exact calculation
      const precisionTrace = {
        formula: "(Assets + Expenses) - (Liabilities - Opening Equity) = Net Balance",
        calculation: {
          assetTotal: {
            value: traceAssetTotal.toNumber(),
            breakdown: {
              stockOtwValue: stockOtwValue.toNumber(),
              cashBalance: cashBalance.toNumber(),
              bankBalance: bankBalance.toNumber(),
              stockOnFloorValue: stockOnFloorValue.toNumber(),
              assetBalance: assetBalance.toNumber(),
              salaryAdvancesBalance: salaryAdvancesBalance.toNumber(),
            },
          },
          expenseTotal: {
            value: traceExpenseTotal.toNumber(),
            breakdown: {
              indirectExpenseBalance: indirectExpenseBalance.toNumber(),
              payrollExpenseBalance: payrollExpenseBalance.toNumber(),
              governmentTaxesBalance: governmentTaxesBalance.toNumber(),
              cogsBalance: cogsBalance.toNumber(),
            },
          },
          liabilityTotal: {
            value: traceNetLiabilities.toNumber(),
            breakdown: {
              supplierBalance: supplierBalance.toNumber(),
              dutyAgentBalance: dutyAgentBalance.toNumber(),
              transporterAgentBalance: transporterAgentBalance.toNumber(),
              loansBalance: loansBalance.toNumber(),
              liabilityBalance: liabilityBalance.toNumber(),
              profitBalance: profitBalance.toNumber(),
              equityTransactionBalance: equityTransactionBalance.toNumber(),
              apTransactionBalance: apTransactionBalance.toNumber(),
              incomeBalance: incomeBalance.toNumber(),
              payrollLiabilitiesBalance: payrollLiabilitiesBalance.toNumber(),
              openingBalanceEquityOffset: openingBalanceEquity.toNumber(), // positive value that reduces liabilities
            },
          },
        },
        rawNetBalance: netImportCycleBalance.toNumber(),
        storedEquityAdjustment: storedEquityAdjustment.toNumber(),
        adjustedBalance: adjustedImportCycleBalance.toNumber(),
        finalRoundedBalance: roundedBalance,
        discrepancyExplanation: netImportCycleBalance.abs().greaterThan(0.01)
          ? `Unreconciled difference of ${netImportCycleBalance.toFixed(2)} between ledger and sub-ledger figures. It is not plugged; investigate it with the accounting integrity diagnostic.`
          : null,
      };

      const _result = {
        netImportCycleBalance: roundedBalance,
        components: {
          supplierBalance: supplierBalance.toNumber(),
          stockOtwValue: stockOtwValue.toNumber(),
          dutyAgentBalance: dutyAgentBalance.toNumber(),
          transporterAgentBalance: transporterAgentBalance.toNumber(),
          loansBalance: loansBalance.toNumber(),
          cashBalance: cashBalance.toNumber(),
          bankBalance: bankBalance.toNumber(),
          assetBalance: assetBalance.toNumber(),
          directExpenseBalance: directExpenseBalance.toNumber(),
          indirectExpenseBalance: indirectExpenseBalance.toNumber(),
          generalExpenseBalance: generalExpenseBalance.toNumber(),
          governmentTaxesBalance: governmentTaxesBalance.toNumber(),
          incomeBalance: incomeBalance.toNumber(),
          liabilityBalance: liabilityBalance.toNumber(),
          profitBalance: profitBalance.toNumber(),
          equityTransactionBalance: equityTransactionBalance.toNumber(),
          apTransactionBalance: apTransactionBalance.toNumber(),
          stockOnFloorValue: stockOnFloorValue.toNumber(),
          cogsBalance: cogsBalance.toNumber(),
          consumptionBalance: consumptionBalance.toNumber(),
          productionBalance: productionBalance.toNumber(),
          payrollExpenseBalance: payrollExpenseBalance.toNumber(),
          salaryAdvancesBalance: salaryAdvancesBalance.toNumber(),
          payrollLiabilitiesBalance: payrollLiabilitiesBalance.toNumber(),
          openingBalanceEquity: openingBalanceEquity.toNumber(),
          openingStockValue: openingStockValue.toNumber(),
        },
        precisionTrace,
      };
      _setCached(_cacheKey, _result);
      res.json(_result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
