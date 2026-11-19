import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { containers } from "@shared/schema";
import { eq, and, or, sql, lte } from "drizzle-orm";
import { getAccountNetBalance, type NetPositionAccount } from "../../netPositionHelper";

import { _setCached } from "../../services/shared/ttlCache";
import { computeRentalOutstanding } from "./netProfitRentalSection";
import { computeStockInHand } from "./netProfitStockSection";
import { type NetPositionPartyLine } from "../../services/accounting/balances/netPositionParties";
import { getSupplierPartnerPosProfit } from "./realizedProfit";
import {
  classifyAccountType,
  expenseCategory,
  isIndirectIncome,
} from "../../services/accounting/accountClassification";
import { minusMoney, plusMoney, sumMoney, toMoney } from "../../lib/money";
import { statsNetProfitRoutesStep } from "./statsNetProfitRoutesStep";

export function registerStatsNetProfitRoutes(app: Express) {
  app.get("/api/stats/net-profit", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const snp1 = await statsNetProfitRoutesStep({ req, res });
      if (snp1.done) return snp1.value;
      const {
        companyAccounts,
        profitAndLossBalances,
        categoryTotals,
        incomeAccounts,
        excludedFromExpenses,
        expensesAccounts,
        ledgerStock,
        forUsAccounts,
        companyId,
        toDate,
        round2,
        onUsAccounts,
        parties,
        companyRecord,
        currentCfaRate,
        businessToday,
        equityIncludedInNetPosition,
        equity,
        companySettings,
        accountBalances,
        netPositionCurrency,
        _cacheKey,
      } = snp1;

      for (const acc of companyAccounts) {
        // The P&L pass leaves the fiscal closing journals out (wave 17 A), so a
        // closed year's income and expenses are still reported here.
        const netBalance = getAccountNetBalance(acc, profitAndLossBalances);
        // Expense accounts are stored in two legacy-compatible forms:
        //   accountType = "Indirect Expense" / "Direct Expense"
        //   accountType = "Expense" + subType = "Indirect Expense" / "Direct Expense"
        // expenseCategory normalizes both forms so every report classifies the same account the same way.
        const normalizedExpenseType = expenseCategory(acc.accountType, acc.subType);
        const isIncomeAccount = classifyAccountType(acc.accountType, acc.subType) === "income";

        if (isIncomeAccount) {
          const indirect = isIndirectIncome(acc.accountType, acc.subType);
          const incomeKey = indirect ? "income_Indirect Income" : "income_Sales/Revenue";
          const incomeCategory = indirect ? "Indirect Income" : "Income";
          if (netBalance < 0) {
            snp1.incomeTotal = plusMoney(snp1.incomeTotal, Math.abs(netBalance));
            categoryTotals[incomeKey] = plusMoney(categoryTotals[incomeKey] || 0, Math.abs(netBalance));
            incomeAccounts.push({
              id: acc.id,
              name: acc.name,
              code: acc.code || "",
              value: Math.abs(netBalance),
              category: incomeCategory,
            });
          } else if (netBalance > 0) {
            snp1.incomeTotal = minusMoney(snp1.incomeTotal, netBalance);
            categoryTotals[incomeKey] = minusMoney(categoryTotals[incomeKey] || 0, netBalance);
            incomeAccounts.push({
              id: acc.id,
              name: acc.name,
              code: acc.code || "",
              value: -netBalance,
              category: `${incomeCategory} (Refund)`,
            });
          }
        } else if (normalizedExpenseType && !excludedFromExpenses.has(acc.id)) {
          const category = normalizedExpenseType;
          if (netBalance > 0) {
            snp1.expensesTotal = plusMoney(snp1.expensesTotal, netBalance);
            categoryTotals[`exp_${category}`] = plusMoney(categoryTotals[`exp_${category}`] || 0, netBalance);
            expensesAccounts.push({ id: acc.id, name: acc.name, code: acc.code || "", value: netBalance, category });
          } else if (netBalance < 0) {
            const credit = Math.abs(netBalance);
            snp1.expensesTotal = minusMoney(snp1.expensesTotal, credit);
            categoryTotals[`exp_${category}`] = minusMoney(categoryTotals[`exp_${category}`] || 0, credit);
            expensesAccounts.push({
              id: acc.id,
              name: acc.name,
              code: acc.code || "",
              value: -credit,
              category: category + " (Refund)",
            });
          }
        }
      }

      // Breakdown arrays — populated from categoryTotals after all extra sources are added below
      const forUsBreakdown: { name: string; value: number }[] = [];
      const onUsBreakdown: { name: string; value: number }[] = [];
      const expensesBreakdown: { name: string; value: number }[] = [];
      const incomeBreakdown: { name: string; value: number }[] = [];

      // ── ERP mode: always strip factory-specific ledger accounts (if any exist)
      // and compute Stock In Hand from location inventory.
      // Factory-specific bale/raw-material calculations belong exclusively in
      // /api/factory/net-position — this endpoint is ERP-only.
      const factoryLedgerCodesToStrip = new Set(["FACTORY_RAW_MATERIAL_STOCK", "FACTORY_STOCK_IN_HAND"]);
      const factoryLedgerNamesToStrip = ["factory raw material stock", "factory stock in hand"];
      if (!ledgerStock) {
        let i = forUsAccounts.length - 1;
        while (i >= 0) {
          const acc = forUsAccounts[i];
          const code = (acc.code || "").toUpperCase();
          const nameLower = (acc.name || "").toLowerCase();
          if (factoryLedgerCodesToStrip.has(code) || factoryLedgerNamesToStrip.some((p) => nameLower.includes(p))) {
            snp1.forUsTotal = minusMoney(snp1.forUsTotal, acc.value);
            const catKey = `asset_${acc.category || acc.name}`;
            if (categoryTotals[catKey] !== undefined) delete categoryTotals[catKey];
            forUsAccounts.splice(i, 1);
          }
          i--;
        }
      }

      // ERP Stock In Hand - location inventory at weighted-average cost,
      // computed in ./netProfitStockSection.
      const stockOnFloor = ledgerStock ? 0 : await computeStockInHand(companyId, toDate);
      if (stockOnFloor > 0) {
        snp1.forUsTotal = plusMoney(snp1.forUsTotal, stockOnFloor);
        categoryTotals["asset_Stock In Hand"] = stockOnFloor;
        forUsAccounts.push({
          name: "Stock In Hand (Inventory)",
          code: "COMPUTED",
          value: stockOnFloor,
          category: "Inventory",
        });
      }

      // ERP payroll has two distinct people domains in the same employees table:
      // employeeType=Employee uses the employee subledger for salary accrual/payable,
      // while employeeType=Worker is paid directly and uses the salary-advance workflow.
      // A generic Payroll Payable ledger can be legacy/duplicate, so strip it from the
      // classifier and inject the authoritative employee-subledger result exactly once.
      const isPayrollPayableAccount = (acc: { name?: string | null; code?: string | null }) => {
        const name = (acc.name || "").trim().toLowerCase().replace(/\s+/g, " ");
        const code = (acc.code || "").trim().toUpperCase();
        return name === "payroll payable" || code === "PAYROLL_PAYABLE" || code === "PAY_PAYABLE";
      };

      const payrollLedgerAccounts = companyAccounts.filter(isPayrollPayableAccount);
      const payrollLedgerIds = new Set(payrollLedgerAccounts.map((acc) => acc.id));

      const stripPayrollEntries = (accounts: NetPositionAccount[], side: "asset" | "liability") => {
        for (let i = accounts.length - 1; i >= 0; i--) {
          const acc = accounts[i];
          if ((acc.id && payrollLedgerIds.has(acc.id)) || isPayrollPayableAccount(acc)) {
            const value = Number(acc.value || 0);
            if (side === "asset") snp1.forUsTotal = round2(minusMoney(snp1.forUsTotal, value));
            else snp1.onUsTotal = round2(minusMoney(snp1.onUsTotal, value));
            const catKey = `${side}_${acc.category || acc.name}`;
            if (categoryTotals[catKey] !== undefined) {
              categoryTotals[catKey] = round2(minusMoney(categoryTotals[catKey], value));
              if (Math.abs(categoryTotals[catKey]) < 0.01) delete categoryTotals[catKey];
            }
            accounts.splice(i, 1);
          }
        }
      };
      stripPayrollEntries(forUsAccounts, "asset");
      stripPayrollEntries(onUsAccounts, "liability");

      // Customers, suppliers, payroll (Employees, netted), workers and bank
      // accounts (category "Bank", like a Bank ledger account) from the
      // balance engine. The salary-advance table and employees.current_balance
      // are no longer the figures: what they add over the ledger is reported in
      // `notInLedger` (the advance-named ledger accounts the table used to
      // replace are ledger balances and stay in the classification).
      const partyCategoryKey = (line: NetPositionPartyLine, side: "asset" | "liability") => {
        if (line.partyKind === "supplier")
          return side === "asset" ? "asset_Supplier Overpayment" : "liability_Suppliers";
        return `${side}_${line.category}`;
      };
      for (const [lines, side] of [
        [parties.forUs, "asset"],
        [parties.onUs, "liability"],
      ] as const) {
        for (const line of lines) {
          const key = partyCategoryKey(line, side);
          categoryTotals[key] = round2(plusMoney(categoryTotals[key] || 0, line.value));
          (side === "asset" ? forUsAccounts : onUsAccounts).push({
            ...(line.id !== undefined ? { id: line.id } : {}),
            ...(line.bankAccountId !== undefined ? { bankAccountId: line.bankAccountId } : {}),
            // The owner identity of the party row. The current-rate monetary
            // translation replaces customer rows by customer:id; without it a
            // customer could only be found by its linked ledger id, which the
            // valuation deliberately never keys (it belongs to the customer).
            partyKind: line.partyKind,
            partyId: line.partyId,
            name: line.name,
            code: line.code,
            value: line.value,
            category: line.category,
          });
        }
      }
      snp1.forUsTotal = round2(plusMoney(snp1.forUsTotal, parties.forUsTotal));
      snp1.onUsTotal = round2(plusMoney(snp1.onUsTotal, parties.onUsTotal));

      // Stock OTW — historical as of toDate (containers that were in transit on that date).
      // SP (supplier_partner) companies track OTW via the sp_goods_otw ledger account instead
      // of the containers table, so skip the container-based calculation to avoid double-counting.
      const isSpCompany = companyRecord?.companyType === "supplier_partner";
      // From the cut-over, Goods in Transit in the ledger carries the containers on the way.
      if (!isSpCompany && !ledgerStock) {
        // Rule: a container was OTW as of toDate if it was imported by then AND either
        //   (a) it is still OTW (never formally offloaded via the offload workflow), OR
        //   (b) it was formally offloaded AFTER toDate (so it was still in transit as of toDate).
        // A manually-entered tracking offloadDate does NOT indicate a formal offload — only
        // status='OFFLOADED' (set by the offload workflow) is authoritative. This keeps the
        // date-filtered result consistent with the no-filter query (status = 'OTW').
        const otwContainersQuery = toDate
          ? and(
              eq(containers.companyId, companyId),
              lte(containers.importDate, toDate),
              or(
                eq(containers.status, "OTW"),
                and(eq(containers.status, "OFFLOADED"), sql`${containers.offloadDate} > ${toDate}`)
              )
            )
          : and(eq(containers.companyId, companyId), eq(containers.status, "OTW"));
        // Select only the columns needed for OTW value calculation — avoids schema-mismatch
        // 500s when new columns (e.g. locked_rate, fx_rate_confirmed) are in the Drizzle
        // schema but haven't been migrated to production yet.
        const otwContainers = await db
          .select({
            grandTotal: containers.grandTotal,
            itemsTotal: containers.itemsTotal,
          })
          .from(containers)
          .where(otwContainersQuery)
          .execute();

        // A zero grandTotal (the DB default) falls through to itemsTotal.
        const stockOtwValue = sumMoney(
          otwContainers.map((container) => {
            const gTotal = toMoney(container.grandTotal);
            return gTotal.isZero() ? toMoney(container.itemsTotal) : gTotal;
          })
        ).toNumber();

        if (stockOtwValue > 0) {
          snp1.forUsTotal = plusMoney(snp1.forUsTotal, stockOtwValue);
          categoryTotals["asset_Stock OTW"] = stockOtwValue;
          forUsAccounts.push({
            name: "Stock On The Way",
            code: "STOCK_OTW",
            value: stockOtwValue,
            category: "Stock OTW",
          });
        }
      }

      // Rental Outstanding (Tenant Receivables) is computed in
      // ./netProfitRentalSection, which returns the two figures rather than
      // reaching into these accumulators.
      const rental = await computeRentalOutstanding(companyId, toDate, currentCfaRate, businessToday);
      if (rental.prepaidRent > 0.005) {
        const val = rental.prepaidRent;
        snp1.forUsTotal = round2(plusMoney(snp1.forUsTotal, val));
        categoryTotals["asset_Prepaid Rent"] = plusMoney(categoryTotals["asset_Prepaid Rent"] || 0, val);
        forUsAccounts.push({ name: "Prepaid Rent", code: "PREPAID_RENT", value: val, category: "Prepaid Rent" });
      }
      if (rental.rentPayable > 0.005) {
        const val = rental.rentPayable;
        snp1.onUsTotal = round2(plusMoney(snp1.onUsTotal, val));
        categoryTotals["liability_Rent Payable"] = plusMoney(categoryTotals["liability_Rent Payable"] || 0, val);
        onUsAccounts.push({ name: "Rent Payable", code: "RENT_PAYABLE", value: val, category: "Rent Payable" });
      }

      // Build breakdowns from category totals (with rounding)
      for (const [key, value] of Object.entries(categoryTotals)) {
        if (value === 0) continue;
        const roundedValue = round2(value);

        if (key.startsWith("asset_")) {
          forUsBreakdown.push({ name: key.replace("asset_", ""), value: roundedValue });
        } else if (key.startsWith("liability_")) {
          onUsBreakdown.push({ name: key.replace("liability_", ""), value: roundedValue });
        } else if (key.startsWith("exp_")) {
          expensesBreakdown.push({ name: key.replace("exp_", ""), value: roundedValue });
        } else if (key.startsWith("income_")) {
          incomeBreakdown.push({ name: key.replace("income_", ""), value: roundedValue });
        }
      }

      // Round individual account values
      forUsAccounts.forEach((acc) => (acc.value = round2(acc.value)));
      onUsAccounts.forEach((acc) => (acc.value = round2(acc.value)));
      expensesAccounts.forEach((acc) => (acc.value = round2(acc.value)));
      incomeAccounts.forEach((acc) => (acc.value = round2(acc.value)));

      // Sort breakdowns by value (highest first)
      forUsBreakdown.sort((a, b) => b.value - a.value);
      onUsBreakdown.sort((a, b) => b.value - a.value);
      expensesBreakdown.sort((a, b) => b.value - a.value);
      incomeBreakdown.sort((a, b) => b.value - a.value);

      // Sort individual account arrays by value (highest first)
      forUsAccounts.sort((a, b) => b.value - a.value);
      onUsAccounts.sort((a, b) => b.value - a.value);
      expensesAccounts.sort((a, b) => b.value - a.value);
      incomeAccounts.sort((a, b) => b.value - a.value);

      // ============ FINAL CALCULATIONS ============

      // Round all totals to prevent floating point noise
      snp1.forUsTotal = round2(snp1.forUsTotal);
      snp1.onUsTotal = round2(snp1.onUsTotal);
      snp1.incomeTotal = round2(snp1.incomeTotal);
      snp1.expensesTotal = round2(snp1.expensesTotal);

      // ── Merge stock accounts into one combined Inventory line ────────────────
      // "Stock In Hand (Inventory)" (computed from inventory table) and ledger
      // accounts like "Stock on Floor" (accountType: Asset) represent the same
      // physical stock and should appear as a single line in the breakdown.
      {
        const isStockEntry = (a: NetPositionAccount) => {
          const nl = (a.name || "").toLowerCase();
          const cat = (a.category || "").toLowerCase();
          return cat === "inventory" || nl.includes("stock in hand") || nl.includes("stock on floor");
        };
        const stockEntries = forUsAccounts.filter(isStockEntry);
        if (stockEntries.length > 1) {
          const combined = round2(stockEntries.reduce((s: number, a) => plusMoney(s, a.value), 0));
          for (let i = forUsAccounts.length - 1; i >= 0; i--) {
            if (isStockEntry(forUsAccounts[i])) forUsAccounts.splice(i, 1);
          }
          if (combined > 0) {
            forUsAccounts.push({
              name: "Stock In Hand / Stock on Floor",
              code: "COMPUTED",
              value: combined,
              category: "Inventory",
            });
          }
        } else if (stockEntries.length === 1 && stockEntries[0].name !== "Stock In Hand / Stock on Floor") {
          stockEntries[0].name = "Stock In Hand / Stock on Floor";
        }
      }

      // Net Position remains Assets - Liabilities for regular companies.
      // Supplier-partner companies also include signed partner equity directly:
      // debit equity increases the position, while credit equity reduces it.
      const equityNetPositionContribution = equityIncludedInNetPosition ? equity.total : 0;
      const netPosition = round2(toMoney(snp1.forUsTotal).minus(snp1.onUsTotal).plus(equityNetPositionContribution));

      const netPositionLabel = netPosition >= 0 ? "We have more than we owe" : "We owe more than we have";

      // SP companies: calculate realized POS profit from salesItems.profit
      // (source of truth: totalSales − totalCost per line, stored at sale time).
      // This is displayed as an informational P&L section — it is NOT added to
      // forUsTotal because the balance-sheet entries (Dr Cash, Dr clearing,
      // Cr Payable) already mathematically reflect the profit in the net position.
      // Adding it again would double-count.
      let spPosProfit = 0;
      const spPosProfitBaselineDate =
        isSpCompany && companySettings?.spPosProfitBaselineDate ? companySettings.spPosProfitBaselineDate : null;
      // The tile is a month-to-date measure, never an accumulated balance.
      // Selecting an historical as-of date shows that month's profit without
      // deleting or rewriting any earlier sales or accounting records.
      const spPosProfitAsOfDate = toDate || businessToday;
      const monthStart = `${spPosProfitAsOfDate.slice(0, 7)}-01`;
      const spPosProfitPeriodStartDate =
        spPosProfitBaselineDate && spPosProfitBaselineDate > monthStart ? spPosProfitBaselineDate : monthStart;
      if (isSpCompany) {
        spPosProfit = round2(
          await getSupplierPartnerPosProfit(companyId, spPosProfitPeriodStartDate, spPosProfitAsOfDate)
        );
      }

      // Owner's Capital for backward compatibility
      const profitAccounts = companyAccounts.filter((acc) => acc.accountType === "Profit");
      let ownersCapital = 0;
      for (const acc of profitAccounts) {
        const opening = toMoney(acc.openingBalance);
        const balance = accountBalances.get(acc.id) || { debit: 0, credit: 0 };
        ownersCapital = plusMoney(ownersCapital, opening.plus(balance.credit).minus(balance.debit));
      }

      // Net Worth and Profit for backward compatibility
      const netWorth = netPosition;
      const netProfit = round2(minusMoney(snp1.incomeTotal, snp1.expensesTotal));

      // Breakdown for display
      const netPositionBreakdown = {
        assets: {
          total: snp1.forUsTotal,
          breakdown: forUsBreakdown,
        },
        liabilities: {
          total: snp1.onUsTotal,
          breakdown: onUsBreakdown,
        },
        income: {
          total: snp1.incomeTotal,
          breakdown: incomeBreakdown,
        },
        expenses: {
          total: snp1.expensesTotal,
          breakdown: expensesBreakdown,
        },
        equity: {
          total: equity.total,
          accounts: equity.accounts,
          includedInNetPosition: equityIncludedInNetPosition,
        },
        netPosition,
      };

      const _result = {
        totalIncome: snp1.incomeTotal,
        totalExpenses: snp1.expensesTotal,
        netProfit,
        spPosProfit,
        ...(isSpCompany ? { spPosProfitPeriodStartDate, spPosProfitAsOfDate } : {}),
        ...(spPosProfitBaselineDate ? { spPosProfitBaselineDate } : {}),
        forUs: {
          total: snp1.forUsTotal,
          breakdown: forUsBreakdown,
          accounts: forUsAccounts,
        },
        onUs: {
          total: snp1.onUsTotal,
          breakdown: onUsBreakdown,
          accounts: onUsAccounts,
        },
        income: {
          total: snp1.incomeTotal,
          breakdown: incomeBreakdown,
          accounts: incomeAccounts,
        },
        expenses: {
          total: snp1.expensesTotal,
          breakdown: expensesBreakdown,
          accounts: expensesAccounts,
        },
        equity: {
          ...equity,
          includedInNetPosition: equityIncludedInNetPosition,
        },
        ownersCapital,
        netWorth,
        netPosition,
        netPositionLabel,
        netPositionBreakdown,
        forUsTotal: snp1.forUsTotal,
        onUsTotal: snp1.onUsTotal,
        incomeTotal: snp1.incomeTotal,
        expensesTotal: snp1.expensesTotal,
        notInLedger: parties.notInLedger,
        currency: {
          ...netPositionCurrency,
          currentCashBankTranslationApplied: false,
          historicalValuesLocked: true,
        },
        currencyRevaluation: {
          reportTotalsProvisional: netPositionCurrency.totalsProvisional,
        },
      };
      if (toDate) _setCached(_cacheKey, _result);
      res.json(_result);
    } catch (error: unknown) {
      logger.error("[/api/stats/net-profit] Unhandled error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Net Position Excel Export
}
