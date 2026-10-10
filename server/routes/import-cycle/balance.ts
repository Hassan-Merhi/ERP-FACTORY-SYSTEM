/**
 * importCycleRoutes: ImportCycleBalance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { companyStockValue } from "../../services/inventory/stockValuation";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import {
  stockItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  containers,
  vouchers,
  salesItems,
  salaryAdvances,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { classifyAccountType, expenseCategory } from "../../services/accounting/accountClassification";
import { loadBalanceRows } from "../../services/accounting/balances/ledgerBalanceEngine";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";

import { _getCached, _setCached } from "./_helpers";

const LEDGER = "ledger";
const OPERATIONAL = "operational (memo)";
const MEMO_ONLY = "memo, not in the formula";
/** The basis of each import-cycle component (wave 17 A). */
export const IMPORT_CYCLE_COMPONENT_BASIS: Readonly<Record<string, string>> = {
  supplierBalance: LEDGER,
  stockOtwValue: OPERATIONAL,
  dutyAgentBalance: LEDGER,
  transporterAgentBalance: LEDGER,
  loansBalance: LEDGER,
  cashBalance: LEDGER,
  bankBalance: LEDGER,
  assetBalance: LEDGER,
  directExpenseBalance: `${LEDGER}; ${MEMO_ONLY}`,
  indirectExpenseBalance: LEDGER,
  generalExpenseBalance: `${LEDGER}; ${MEMO_ONLY}`,
  governmentTaxesBalance: LEDGER,
  incomeBalance: LEDGER,
  liabilityBalance: LEDGER,
  profitBalance: LEDGER,
  equityTransactionBalance: LEDGER,
  apTransactionBalance: LEDGER,
  stockOnFloorValue: OPERATIONAL,
  cogsBalance: OPERATIONAL,
  consumptionBalance: `${OPERATIONAL}; ${MEMO_ONLY}`,
  productionBalance: `${OPERATIONAL}; ${MEMO_ONLY}`,
  payrollExpenseBalance: LEDGER,
  salaryAdvancesBalance: `${OPERATIONAL}; ${MEMO_ONLY}`,
  payrollLiabilitiesBalance: LEDGER,
  openingBalanceEquity: LEDGER,
  openingStockValue: OPERATIONAL,
};

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

      // Every ledger figure comes from the balance engine (wave 17 A): this
      // company's live vouchers by COALESCE(effective_date, voucher_date), each
      // master's opening with its side (a sideless opening takes its type's
      // usual side), each line counted once by the engine's ownership rule.
      // Types are matched case-insensitively and in every stored spelling
      // ("Loan" and "Loans"; "Expense" + subType "Indirect Expense"), and no
      // figure is clamped at zero any more: a debit liability or a credit
      // asset lowers its component instead of disappearing. Before, the route
      // summed its own lines by voucher date, matched exact type names, clamped
      // most components at zero and read employees.current_balance.
      const [companyAccounts, engineRows] = await Promise.all([
        storage.getAllLedgerAccounts(companyId, true),
        loadBalanceRows(db, { companyId }),
      ]);
      const closingOf = (row: (typeof engineRows)[number]) =>
        row.masterOpening.plus(row.periodDebit).minus(row.periodCredit);
      const ledgerRowById = new Map(
        engineRows.filter((row) => row.kind === "ledger" && row.id !== null).map((row) => [row.id as number, row])
      );
      const rowsOfKind = (kind: (typeof engineRows)[number]["kind"]) => engineRows.filter((row) => row.kind === kind);

      // Ledger rows counted in a component; their openings are offset by the
      // opening-balance equity below.
      const countedRows = new Set<(typeof engineRows)[number]>();
      const ZERO = new MoneyDecimal(0);
      const typeOf = (acc: (typeof companyAccounts)[number]) => (acc.accountType ?? "").trim().toLowerCase();
      /** Debit-positive engine balance of the company's ledger accounts matching `match`. */
      const sumLedger = (match: (acc: (typeof companyAccounts)[number]) => boolean, count = true) => {
        let total = ZERO;
        for (const acc of companyAccounts) {
          if (!match(acc)) continue;
          const row = ledgerRowById.get(acc.id);
          if (!row) continue;
          if (count) countedRows.add(row);
          total = total.plus(closingOf(row));
        }
        return total;
      };
      const ofTypes =
        (...types: string[]) =>
        (acc: (typeof companyAccounts)[number]) =>
          types.includes(typeOf(acc));
      const sumRows = (kind: (typeof engineRows)[number]["kind"]) => {
        let total = ZERO;
        for (const row of rowsOfKind(kind)) {
          countedRows.add(row);
          total = total.plus(closingOf(row));
        }
        return total;
      };

      const otwContainers = await db
        .select()
        .from(containers)
        .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));

      // 1. Supplier Balance (Cr positive: what we owe): the engine's suppliers
      // of this company (wave 13 owner decision 2), netted, debit balances
      // lowering it.
      const supplierBalance = sumRows("supplier").negated();

      // Operational (memo basis): containers on the way, at their invoice totals.
      const stockOtwValue = sumMoney(
        otwContainers.map((container) => {
          const gTotal = toMoney(container.grandTotal);
          return gTotal.isZero() ? toMoney(container.itemsTotal) : gTotal;
        })
      );

      // 3-5. Duty Agent / Transporter Agent / Loans (Cr positive), every stored spelling.
      const dutyAgentBalance = sumLedger(ofTypes("duty agent")).negated();
      const transporterAgentBalance = sumLedger(ofTypes("transporter agent")).negated();
      const loansBalance = sumLedger(ofTypes("loan", "loans")).negated();

      // 6. Cash (Dr positive)
      const cashBalance = sumLedger(ofTypes("cash"));

      // 7. Bank: ledger Bank accounts plus every bank account master (its own
      // opening and the lines that name it and no ledger account, engine rule).
      const bankBalance = sumLedger(ofTypes("bank")).plus(sumRows("bank"));

      // 8. Import Charges (directExpenseBalance) — accounts under IMPORT_CHARGES parent
      // Engine balances of the already-loaded accounts (no extra DB query).
      const importChargesParentAcc = companyAccounts.find((a) => a.code === "IMPORT_CHARGES");
      let directExpenseBalance = ZERO;
      if (importChargesParentAcc) {
        const importChargeIds = new Set([
          importChargesParentAcc.id,
          ...companyAccounts.filter((a) => a.parentId === importChargesParentAcc.id).map((a) => a.id),
        ]);
        // Display only (excluded from the formula): not counted.
        directExpenseBalance = sumLedger((acc) => importChargeIds.has(acc.id), false);
      }

      // 9. Indirect Expense, both storage forms (type, or Expense + subType).
      const indirectExpenseBalance = sumLedger(
        (acc) => expenseCategory(acc.accountType, acc.subType) === "Indirect Expense"
      );

      // 10. Income (credit balance = liability / revenue received). Every income
      // account by the shared classifier: Income, Revenue and Indirect Income in
      // either storage form (an "Indirect Income"-typed account used to be left out).
      const incomeBalance = sumLedger(
        (acc) => classifyAccountType(acc.accountType, acc.subType) === "income"
      ).negated();

      // 11. Stock Value on Floor (inventory in locations)
      // Wave 11: the one stock valuation (stockValuation.ts): SUM(total_value) over
      // the company's non-deleted locations, bale mirror left out, negative stock
      // not subtracting. quantity × average_rate drifted from the stored value.
      // NOTE: Exclude the value impact of Mixed vouchers since their production/consumption net to 0
      // The remaining component reads are independent and individually short.
      // Run them as one bounded batch (six leases against a 15-connection app
      // pool) to remove the long sequential tail without recreating pool pressure.
      const [stockValue, cogsData, adjustmentData, advancesData, stockItemsWithOpening] = await Promise.all([
        companyStockValue(db, companyId),
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
            openingValue: stockItems.openingValue,
          })
          .from(stockItems)
          .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt))),
      ]);

      const stockOnFloorValue = toMoney(stockValue);

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

      // 13. Payroll Expenses: plain expense accounts named salary / payroll / wage.
      const isPayrollExpense = (acc: (typeof companyAccounts)[number]) =>
        expenseCategory(acc.accountType, acc.subType) === "Expense" && /salary|payroll|wage/i.test(acc.name || "");
      const payrollExpenseBalance = sumLedger(isPayrollExpense);

      // 14. Salary Advances (memo, not in the formula): the advances table's
      // remaining balance. Posted advances are already in the employees'
      // ledger balances (15), so adding the table again counted them twice.
      const salaryAdvancesBalance = sumMoney(advancesData.map((advance) => advance.remainingBalance));

      // 15. Payroll Liabilities (Cr positive): the engine's employees of this
      // company, netted (advances lower it). It was employees.current_balance,
      // a cache outside the ledger, positive balances only.
      const payrollLiabilitiesBalance = sumRows("employee").negated();

      // 16. Asset accounts (properties, guarantees, receivables — debit side)
      // and fixed-asset masters.
      const assetBalance = sumLedger(ofTypes("asset", "current asset", "fixed asset")).plus(sumRows("fixedAsset"));

      // 17. General Expense (plain Expense: Purchases etc.), display only —
      // excluded from the formula to avoid double-counting stockOnFloor.
      const generalExpenseBalance = sumLedger(
        (acc) => expenseCategory(acc.accountType, acc.subType) === "Expense",
        false
      );

      // 18. Government Taxes
      const governmentTaxesBalance = sumLedger(
        (acc) => expenseCategory(acc.accountType, acc.subType) === "Government Taxes"
      );

      // 19. Liability accounts (Cr positive)
      const liabilityBalance = sumLedger(ofTypes("liability", "current liability")).negated();

      // 20. Profit / Retained Earnings (Cr positive)
      const profitBalance = sumLedger(ofTypes("profit")).negated();

      // 20a. Equity and 20b. Accounts Payable (Cr positive). Their openings,
      // like every counted opening, are offset by the opening-balance equity
      // below, so each contributes its transactions as before.
      const equityTransactionBalance = sumLedger(ofTypes("equity")).negated();
      const apTransactionBalance = sumLedger(ofTypes("accounts payable")).negated();

      // 21. Opening Balance Equity (Cr positive): the implicit capital that
      // offsets the openings of every master counted above (ledger accounts,
      // banks, fixed assets, suppliers, employees), each with the engine's
      // side, so the formula compares movements, not openings. Before, it
      // summed every ledger opening with a sideless one taken as Dr, added
      // employee openings as Cr whatever their side, and left out the bank
      // and supplier openings the components counted.
      let openingBalanceEquity = ZERO;
      for (const row of countedRows) openingBalanceEquity = openingBalanceEquity.minus(row.masterOpening);

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
        assetBalance, // Asset accounts (properties, guarantees, receivables) and fixed assets
        // salaryAdvancesBalance is memo only: posted advances are in payrollLiabilitiesBalance.
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
        // Wave 17 A: where each component comes from. "ledger": the balance
        // engine; "operational (memo)": an operational table, not a ledger
        // balance; "memo, not in the formula": shown for information only.
        componentBasis: IMPORT_CYCLE_COMPONENT_BASIS,
        precisionTrace,
      };
      _setCached(_cacheKey, _result);
      res.json(_result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
