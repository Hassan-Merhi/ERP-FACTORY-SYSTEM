import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { containers, suppliers, employees, salaryAdvances, exchangeRates } from "@shared/schema";
import { eq, and, or, desc, inArray, sql, isNull, lte } from "drizzle-orm";
import {
  classifyEquityAccounts,
  classifyNetPositionAccounts,
  getAccountNetBalance,
  type NetPositionAccount,
} from "../../netPositionHelper";

import { _getCached, _setCached } from "../../services/shared/ttlCache";
import { computeRentalOutstanding } from "./netProfitRentalSection";
import { computeStockInHand } from "./netProfitStockSection";
import { loadNetProfitData } from "./netProfitDataLoad";
import { getNetPositionCurrencySummary } from "../../services/accounting/netPositionCurrency";
import { getSupplierPartnerCustomerNetPosition } from "../../helpers/supplierPartnerCustomerNetPosition";
import { storage } from "../../storage";
import { getSupplierPartnerPosProfit } from "./realizedProfit";

export function registerStatsNetProfitRoutes(app: Express) {
  app.get("/api/stats/net-profit", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Balance-sheet "as of" date — cumulative approach (everything up to toDate)
      // fromDate is accepted but intentionally ignored for balance-sheet accounts;
      // the balance sheet is always a point-in-time snapshot (as of toDate), not a period.
      const toDate = req.query.toDate ? String(req.query.toDate) : null;

      // Rounding helper — defined early so it is available throughout the handler
      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

      // Fetch company to know its base currency (CFA vs USD)
      // Check the 30-second TTL cache before touching the DB
      const _cacheKey = `net-profit:${companyId}:${toDate || ""}`;
      const _cached = _getCached(_cacheKey);
      if (_cached) return res.json(_cached);

      // All the report's raw inputs - company row, ledger accounts and the three
      // grouped balance maps - are loaded in ./netProfitDataLoad.
      const [netPositionCurrency, reportData, companySettings] = await Promise.all([
        getNetPositionCurrencySummary(companyId, toDate),
        loadNetProfitData(companyId, toDate),
        storage.getCompanySettings(companyId),
      ]);
      const {
        companyRecord,
        companyAccounts,
        parentCompanyId,
        hasMigratedEntries: _hasMigratedEntries,
        companyBaseCurrency,
        accountBalances,
        supplierBalances,
        employeeBalances,
      } = reportData;

      // ============ NET POSITION CALCULATION ============
      // Uses shared helper (netPositionHelper.ts) – single source of truth for
      // the asset vs liability classification formula used by both ERP and Factory.

      // A company only delegates supplier liabilities to another company when it is
      // explicitly linked through companies.parent_company_id. Standalone companies
      // must show their own supplier balances even when a global parent company exists.
      const shouldIncludeSuppliers = companyRecord?.parentCompanyId == null;
      // Supplier master opening balances are global historical data and belong only to
      // the explicitly configured parent company, never to a standalone sibling company.
      const shouldIncludeSupplierOpening = parentCompanyId !== null && companyId === parentCompanyId;

      // Build excluded-from-expenses set (needed for the P&L expense pass below)
      const importChargesParent = companyAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
      const excludedFromExpenses = new Set<number>();
      if (importChargesParent) {
        excludedFromExpenses.add(importChargesParent.id);
        for (const acc of companyAccounts) {
          if (acc.parentId === importChargesParent.id) excludedFromExpenses.add(acc.id);
        }
      }
      for (const acc of companyAccounts) {
        if (
          acc.code === "PURCHASES" ||
          acc.code?.startsWith("PURCHASES_") ||
          acc.code === "PRODUCTION_ADJUSTMENT" ||
          acc.code === "CONSUMPTION_EXPENSE"
        ) {
          excludedFromExpenses.add(acc.id);
        }
      }

      // 1. Classify balance-sheet accounts (assets vs liabilities) via shared helper.
      // SP formula: What We Have = Cash + Customer A/R + Stock (from inventory table); What We Owe includes supplier cash payable and Loan/Loans balances.
      // Other SP ledger accounts (OTW, prepaid, intercompany, clearing accounts, etc.) remain excluded unless explicitly part of the formula.
      // For non-SP: exclude sp_stock (inventory table is authoritative) and sp_cost_clearing (double-counts).
      const isSupplierPartner = companyRecord?.companyType === "supplier_partner";
      const equityIncludedInNetPosition = isSupplierPartner;
      const supplierPartnerCustomerPosition = isSupplierPartner
        ? await getSupplierPartnerCustomerNetPosition(companyId, toDate)
        : null;
      const accountsForClassify = isSupplierPartner
        ? companyAccounts.filter(
            (a) =>
              a.accountType === "Cash" ||
              a.accountType === "Loan" ||
              a.accountType === "Loans" ||
              ((a.accountType === "Customer" ||
                a.subType === "Accounts Receivable" ||
                (a.code || "").toUpperCase().startsWith("CUST-") ||
                (a.name || "").toLowerCase().includes("customer account")) &&
                !supplierPartnerCustomerPosition?.ledgerAccountIds.has(a.id)) ||
              a.subType === "sp_payable"
          )
        : companyAccounts.filter((a) => a.subType !== "sp_stock" && a.subType !== "sp_cost_clearing");
      const classified = classifyNetPositionAccounts(accountsForClassify, accountBalances, {
        includeSupplierTypeAccounts: shouldIncludeSuppliers,
      });
      const equity = classifyEquityAccounts(companyAccounts, accountBalances);
      let forUsTotal = classified.forUsTotal;
      let onUsTotal = classified.onUsTotal;
      const forUsAccounts = classified.forUsAccounts;
      const onUsAccounts = classified.onUsAccounts;
      const categoryTotals = classified.categoryTotals;

      // Linked customer ledgers are replaced by the authoritative customer balance below,
      // which also includes direct customer-targeted journal/receipt entries.
      if (supplierPartnerCustomerPosition) {
        for (const customer of supplierPartnerCustomerPosition.items) {
          const value = round2(Math.abs(customer.signedBalance));
          if (customer.signedBalance > 0) {
            forUsTotal = round2(forUsTotal + value);
            categoryTotals["asset_Asset"] = round2((categoryTotals["asset_Asset"] || 0) + value);
            forUsAccounts.push({
              id: customer.ledgerAccountId ?? undefined,
              name: customer.name,
              code: customer.code,
              value,
              category: "Asset",
            });
          } else {
            onUsTotal = round2(onUsTotal + value);
            categoryTotals["liability_Liability"] = round2((categoryTotals["liability_Liability"] || 0) + value);
            onUsAccounts.push({
              id: customer.ledgerAccountId ?? undefined,
              name: customer.name,
              code: customer.code,
              value,
              category: "Liability",
            });
          }
        }
        forUsAccounts.sort((a, b) => b.value - a.value);
        onUsAccounts.sort((a, b) => b.value - a.value);
      }

      // Exclude ledger-based "Accrued Rent Payable" — the computed rentPayable
      // (expected − paid up to asOf) is always more accurate than the accrual-
      // scheduler-dependent ledger account. Strip it here before any totals are used.
      for (let i = onUsAccounts.length - 1; i >= 0; i--) {
        const a = onUsAccounts[i];
        const nameLower = (a.name || "").toLowerCase();
        const code = (a.code || "").toUpperCase();
        if (nameLower.includes("accrued rent") || code === "ACCR-RENT-PAY" || code === "ACCRUED_RENT_PAYABLE") {
          onUsTotal = round2(onUsTotal - a.value);
          onUsAccounts.splice(i, 1);
        }
      }

      // Exclude ledger-based "Prepaid Rent" accounts — the rental-shops calculation
      // below (propertyContracts: paid − expected) is always the authoritative source
      // for prepaid rent. Keeping both would double-count it.
      for (let i = forUsAccounts.length - 1; i >= 0; i--) {
        const a = forUsAccounts[i];
        const nameLower = (a.name || "").toLowerCase();
        if (nameLower.includes("prepaid rent")) {
          forUsTotal = round2(forUsTotal - a.value);
          // Subtract from whichever category bucket it landed in (typically "asset_Asset")
          const catKey = `asset_${a.category}`;
          if (categoryTotals[catKey] !== undefined) {
            categoryTotals[catKey] = round2(categoryTotals[catKey] - a.value);
            if (Math.abs(categoryTotals[catKey]) < 0.01) delete categoryTotals[catKey];
          }
          forUsAccounts.splice(i, 1);
        }
      }

      // CFA revaluation: Cash accounts hold physical CFA units whose USD worth changes with the rate.
      // Expenses, loans, receivables are locked at their historical CFA values — do NOT revalue them.
      // Only revalue if this company's base currency IS CFA (not a USD company that happens to have
      // a CFA exchange rate stored for reference/inter-company purposes).
      const cfaRateRows =
        companyBaseCurrency === "CFA"
          ? await db
              .select({ rate: exchangeRates.rate })
              .from(exchangeRates)
              .where(
                and(
                  eq(exchangeRates.companyId, companyId),
                  eq(exchangeRates.fromCurrency, "USD"),
                  eq(exchangeRates.toCurrency, "CFA")
                )
              )
              .orderBy(desc(exchangeRates.effectiveDate))
              .limit(1)
          : [];
      const currentCfaRate = cfaRateRows.length > 0 ? parseFloat(cfaRateRows[0].rate) : 0;

      // Legacy non-base balances are intentionally not revalued here. Only the
      // dedicated cash/bank middleware may apply the current rate, and it
      // exposes null/provisional values when the native history is unresolved.

      // 2. Process income and expense accounts for the P&L breakdown (ERP-specific)
      //    The helper skips expense/income types; we handle them here.
      const expenseTypesArr = ["Expense", "Direct Expense", "Indirect Expense"];
      let expensesTotal = 0;
      let incomeTotal = 0;
      const expensesAccounts: { id: number; name: string; code: string; value: number; category: string }[] = [];
      const incomeAccounts: { id: number; name: string; code: string; value: number; category: string }[] = [];

      for (const acc of companyAccounts) {
        const netBalance = getAccountNetBalance(acc, accountBalances);
        const isAnyExpenseType = expenseTypesArr.includes(acc.accountType || "");
        const isIncomeAccount = acc.accountType === "Income";

        if (isIncomeAccount) {
          if (netBalance < 0) {
            incomeTotal += Math.abs(netBalance);
            categoryTotals["income_Sales/Revenue"] =
              (categoryTotals["income_Sales/Revenue"] || 0) + Math.abs(netBalance);
            incomeAccounts.push({
              id: acc.id,
              name: acc.name,
              code: acc.code || "",
              value: Math.abs(netBalance),
              category: "Income",
            });
          } else if (netBalance > 0) {
            incomeTotal -= netBalance;
            categoryTotals["income_Sales/Revenue"] = (categoryTotals["income_Sales/Revenue"] || 0) - netBalance;
            incomeAccounts.push({
              id: acc.id,
              name: acc.name,
              code: acc.code || "",
              value: -netBalance,
              category: "Income (Refund)",
            });
          }
        } else if (isAnyExpenseType && !excludedFromExpenses.has(acc.id)) {
          const category = acc.accountType || "Expense";
          if (netBalance > 0) {
            expensesTotal += netBalance;
            categoryTotals[`exp_${category}`] = (categoryTotals[`exp_${category}`] || 0) + netBalance;
            expensesAccounts.push({ id: acc.id, name: acc.name, code: acc.code || "", value: netBalance, category });
          } else if (netBalance < 0) {
            const credit = Math.abs(netBalance);
            expensesTotal -= credit;
            categoryTotals[`exp_${category}`] = (categoryTotals[`exp_${category}`] || 0) - credit;
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
      {
        let i = forUsAccounts.length - 1;
        while (i >= 0) {
          const acc = forUsAccounts[i];
          const code = (acc.code || "").toUpperCase();
          const nameLower = (acc.name || "").toLowerCase();
          if (factoryLedgerCodesToStrip.has(code) || factoryLedgerNamesToStrip.some((p) => nameLower.includes(p))) {
            forUsTotal -= acc.value;
            const catKey = `asset_${acc.category || acc.name}`;
            if (categoryTotals[catKey] !== undefined) delete categoryTotals[catKey];
            forUsAccounts.splice(i, 1);
          }
          i--;
        }
      }

      // ERP Stock In Hand - location inventory at weighted-average cost,
      // computed in ./netProfitStockSection.
      const stockOnFloor = await computeStockInHand(companyId, toDate);
      if (stockOnFloor > 0) {
        forUsTotal += stockOnFloor;
        categoryTotals["asset_Stock In Hand"] = stockOnFloor;
        forUsAccounts.push({
          name: "Stock In Hand (Inventory)",
          code: "COMPUTED",
          value: stockOnFloor,
          category: "Inventory",
        });
      }

      // Add Workers/Payroll - employee balances (salary payable only)
      // Select only the columns we actually use to avoid schema-mismatch errors on production
      // when new columns have been added to the Drizzle schema but not yet migrated.
      const companyEmployees = await db
        .select({
          id: employees.id,
          companyId: employees.companyId,
          openingBalance: employees.openingBalance,
        })
        .from(employees)
        .where(and(eq(employees.companyId, companyId), eq(employees.active, true), isNull(employees.deletedAt)))
        .execute();
      // Compute each employee's net voucher balance to find salary owed (liability only).
      // Advances are NOT sourced from the ledger here — they are read directly from
      // salaryAdvances.remainingBalance below to match the Payroll → Advances "Outstanding" card.
      let workerLiabilities = 0;
      for (const emp of companyEmployees) {
        const opening = parseFloat(emp.openingBalance || "0");
        // employees table has no openingBalanceSide — convention is Cr (we owe them), so negate.
        const signedOpening = opening * -1;
        const balance = employeeBalances.get(emp.id) || { debit: 0, credit: 0 };
        const netBalance = signedOpening + balance.debit - balance.credit;
        if (netBalance < 0) {
          workerLiabilities += Math.abs(netBalance);
        }
        // netBalance > 0 (advance) is intentionally NOT included here —
        // the authoritative outstanding figure comes from salaryAdvances.remainingBalance below.
      }

      // Strip any "advance"-related ledger accounts that classifyNetPositionAccounts may have
      // captured (e.g. "Worker Advances", "Salary Advances", "Employee Advances",
      // "Factory Worker Advances"). The table-based query below is the single source of truth
      // for advances outstanding, so we must remove them from the classifier output to prevent
      // double-counting.
      const advanceLedgerPattern = /(?:worker|salary|employee|factory)\s+advance/i;
      {
        let i = forUsAccounts.length - 1;
        while (i >= 0) {
          const acc = forUsAccounts[i];
          if (advanceLedgerPattern.test(acc.name || "")) {
            forUsTotal = round2(forUsTotal - acc.value);
            const catKey = `asset_${acc.category || acc.name}`;
            if (categoryTotals[catKey] !== undefined) delete categoryTotals[catKey];
            forUsAccounts.splice(i, 1);
          }
          i--;
        }
      }

      // Authoritative ERP worker advances = SUM(salaryAdvances.remainingBalance)
      // WHERE fullyPaid = false AND companyId = X — exactly what Payroll → Advances shows.
      // Wrapped in try-catch: if salary_advances is missing remaining_balance / fully_paid
      // (pre-migration production schema), fall back to 0 rather than crashing the whole
      // net-profit response with a 500 / column-not-found error.
      let rawSalaryAdvances = 0;
      try {
        const [saRow] = await db
          .select({ total: sql<string>`COALESCE(SUM(CAST(${salaryAdvances.remainingBalance} AS numeric)), 0)` })
          .from(salaryAdvances)
          .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false)));
        rawSalaryAdvances = round2(parseFloat(saRow?.total || "0"));
      } catch (saErr: unknown) {
        // Fallback: column may be absent on old production schemas. Dashboard still loads.
        logger.warn("[/api/stats/net-profit] salary_advances query skipped (schema gap):", {
          error: getErrorMessage(saErr),
        });
      }
      // For CFA companies, worker balances come from voucher entries.
      // Guard: only convert if ALL entries are pre-migration (hasMigratedEntries=false).
      // After migration COALESCE already returns USD-base values; re-dividing by CFA rate
      // would produce incorrect double-conversion.
      const workerLiabilitiesDisplay = workerLiabilities;
      // rawSalaryAdvances comes from the salary_advances table (not voucher entries).
      // Its currency follows the company base currency for CFA companies.
      const workerAdvancesDisplay = rawSalaryAdvances;
      if (workerLiabilitiesDisplay > 0) {
        onUsTotal += workerLiabilitiesDisplay;
        categoryTotals["liability_Workers"] = (categoryTotals["liability_Workers"] || 0) + workerLiabilitiesDisplay;
        onUsAccounts.push({
          name: "Workers/Employees Payable",
          code: "COMPUTED",
          value: workerLiabilitiesDisplay,
          category: "Workers",
        });
      }
      if (workerAdvancesDisplay > 0) {
        forUsTotal += workerAdvancesDisplay;
        categoryTotals["asset_Worker Advances"] =
          (categoryTotals["asset_Worker Advances"] || 0) + workerAdvancesDisplay;
        forUsAccounts.push({
          name: "Worker Advances (Prepaid)",
          code: "COMPUTED",
          value: workerAdvancesDisplay,
          category: "Worker Advances",
        });
      }

      // Add Suppliers for parent and standalone companies. Linked children settle through parent.
      if (shouldIncludeSuppliers) {
        // Only fetch suppliers that appear in this company's entries (avoids full-table scan)
        const supplierIdsWithBalance = [...supplierBalances.keys()];
        // Select only the columns we actually use to avoid schema-mismatch 500s when new
        // columns exist in the Drizzle schema but haven't been migrated to production yet.
        const allSuppliers =
          supplierIdsWithBalance.length > 0
            ? await db
                .select({
                  id: suppliers.id,
                  legalName: suppliers.legalName,
                  code: suppliers.code,
                  openingBalance: suppliers.openingBalance,
                })
                .from(suppliers)
                .where(and(isNull(suppliers.deletedAt), inArray(suppliers.id, supplierIdsWithBalance)))
                .execute()
            : [];
        let supplierLiabilities = 0;
        let supplierAssets = 0;

        for (const sup of allSuppliers) {
          const balance = supplierBalances.get(sup.id);
          if (balance) {
            const opening = shouldIncludeSupplierOpening ? parseFloat(sup.openingBalance || "0") : 0;
            // Suppliers: Credit = we owe them, Debit = we paid them
            // Net positive = we owe them (liability), Net negative = they owe us (asset)
            const netBalance = opening + balance.credit - balance.debit;
            if (netBalance > 0) {
              supplierLiabilities += netBalance;
              const displayVal = netBalance;
              onUsAccounts.push({ name: sup.legalName, code: sup.code || "", value: displayVal, category: "Supplier" });
            } else if (netBalance < 0) {
              supplierAssets += Math.abs(netBalance);
              const displayVal = Math.abs(netBalance);
              forUsAccounts.push({
                name: sup.legalName,
                code: sup.code || "",
                value: displayVal,
                category: "Supplier Overpayment",
              });
            }
          }
        }

        // For CFA companies, supplier balances are in CFA → convert to USD
        // Guard: supplier balances come from voucher entries via COALESCE.
        // Only convert pre-migration amounts; after migration the COALESCE already returns USD.
        const supplierLiabilitiesDisplay = supplierLiabilities;
        const supplierAssetsDisplay = supplierAssets;
        if (supplierLiabilitiesDisplay > 0) {
          onUsTotal += supplierLiabilitiesDisplay;
          categoryTotals["liability_Suppliers"] = supplierLiabilitiesDisplay;
        }
        if (supplierAssetsDisplay > 0) {
          forUsTotal += supplierAssetsDisplay;
          categoryTotals["asset_Supplier Overpayment"] = supplierAssetsDisplay;
        }
      }

      // Stock OTW — historical as of toDate (containers that were in transit on that date).
      // SP (supplier_partner) companies track OTW via the sp_goods_otw ledger account instead
      // of the containers table, so skip the container-based calculation to avoid double-counting.
      const isSpCompany = companyRecord?.companyType === "supplier_partner";
      if (!isSpCompany) {
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

        let stockOtwValue = 0;
        for (const container of otwContainers) {
          // Use numeric OR so that grandTotal="0" (DB default) falls through to itemsTotal.
          // String OR ("0" || itemsTotal) would never reach itemsTotal because "0" is truthy.
          const gTotal = parseFloat(container.grandTotal ?? "0");
          const containerValue = gTotal || parseFloat(container.itemsTotal ?? "0");
          stockOtwValue += containerValue;
        }

        if (stockOtwValue > 0) {
          forUsTotal += stockOtwValue;
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
      const rental = await computeRentalOutstanding(companyId, toDate, currentCfaRate);
      if (rental.prepaidRent > 0.005) {
        const val = rental.prepaidRent;
        forUsTotal = round2(forUsTotal + val);
        categoryTotals["asset_Prepaid Rent"] = (categoryTotals["asset_Prepaid Rent"] || 0) + val;
        forUsAccounts.push({ name: "Prepaid Rent", code: "PREPAID_RENT", value: val, category: "Prepaid Rent" });
      }
      if (rental.rentPayable > 0.005) {
        const val = rental.rentPayable;
        onUsTotal = round2(onUsTotal + val);
        categoryTotals["liability_Rent Payable"] = (categoryTotals["liability_Rent Payable"] || 0) + val;
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
      forUsTotal = round2(forUsTotal);
      onUsTotal = round2(onUsTotal);
      incomeTotal = round2(incomeTotal);
      expensesTotal = round2(expensesTotal);

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
          const combined = round2(stockEntries.reduce((s: number, a) => s + (a.value || 0), 0));
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
      const netPosition = round2(forUsTotal - onUsTotal + equityNetPositionContribution);

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
      if (isSpCompany) {
        spPosProfit = round2(await getSupplierPartnerPosProfit(companyId, spPosProfitBaselineDate, toDate));
      }

      // Owner's Capital for backward compatibility
      const profitAccounts = companyAccounts.filter((acc) => acc.accountType === "Profit");
      let ownersCapital = 0;
      for (const acc of profitAccounts) {
        const opening = parseFloat(acc.openingBalance || "0");
        const balance = accountBalances.get(acc.id) || { debit: 0, credit: 0 };
        ownersCapital += opening + balance.credit - balance.debit;
      }

      // Net Worth and Profit for backward compatibility
      const netWorth = netPosition;
      const netProfit = round2(incomeTotal - expensesTotal);

      // Breakdown for display
      const netPositionBreakdown = {
        assets: {
          total: forUsTotal,
          breakdown: forUsBreakdown,
        },
        liabilities: {
          total: onUsTotal,
          breakdown: onUsBreakdown,
        },
        income: {
          total: incomeTotal,
          breakdown: incomeBreakdown,
        },
        expenses: {
          total: expensesTotal,
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
        totalIncome: incomeTotal,
        totalExpenses: expensesTotal,
        netProfit,
        spPosProfit,
        ...(spPosProfitBaselineDate ? { spPosProfitBaselineDate } : {}),
        forUs: {
          total: forUsTotal,
          breakdown: forUsBreakdown,
          accounts: forUsAccounts,
        },
        onUs: {
          total: onUsTotal,
          breakdown: onUsBreakdown,
          accounts: onUsAccounts,
        },
        income: {
          total: incomeTotal,
          breakdown: incomeBreakdown,
          accounts: incomeAccounts,
        },
        expenses: {
          total: expensesTotal,
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
        forUsTotal,
        onUsTotal,
        incomeTotal,
        expensesTotal,
        currency: {
          ...netPositionCurrency,
          currentCashBankTranslationApplied: false,
          historicalValuesLocked: true,
        },
        currencyRevaluation: {
          reportTotalsProvisional: netPositionCurrency.totalsProvisional,
        },
      };
      _setCached(_cacheKey, _result);
      res.json(_result);
    } catch (error: unknown) {
      logger.error("[/api/stats/net-profit] Unhandled error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Net Position Excel Export
}
