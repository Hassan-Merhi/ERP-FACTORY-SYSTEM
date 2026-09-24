import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../../services/rental/rentalPeriodService";
import { pool } from "../../../db";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { classifyNetPositionAccounts, type AccountLike } from "../../../netPositionHelper";

import {
  customerOrders,
  customerBalances,
  customers,
  ledgerAccounts,
  voucherEntries,
  companies,
  employees,
  vouchers,
  propertyContracts,
  propertyMonthlyLedger,
  propertyUnits,
} from "@shared/schema";
import { eq, and, desc, sql, inArray, isNull, lte } from "drizzle-orm";
import { computeNetPositionInventory } from "./netPositionInventory";
import { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import { resultRows } from "../../../lib/queryResult";

export function registerEmployeeNetPositionRoutes(app: Express) {
  app.get("/api/factory/net-position", requireAuth, async (req: Request, res: Response) => {
    try {
      // Resolve factory company ID the same way my-access does:
      // 1. pinned factoryCompanyId (if it's a factory-type company)
      // 2. currentCompanyId (if it's factory-type)
      // 3. first active factory-type company in DB
      // 4. fall back to currentCompanyId
      let companyId: number | null = req.session.factoryCompanyId || null;

      if (!companyId) {
        const currentId = req.session.currentCompanyId;
        if (currentId) {
          const [cur] = await db
            .select({ id: companies.id, companyType: companies.companyType })
            .from(companies)
            .where(eq(companies.id, currentId));
          if (cur?.companyType === "factory") companyId = cur.id;
        }
      }

      if (!companyId) {
        const [fc] = await db
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.companyType, "factory"), eq(companies.active, true)))
          .limit(1);
        if (fc) companyId = fc.id;
      }

      if (!companyId) companyId = (req.session as { currentCompanyId: number | null }).currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Pin it for subsequent requests this session
      req.session.factoryCompanyId = companyId;

      // ── As-of date ────────────────────────────────────────────────────────────
      // All date-sensitive queries are filtered to data created/dated on or before asOf.
      const asOf: string =
        typeof req.query.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf)
          ? req.query.asOf
          : getClientDate(req);

      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

      // Load user-configured display FX rates (set in Settings → FX Rates)
      const fxRateRows = await db.execute(sql`
        SELECT DISTINCT ON (currency_code) currency_code, rate_to_usd
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual'
        ORDER BY currency_code, effective_date DESC
      `);
      const configFxRates: Record<string, number> = {};
      for (const row of fxRateRows.rows) {
        configFxRates[row.currency_code as string] = parseFloat(row.rate_to_usd as string);
      }
      // Only use manually configured rates — no hardcoded fallbacks
      const getConfigFx = (cc: string): number => configFxRates[cc] ?? 1;

      // ── 1. Factory supplier balances (What We Owe) ──────────────────────
      // Computed in ./netPositionSupplierBalances. suppliersList,
      // supplierLockedRateMapNp and allContainersF come back with the balances
      // because the inventory valuations below are built from the same loads.
      const {
        supplierLockedRateMapNp,
        allContainersF,
        supplierItems,
        totalSupplierLiabilities,
        totalSupplierOverpayments,
      } = await computeNetPositionSupplierBalances({ companyId, asOf, round2, getConfigFx });

      // ── 2. ERP ledger account balances for the factory company ──────────
      const factoryAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));

      const factoryVouchers = await db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            isNull(vouchers.deletedAt),
            sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${asOf}`
          )
        );

      const fVoucherIds = factoryVouchers.map((v) => v.id);
      const factoryEntries =
        fVoucherIds.length > 0
          ? await db.select().from(voucherEntries).where(inArray(voucherEntries.voucherId, fVoucherIds))
          : [];

      const accBalances = new Map<number, { debit: number; credit: number }>();
      for (const e of factoryEntries) {
        if (!e.ledgerAccountId) continue;
        const cur = accBalances.get(e.ledgerAccountId) || { debit: 0, credit: 0 };
        accBalances.set(e.ledgerAccountId, {
          debit: cur.debit + parseFloat(e.debitAmount || "0"),
          credit: cur.credit + parseFloat(e.creditAmount || "0"),
        });
      }

      // ── 2b. Classify accounts using the shared ERP formula ─────────────────
      // Factory-specific clearing/cost codes must not appear in net position:
      //   FACTORY_IMPORT_COST   – Dr side of goods-received journal; liability already in supplier balances
      //   FACTORY_CHARGES_PAYABLE – Dr side of other-charges journal; cost entry, not an asset
      //   FREIGHT / OC_OTHER_CHARGE – factory cost clearing codes
      const factoryExcludedCodes = new Set([
        "FACTORY_IMPORT_COST",
        "FACTORY_CHARGES_PAYABLE",
        "FACTORY_OC_EXPENSE",
        "OC_OTHER_CHARGE",
        "PRODUCTION_ADJUSTMENT",
        "CONSUMPTION_EXPENSE",
        "FREIGHT",
      ]);

      const classified = classifyNetPositionAccounts(factoryAccounts as AccountLike[], accBalances, {
        additionalExcludedCodes: factoryExcludedCodes,
        // Supplier-type ledger accounts excluded: factory supplier balances are
        // calculated separately above from factorySuppliers / factoryContainers.
        includeSupplierTypeAccounts: false,
      });

      // ── 2c. Customer balances — ALL customers, authoritative formula ─────────
      // Customer ledger accounts (linked via customers.ledgerAccountId) capture only
      // a subset of the true customer balance: CHARGE-* freight/clearance vouchers.
      // The bulk of the balance lives in customer_orders (FINALIZED grandTotal).
      // To get the correct figure we:
      //   a) exclude customer-owned ledger accounts from the ledger classification, and
      //   b) compute every customer's balance via the same formula as the Customers page.
      const allCustomersForNP = await db
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));

      // Build a set of ledger account IDs owned by customers so we can strip them
      // from the ledger classification output (prevents double-counting).
      const customerLedgerIds = new Set<number>(
        allCustomersForNP.filter((c) => c.ledgerAccountId).map((c) => c.ledgerAccountId as number)
      );

      // Strip customer-linked accounts from the classifier output.
      const ledgerForUs = classified.forUsAccounts.filter((a) => a.id === undefined || !customerLedgerIds.has(a.id));
      const ledgerOnUsRaw = classified.onUsAccounts.filter((a) => a.id === undefined || !customerLedgerIds.has(a.id));

      // ── Strip any ledger-based "Payroll Payable" accounts ─────────────────────
      // The authoritative source for payroll payable is employees.currentBalance
      // (tracked directly via employeeId on voucher entries, not via a ledger account).
      // Any ledger account named/coded as "Payroll Payable" duplicates that and
      // must be excluded here — the single correct figure is injected below.
      const ledgerOnUs = ledgerOnUsRaw.filter((a) => {
        const nameLower = (a.name || "").toLowerCase();
        const code = (a.code || "").toUpperCase();
        const isPayrollPayable =
          nameLower.includes("payroll payable") || code === "PAYROLL_PAYABLE" || code === "PAY_PAYABLE";
        // Exclude ledger-based rent payable — the computed rentPayable (expected − paid
        // up to asOf) is always more accurate than the accrual-scheduler-dependent ledger account.
        const isAccruedRentPayable =
          nameLower.includes("accrued rent") || code === "ACCR-RENT-PAY" || code === "ACCRUED_RENT_PAYABLE";
        // Also exclude the "Factory Worker Advances" ledger account on the liability side —
        // its balance drifts from reality (advance repayments/deductions aren't always posted
        // back to it), and the asset side already strips it in favor of the authoritative
        // factory_worker_advances table sum injected below. Without this, a stray credit
        // balance on that ledger account leaks through here as a bogus liability line.
        const isFactoryWorkerAdvances = nameLower.replace(/\s+/g, " ").trim() === "factory worker advances";
        // Exclude per-worker insurance liability accounts (e.g. "Insurance - أحمد علي رمضان").
        // These are tracked and displayed separately via the Insurance section, not here.
        const isInsuranceMember = /^insurance\s*[-–]/i.test(a.name || "");
        return !isPayrollPayable && !isAccruedRentPayable && !isFactoryWorkerAdvances && !isInsuranceMember;
      });
      const _ledgerForUsTotal = round2(ledgerForUs.reduce((s: number, a) => s + a.value, 0));
      const ledgerOnUsTotal = round2(ledgerOnUs.reduce((s: number, a) => s + a.value, 0));

      const customerItems: { name: string; balanceUsd: number; ledgerAccountId?: number }[] = [];

      if (allCustomersForNP.length > 0) {
        const cIds = allCustomersForNP.map((c) => c.id);
        const custLedgerIds = [...customerLedgerIds];

        // ── Customer balance formula — mirrors GET /api/factory/customers exactly ──
        // 1. Net of ALL customerBalances rows (includes INVOICE type as stored).
        const cCbNetRows = await db
          .select({
            customerId: customerBalances.customerId,
            net: sql<string>`COALESCE(SUM(CAST(${customerBalances.debitAmount} AS numeric) - CAST(${customerBalances.creditAmount} AS numeric)), 0)`,
          })
          .from(customerBalances)
          .where(
            and(
              inArray(customerBalances.customerId, cIds),
              eq(customerBalances.companyId, companyId),
              lte(customerBalances.transactionDate, asOf)
            )
          )
          .groupBy(customerBalances.customerId);

        const cCbNetMap = new Map(cCbNetRows.map((r) => [r.customerId, parseFloat(r.net || "0")]));

        // 2. Correction for INVOICE rows: replace stored debitAmount with live grandTotal
        //    of FINALIZED orders — identical to the statement correction on the Customers page.
        const cInvCorrRows = await db
          .select({
            customerId: customerBalances.customerId,
            correction: sql<string>`COALESCE(SUM(CAST(${customerOrders.grandTotal} AS numeric) - CAST(${customerBalances.debitAmount} AS numeric)), 0)`,
          })
          .from(customerBalances)
          .innerJoin(
            customerOrders,
            and(
              eq(customerOrders.id, customerBalances.referenceId),
              eq(customerOrders.companyId, companyId),
              eq(customerOrders.status, "FINALIZED"),
              lte(customerOrders.orderDate, asOf)
            )
          )
          .where(
            and(
              inArray(customerBalances.customerId, cIds),
              eq(customerBalances.companyId, companyId),
              sql`${customerBalances.referenceType} = 'INVOICE'`,
              lte(customerBalances.transactionDate, asOf)
            )
          )
          .groupBy(customerBalances.customerId);

        const cInvCorrMap = new Map(cInvCorrRows.map((r) => [r.customerId, parseFloat(r.correction || "0")]));

        // 3. Voucher entries via ledgerAccountId — EXCLUDE CHARGE-* AND INV-* (matches Customers page).
        const cLedgerVoucherRows =
          custLedgerIds.length > 0
            ? await db
                .select({
                  ledgerAccountId: voucherEntries.ledgerAccountId,
                  net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
                })
                .from(voucherEntries)
                .innerJoin(
                  vouchers,
                  and(
                    eq(voucherEntries.voucherId, vouchers.id),
                    eq(vouchers.companyId, companyId),
                    sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
                    sql`${vouchers.voucherNumber} NOT LIKE 'INV-%'`,
                    lte(vouchers.voucherDate, asOf)
                  )
                )
                .where(inArray(voucherEntries.ledgerAccountId, custLedgerIds))
                .groupBy(voucherEntries.ledgerAccountId)
            : [];
        const cLedgerVoucherMap = new Map(cLedgerVoucherRows.map((r) => [r.ledgerAccountId, parseFloat(r.net || "0")]));

        // 4. Voucher entries directly linked via customerId — EXCLUDE CHARGE-* AND INV-* (matches Customers page).
        const cVoucherRows = await db
          .select({
            customerId: voucherEntries.customerId,
            net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(
            vouchers,
            and(
              eq(voucherEntries.voucherId, vouchers.id),
              eq(vouchers.companyId, companyId),
              sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
              sql`${vouchers.voucherNumber} NOT LIKE 'INV-%'`,
              lte(vouchers.voucherDate, asOf)
            )
          )
          .where(and(inArray(voucherEntries.customerId, cIds), isNull(voucherEntries.ledgerAccountId)))
          .groupBy(voucherEntries.customerId);

        const cVoucherMap = new Map(cVoucherRows.map((r) => [r.customerId, parseFloat(r.net || "0")]));

        for (const c of allCustomersForNP) {
          const cbNet = cCbNetMap.get(c.id) ?? 0;
          const invCorr = cInvCorrMap.get(c.id) ?? 0;
          const ledgerVoucherNet = c.ledgerAccountId ? (cLedgerVoucherMap.get(c.ledgerAccountId) ?? 0) : 0;
          const directVoucherNet = cVoucherMap.get(c.id) ?? 0;
          const voucherNet = ledgerVoucherNet + directVoucherNet;
          const opening = parseFloat(c.openingBalance || "0");
          const openingSide = c.openingBalanceSide || "Dr";
          const totalBalance = (openingSide === "Dr" ? opening : -opening) + cbNet + invCorr + voucherNet;
          if (Math.abs(totalBalance) > 0.01) {
            customerItems.push({
              name: c.legalName || `Customer #${c.id}`,
              balanceUsd: round2(totalBalance),
              ledgerAccountId: c.ledgerAccountId || undefined,
            });
          }
        }
      }

      // Inventory valuations - finished stock, raw material, stock on the
      // water and material in process - are computed in ./netPositionInventory.
      // Only Stock In Hand switches valuation mode; Balance on Table stays on
      // its original all-time blended raw-material cost basis.
      const valuationMode = req.query.valuationMode === "selling" ? "selling" : "cost";
      const {
        inventorySellValue,
        inventorySellingValue,
        rawMaterialStockValue,
        stockOtwValue,
        balanceOnTableValue,
      } = await computeNetPositionInventory({
          companyId,
          asOf,
          round2,
          getConfigFx,
          configFxRates,
          supplierLockedRateMapNp,
          allContainersF,
        });

      // ── 4. Pending, Verified & Loading orders (upcoming receivables) ──────────
      // Fetched here (before forUsTotal) so PENDING/VERIFIED totals can be
      // included in "What We Have". LOADING is shown for reference only.
      //
      // No double-counting risk: once an order is PENDING or VERIFIED the
      // bales allocated to it are set to RESERVED_FOR_ORDER status, which
      // means they are already excluded from the IN_STOCK baleInventoryValue.
      const pendingVerifiedRows = await db
        .select({
          id: customerOrders.id,
          status: customerOrders.status,
          orderDate: customerOrders.orderDate,
          grandTotal: customerOrders.grandTotal,
          totalQtyBales: customerOrders.totalQtyBales,
          customerId: customerOrders.customerId,
          customerName: customers.legalName,
        })
        .from(customerOrders)
        .innerJoin(customers, eq(customerOrders.customerId, customers.id))
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            inArray(customerOrders.status, ["PENDING_VERIFICATION", "VERIFIED", "LOADING"]),
            lte(customerOrders.orderDate, asOf)
          )
        )
        .orderBy(desc(customerOrders.orderDate));

      const mapOrder = (r: (typeof pendingVerifiedRows)[number]) => ({
        id: r.id,
        customerName: r.customerName || `Customer #${r.customerId}`,
        orderDate: r.orderDate,
        grandTotal: round2(parseFloat(r.grandTotal || "0")),
        totalQtyBales: r.totalQtyBales ?? 0,
      });

      const pendingOrders = pendingVerifiedRows.filter((r) => r.status === "PENDING_VERIFICATION").map(mapOrder);
      const verifiedOrders = pendingVerifiedRows.filter((r) => r.status === "VERIFIED").map(mapOrder);
      const loadingOrders = pendingVerifiedRows.filter((r) => r.status === "LOADING").map(mapOrder);

      const pendingTotal = round2(pendingOrders.reduce((s, o) => s + o.grandTotal, 0));
      const verifiedTotal = round2(verifiedOrders.reduce((s, o) => s + o.grandTotal, 0));
      const loadingTotal = round2(loadingOrders.reduce((s, o) => s + o.grandTotal, 0));

      // ── 5. Combine and return ────────────────────────────────────────────
      // Rename for clarity — these are the two factory-specific values.
      const baleInventoryValue = round2(
        valuationMode === "selling" ? inventorySellingValue : inventorySellValue
      );
      const selectedBalanceOnTableValue = round2(balanceOnTableValue);

      // Guard: strip any ledger account whose category could collide with our
      // factory-injected "Inventory" / "Stock" entries.  Accounts with type
      // "Inventory" bypass the name-pattern exclusion in classifyNetPositionAccounts
      // (that guard only runs for types in assetAccountTypes).  Removing them
      // here guarantees ONE source of truth for both factory values.
      const inventoryCategoryRx = /inventory|stock in hand|stock on hand|raw material/i;
      // Also strip the "Factory Worker Advances" ledger account — its balance drifts from
      // reality because advance repayments/deductions aren't always posted back to it.
      // factory_worker_advances.remaining_balance (used by the Payroll & Benefits "Advances"
      // KPI) is the authoritative source; we recompute it fresh below instead.
      const cleanLedgerForUs = ledgerForUs.filter(
        (a) =>
          !inventoryCategoryRx.test(a.category) &&
          !inventoryCategoryRx.test(a.name) &&
          (a.name || "").toLowerCase().trim().replace(/\s+/g, " ") !== "factory worker advances" &&
          // Exclude per-worker insurance liability accounts (e.g. "Insurance - أحمد علي رمضان")
          // — these are tracked separately via the Insurance section, not Net Position assets
          !/^Insurance\s*[-–]/i.test(a.name || "") &&
          // Exclude ledger-based "Prepaid Rent" accounts — the property-contract
          // calculation below (paid − expected per contract) is the authoritative source.
          // Keeping both would show Prepaid Rent twice: once from the ledger account
          // and once from the rental calculation. statsNetProfitRoutes.ts applies the
          // same exclusion for the same reason.
          !(a.name || "").toLowerCase().includes("prepaid rent")
      );
      const cleanLedgerForUsTotal = round2(cleanLedgerForUs.reduce((s, a) => s + a.value, 0));

      // ── Factory Worker Advances — authoritative sum from factory_worker_advances ──
      // Mirrors the Payroll & Benefits "Advances" KPI exactly: SUM(remaining_balance)
      // WHERE remaining_balance > 0 (see GET /api/factory/workers), so the two figures
      // always match instead of drifting from the stale "Factory Worker Advances" ledger
      // account balance (advance repayments aren't always posted back to that account).
      const workerAdvRes = await db.execute(sql`
        SELECT COALESCE(SUM(remaining_balance::numeric), 0) AS total
        FROM   factory_worker_advances
        WHERE  company_id = ${companyId}
          AND  remaining_balance > 0
      `);
      const workerAdvRow = resultRows(workerAdvRes)[0] ?? {};
      const workerAdvancesValue = round2(parseFloat(String(workerAdvRow.total ?? "0")) || 0);

      // ── Split customer items into DR (asset) and CR (liability) ──────────────
      const customerDrItems = customerItems.filter((c) => c.balanceUsd > 0);
      const customerCrItems = customerItems.filter((c) => c.balanceUsd < 0);
      const totalCustomerDr = round2(customerDrItems.reduce((s, c) => s + c.balanceUsd, 0));
      const totalCustomerCr = round2(customerCrItems.reduce((s, c) => s + Math.abs(c.balanceUsd), 0));

      // ── Rental (company is the LANDLORD collecting rent from shop tenants) ──────
      // Uses the same billing-day-aware logic as the Shop Rentals dashboard so
      // the value here always matches what the user sees on that page.
      //
      // CREDIT  = tenants paid MORE than expected → advance money we hold (asset)
      // OUTSTANDING = tenants still OWE us → receivable (asset)
      // Prepaid Rent = CREDIT + OUTSTANDING  (both are "What We Have")
      let prepaidRent = 0;
      const rentPayable = 0;
      {
        // All FACTORY units owned by this company
        const rentalUnitsRows = await db
          .select({ id: propertyUnits.id })
          .from(propertyUnits)
          .where(
            and(
              eq(propertyUnits.companyId, companyId),
              eq(propertyUnits.module, "FACTORY"),
              eq(propertyUnits.active, true)
            )
          );

        if (rentalUnitsRows.length > 0) {
          const unitIds = rentalUnitsRows.map((u) => u.id);
          const activeContracts = await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, "FACTORY"),
                inArray(propertyContracts.unitId, unitIds),
                eq(propertyContracts.status, "ACTIVE")
              )
            );

          if (activeContracts.length > 0) {
            const contractIds = activeContracts.map((c) => c.id);

            // Billing-day-aware expected (same logic as rentalUnitsContractsRoutes)
            const ledgerRows = await db
              .select({
                contractId: propertyMonthlyLedger.contractId,
                year: propertyMonthlyLedger.year,
                month: propertyMonthlyLedger.month,
                expectedAmount: propertyMonthlyLedger.expectedAmount,
              })
              .from(propertyMonthlyLedger)
              .where(inArray(propertyMonthlyLedger.contractId, contractIds));

            const ledgerByContract = new Map<number, typeof ledgerRows>();
            for (const row of ledgerRows) {
              const arr = ledgerByContract.get(row.contractId) ?? [];
              arr.push(row);
              ledgerByContract.set(row.contractId, arr);
            }

            const expectedAsOfByContract = new Map<number, number>();
            for (const c of activeContracts) {
              const billingDay = getRentalBillingDay(c.startDate as string);
              const rows = ledgerByContract.get(c.id) ?? [];
              let expected = 0;
              for (const row of rows) {
                const billingDate = getRentalPeriodDueDate(row.year, row.month, billingDay);
                if (billingDate <= asOf) expected += parseFloat(row.expectedAmount as string) || 0;
              }
              expectedAsOfByContract.set(c.id, expected);
            }

            // POSTED payments only — same authoritative source as the dashboard
            const { rows: postedRows } = await pool.query<{ contract_id: string; paid: string }>(
              `SELECT contract_id, COALESCE(SUM(amount::numeric), 0) AS paid
               FROM property_payments
               WHERE contract_id = ANY($1) AND posting_status = 'POSTED' AND payment_date <= $2
               GROUP BY contract_id`,
              [contractIds, asOf]
            );
            const paidAsOfByContract = new Map<number, number>();
            postedRows.forEach((r) => paidAsOfByContract.set(parseInt(r.contract_id), parseFloat(r.paid)));

            for (const c of activeContracts) {
              const expected = expectedAsOfByContract.get(c.id) ?? 0;
              const paid = paidAsOfByContract.get(c.id) ?? 0;
              const raw = expected - paid; // positive = tenant still owes; negative = tenant overpaid
              if (raw > 0)
                prepaidRent += raw; // outstanding receivable
              else if (raw < 0) prepaidRent += -raw; // advance credit we hold
            }
            prepaidRent = round2(prepaidRent);
          }
        }
      }

      // ── Employee Salaries Payable / Receivables — directly from employees.currentBalance ──
      // Employee balances are tracked via employees.currentBalance (not through a
      // "Payroll Payable" ledger account), so we inject them here explicitly.
      // A negative currentBalance means the employee owes the company (e.g. an unpaid
      // advance/FX debit) — that's a receivable and belongs in "What We Have", not a
      // liability. Previously these were dropped entirely (only bal > 0 was summed).
      const allEmployeesForNP = await db
        .select({
          firstName: employees.firstName,
          lastName: employees.lastName,
          currentBalance: employees.currentBalance,
        })
        .from(employees)
        .where(
          and(
            eq(employees.companyId, companyId),
            eq(employees.employeeType, "Employee"),
            eq(employees.active, true),
            isNull(employees.deletedAt)
          )
        );
      let employeeSalariesPayable = 0;
      let employeeReceivablesTotal = 0;
      const employeeReceivableItems: { name: string; balanceUsd: number }[] = [];
      for (const emp of allEmployeesForNP) {
        const bal = parseFloat(emp.currentBalance || "0");
        if (bal > 0) employeeSalariesPayable += bal;
        else if (bal < 0) {
          employeeReceivablesTotal += Math.abs(bal);
          const empName = [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim();
          if (empName) employeeReceivableItems.push({ name: empName, balanceUsd: Math.abs(bal) });
        }
      }
      employeeSalariesPayable = round2(employeeSalariesPayable);
      employeeReceivablesTotal = round2(employeeReceivablesTotal);

      // forUsTotal: ledger assets + inventory + raw material + balance on table + stock OTW
      //             + customer receivables (DR) + pending orders + verified orders + loading orders
      //             + overpaid suppliers (they owe us the overpayment back)
      //             + prepaidRent (we overpaid our landlord → asset)
      //             + employee receivables (negative employee balances — they owe us back)
      //             (bales are reserved/excluded from baleInventoryValue — no double-count)
      const totalSupplierOverpaymentsRounded = round2(totalSupplierOverpayments);
      const forUsTotal = round2(
        cleanLedgerForUsTotal +
          baleInventoryValue +
          rawMaterialStockValue +
          selectedBalanceOnTableValue +
          stockOtwValue +
          totalCustomerDr +
          pendingTotal +
          verifiedTotal +
          loadingTotal +
          totalSupplierOverpaymentsRounded +
          prepaidRent +
          employeeReceivablesTotal +
          workerAdvancesValue
      );

      // onUsTotal: ledger liabilities + supplier balances + customer credit balances (CR) + employee salaries + rent payable
      const onUsTotal = round2(
        ledgerOnUsTotal + totalSupplierLiabilities + totalCustomerCr + employeeSalariesPayable + rentPayable
      );
      const netPosition = round2(forUsTotal - onUsTotal);

      // Inject factory-specific lines explicitly (always present so the UI
      // always has a named row for both even when the value is 0).
      const factoryInventoryEntry = {
        name: "Stock In Hand (Inventory)",
        code: "INVENTORY",
        value: baleInventoryValue,
        category: "Inventory",
      };
      const factoryRawMaterialEntry = {
        name: "Factory Raw Material Stock",
        code: "RAW_MATERIAL",
        value: rawMaterialStockValue,
        category: "Raw Material",
      };
      const factoryBalanceOnTableEntry = {
        name: "Balance on Table",
        code: "BALANCE_ON_TABLE",
        value: selectedBalanceOnTableValue,
        category: "Production",
      };
      const factoryStockOtwEntry = {
        name: "Factory Stock OTW",
        code: "STOCK_OTW",
        value: stockOtwValue,
        category: "Stock OTW",
      };

      const forUsAccounts = [
        factoryInventoryEntry,
        factoryRawMaterialEntry,
        ...(selectedBalanceOnTableValue > 0 ? [factoryBalanceOnTableEntry] : []),
        ...(stockOtwValue > 0 ? [factoryStockOtwEntry] : []),
        ...cleanLedgerForUs.sort((a, b) => b.value - a.value).map((a) => ({ ...a, value: round2(a.value) })),
        ...customerDrItems
          .sort((a, b) => b.balanceUsd - a.balanceUsd)
          .map((c) => ({
            ...(c.ledgerAccountId ? { id: c.ledgerAccountId } : {}),
            name: c.name,
            code: "CUSTOMER_DR",
            value: round2(c.balanceUsd),
            category: "Customer",
          })),
        // Overpaid suppliers: they owe us the excess back — show as an asset
        ...supplierItems
          .filter((s) => s.balanceUsd < 0)
          .sort((a, b) => a.balanceUsd - b.balanceUsd)
          .map((s) => ({
            name: s.name,
            code: "SUPPLIER_OVERPAID",
            value: round2(Math.abs(s.balanceUsd)),
            category: "Supplier Overpayments",
            breakdown: s.breakdown,
          })),
        ...(pendingTotal > 0
          ? [{ name: "Pending Orders", code: "PENDING_ORDERS", value: pendingTotal, category: "Pending Orders" }]
          : []),
        ...(verifiedTotal > 0
          ? [{ name: "Verified Orders", code: "VERIFIED_ORDERS", value: verifiedTotal, category: "Verified Orders" }]
          : []),
        ...(loadingTotal > 0
          ? [{ name: "Loading Orders", code: "LOADING_ORDERS", value: loadingTotal, category: "Loading Orders" }]
          : []),
        ...(prepaidRent > 0
          ? [{ name: "Prepaid Rent", code: "PREPAID_RENT", value: prepaidRent, category: "Prepaid Rent" }]
          : []),
        // Employees who owe the company (negative currentBalance) — a receivable
        ...employeeReceivableItems
          .sort((a, b) => b.balanceUsd - a.balanceUsd)
          .map((e) => ({
            name: e.name,
            code: "EMPLOYEE_RECEIVABLE",
            value: round2(e.balanceUsd),
            category: "Employee Receivable",
          })),
        ...(workerAdvancesValue > 0
          ? [
              {
                name: "Factory Worker Advances",
                code: "WORKER_ADVANCES",
                value: workerAdvancesValue,
                category: "Asset",
              },
            ]
          : []),
      ];

      // Group ledger on-us by category
      const ledgerOnUsGrouped: Record<string, number> = {};
      for (const a of ledgerOnUs) {
        ledgerOnUsGrouped[a.category] = (ledgerOnUsGrouped[a.category] || 0) + a.value;
      }

      const onUsAccounts: {
        name: string;
        code: string;
        value: number;
        category: string;
        breakdown?: { label: string; native: string; usd: number }[];
      }[] = [
        ...supplierItems
          .filter((s) => s.balanceUsd > 0)
          .sort((a, b) => b.balanceUsd - a.balanceUsd)
          .map((s) => ({
            name: s.name,
            code: "SUPPLIER",
            value: round2(s.balanceUsd),
            category: "Supplier",
            breakdown: s.breakdown,
          })),
        ...ledgerOnUs.sort((a, b) => b.value - a.value).map((a) => ({ ...a, value: round2(a.value) })),
        {
          name: "Payroll Payable",
          code: "EMPLOYEE_PAYROLL_PAYABLE",
          value: employeeSalariesPayable,
          category: "Liability",
        },
        ...customerCrItems
          .sort((a, b) => Math.abs(b.balanceUsd) - Math.abs(a.balanceUsd))
          .map((c) => ({
            ...(c.ledgerAccountId ? { id: c.ledgerAccountId } : {}),
            name: c.name,
            code: "CUSTOMER_CR",
            value: round2(Math.abs(c.balanceUsd)),
            category: "Customer",
          })),
        ...(rentPayable > 0
          ? [{ name: "Rent Payable", code: "RENT_PAYABLE", value: rentPayable, category: "Rent Payable" }]
          : []),
      ];

      const forUsBreakdown = Object.entries(
        forUsAccounts.reduce((m: Record<string, number>, a) => {
          m[a.category] = (m[a.category] || 0) + a.value;
          return m;
        }, {})
      )
        .map(([name, value]) => ({ name, value: round2(value) }))
        .sort((a, b) => b.value - a.value);

      // Merge employee salaries payable into the "Liability" category in the breakdown
      // employeeSalariesPayable is always the authoritative Payroll Payable figure
      const mergedLedgerOnUsGrouped = { ...ledgerOnUsGrouped };
      mergedLedgerOnUsGrouped["Liability"] = round2(
        (mergedLedgerOnUsGrouped["Liability"] || 0) + employeeSalariesPayable
      );
      const onUsBreakdown = [
        ...(totalSupplierLiabilities > 0 ? [{ name: "Suppliers", value: round2(totalSupplierLiabilities) }] : []),
        ...Object.entries(mergedLedgerOnUsGrouped)
          .map(([name, value]) => ({ name, value: round2(value) }))
          .sort((a, b) => b.value - a.value),
        ...(totalCustomerCr > 0 ? [{ name: "Customer", value: totalCustomerCr }] : []),
        ...(rentPayable > 0 ? [{ name: "Rent Payable", value: rentPayable }] : []),
      ];

      res.json({
        asOf,
        forUsTotal,
        onUsTotal,
        netPosition,
        netPositionLabel: netPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
        forUs: { total: forUsTotal, breakdown: forUsBreakdown, accounts: forUsAccounts },
        onUs: { total: onUsTotal, breakdown: onUsBreakdown, accounts: onUsAccounts },
        supplierLiabilities: round2(totalSupplierLiabilities),
        supplierOverpayments: round2(totalSupplierOverpayments),
        inventoryValue: baleInventoryValue,
        rawMaterialValue: rawMaterialStockValue,
        balanceOnTableValue: selectedBalanceOnTableValue,
        valuationMode,
        ledgerAssets: cleanLedgerForUsTotal,
        pendingOrders,
        verifiedOrders,
        loadingOrders,
        pendingTotal,
        verifiedTotal,
        loadingTotal,
        ledgerLiabilities: round2(ledgerOnUsTotal),
        payrollPayable: employeeSalariesPayable,
      });
    } catch (error: unknown) {
      logger.error("Factory net-position error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Payroll Payable Breakdown (view-only, for Net Position page) ────────────
  // GET /api/factory/net-position/payroll-breakdown
  // Returns one row per active employee whose currentBalance > 0.
  // This endpoint is purely informational and does NOT affect any Net Position
  // calculation, account, or balance — it is read-only.
}
