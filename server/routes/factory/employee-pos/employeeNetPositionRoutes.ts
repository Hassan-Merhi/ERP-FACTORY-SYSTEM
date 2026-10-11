import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../../services/rental/rentalPeriodService";
import { pool } from "../../../db";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  classifyNetPositionAccounts,
  PERPETUAL_STOCK_ACCOUNT_CODES,
  type AccountLike,
} from "../../../netPositionHelper";

import {
  customerOrders,
  customers,
  ledgerAccounts,
  voucherEntries,
  companies,
  vouchers,
  propertyContracts,
  propertyMonthlyLedger,
  propertyUnits,
} from "@shared/schema";
import { eq, and, desc, sql, inArray, isNull, lte } from "drizzle-orm";
import { computeNetPositionInventory } from "./netPositionInventory";
import { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import {
  factoryOrderMemoLines,
  notInLedgerSectionWithInformational,
  workerAdvanceMemoLines,
} from "./netPositionNotInLedger";
import { loadNetPositionParties } from "../../../services/accounting/balances/netPositionParties";
import { resultRows } from "../../../lib/queryResult";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { ledgerCarriesStock } from "../../../services/accounting/perpetualInventory/reportBasis";

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
        configFxRates[row.currency_code as string] = toMoney(row.rate_to_usd as string).toNumber();
      }
      // Only use manually configured rates — no hardcoded fallbacks
      const getConfigFx = (cc: string): number => configFxRates[cc] ?? 1;

      // ── 1. Parties (balance engine) and the container context ────────────
      // Factory suppliers, customers and employees come from the one balance
      // engine (services/accounting/balances/netPositionParties.ts); the
      // container context below only feeds the inventory valuations.
      const { supplierLockedRateMapNp, allContainersF } = await computeNetPositionSupplierBalances({
        companyId,
        asOf,
        round2,
        getConfigFx,
        contextOnly: true,
      });
      const parties = await loadNetPositionParties(companyId, {
        asOf,
        customers: true,
        suppliers: false,
        factorySuppliers: true,
        employees: "factory",
        codes: "factory",
        payrollCurrentBalanceMemo: true,
        banks: true,
      });
      const supplierOnUs = parties.onUs.filter((line) => line.partyKind === "factorySupplier");
      const supplierForUs = parties.forUs.filter((line) => line.partyKind === "factorySupplier");
      const totalSupplierLiabilities = round2(supplierOnUs.reduce((sum, line) => sum + line.value, 0));
      const totalSupplierOverpayments = round2(supplierForUs.reduce((sum, line) => sum + line.value, 0));

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

      const exactBalances = new Map<number, { debit: Decimal; credit: Decimal }>();
      for (const e of factoryEntries) {
        if (!e.ledgerAccountId) continue;
        const cur = exactBalances.get(e.ledgerAccountId);
        exactBalances.set(e.ledgerAccountId, {
          debit: toMoney(e.debitAmount).plus(cur?.debit ?? 0),
          credit: toMoney(e.creditAmount).plus(cur?.credit ?? 0),
        });
      }
      const accBalances = new Map<number, { debit: number; credit: number }>();
      for (const [id, { debit, credit }] of exactBalances) {
        accBalances.set(id, { debit: debit.toNumber(), credit: credit.toNumber() });
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

      // Perpetual inventory (wave 8.5): from the cut-over the ledger carries the
      // factory's stock (raw material, work in progress, finished goods).
      const ledgerStock = await ledgerCarriesStock(companyId, asOf);
      const classified = classifyNetPositionAccounts(factoryAccounts as AccountLike[], accBalances, {
        ledgerStockAccounts: ledgerStock,
        additionalExcludedCodes: factoryExcludedCodes,
        // Supplier-type ledger accounts excluded: factory supplier balances are
        // calculated separately above from factorySuppliers / factoryContainers.
        includeSupplierTypeAccounts: false,
      });

      // ── 2c. Customers — the balance engine ─────────────────────────────────
      // A ledger account a customer owns is rolled into the customer by the
      // engine, so it is stripped from the classifier output and the customer
      // line (engine closing, including the CHARGE- and INV-GL journals) is
      // added below. What the old composite added on top of the ledger
      // (unposted factory invoices, POS credit sales, cache rows) is listed in
      // `notInLedger`.
      const customerLedgerIds = parties.customerLedgerIds;

      // Strip customer-linked accounts from the classifier output.
      const ledgerForUs = classified.forUsAccounts.filter((a) => a.id === undefined || !customerLedgerIds.has(a.id));
      const ledgerOnUsRaw = classified.onUsAccounts.filter((a) => a.id === undefined || !customerLedgerIds.has(a.id));

      // ── Strip any ledger-based "Payroll Payable" accounts ─────────────────────
      // Payroll payable is the employee subledger (employee_id lines, from the
      // balance engine), not a ledger account. Any ledger account named/coded as
      // "Payroll Payable" duplicates it and is excluded here — the single figure
      // is injected below.
      const ledgerOnUs = ledgerOnUsRaw.filter((a) => {
        const nameLower = (a.name || "").toLowerCase();
        const code = (a.code || "").toUpperCase();
        const isPayrollPayable =
          nameLower.includes("payroll payable") || code === "PAYROLL_PAYABLE" || code === "PAY_PAYABLE";
        // Exclude ledger-based rent payable — the computed rentPayable (expected − paid
        // up to asOf) is always more accurate than the accrual-scheduler-dependent ledger account.
        const isAccruedRentPayable =
          nameLower.includes("accrued rent") || code === "ACCR-RENT-PAY" || code === "ACCRUED_RENT_PAYABLE";
        // Exclude per-worker insurance liability accounts (e.g. "Insurance - أحمد علي رمضان").
        // These are tracked and displayed separately via the Insurance section, not here.
        const isInsuranceMember = /^insurance\s*[-–]/i.test(a.name || "");
        return !isPayrollPayable && !isAccruedRentPayable && !isInsuranceMember;
      });
      const _ledgerForUsTotal = round2(ledgerForUs.reduce((s: number, a) => s + a.value, 0));
      const ledgerOnUsTotal = round2(ledgerOnUs.reduce((s: number, a) => s + a.value, 0));

      // Inventory valuations - finished stock, raw material, stock on the
      // water and material in process - are computed in ./netPositionInventory.
      // Only Stock In Hand switches valuation mode; Balance on Table stays on
      // its original all-time blended raw-material cost basis.
      const valuationMode = req.query.valuationMode === "selling" ? "selling" : "cost";
      const {
        inventorySellValue: computedInventorySellValue,
        inventorySellingValue,
        rawMaterialStockValue: computedRawMaterialStockValue,
        stockOtwValue,
        balanceOnTableValue: computedBalanceOnTableValue,
        reservedBaleCount,
        reservedBaleCost,
      } = await computeNetPositionInventory({
        companyId,
        asOf,
        getConfigFx,
        configFxRates,
        supplierLockedRateMapNp,
        allContainersF,
      });

      // From the cut-over the ledger's factory stock accounts replace the computed
      // values (the selling-price view keeps its bale value, in place of the
      // ledger's finished goods at cost).
      const sellingView = valuationMode === "selling";
      const inventorySellValue = ledgerStock ? 0 : computedInventorySellValue;
      const rawMaterialStockValue = ledgerStock ? 0 : computedRawMaterialStockValue;
      const balanceOnTableValue = ledgerStock ? 0 : computedBalanceOnTableValue;

      // ── 4. Pending, Verified & Loading orders ─────────────────────────────────
      // Unfinalized orders at selling price are not receivables (no invoice,
      // nothing in the ledger): they are listed and totalled as before, and
      // shown under `notInLedger`, never in "What We Have". Owner decision
      // (wave 11): their bales are stock at cost in Stock In Hand (finished
      // goods after the cut-over), so the order lines are informational and
      // left out of the notInLedger total: the same bales are never counted
      // twice. `reservedBales` reports what Stock In Hand holds for them.
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
        grandTotal: round2(toMoney(r.grandTotal).toNumber()),
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
      const baleInventoryValue = round2(valuationMode === "selling" ? inventorySellingValue : inventorySellValue);
      const selectedBalanceOnTableValue = round2(balanceOnTableValue);

      // Guard: strip any ledger account whose category could collide with our
      // factory-injected "Inventory" / "Stock" entries.  Accounts with type
      // "Inventory" bypass the name-pattern exclusion in classifyNetPositionAccounts
      // (that guard only runs for types in assetAccountTypes).  Removing them
      // here guarantees ONE source of truth for both factory values.
      const inventoryCategoryRx = /inventory|stock in hand|stock on hand|raw material/i;
      const keepsLedgerStock = (a: { code?: string | null }) => {
        const code = (a.code || "").trim().toUpperCase();
        if (!ledgerStock || !PERPETUAL_STOCK_ACCOUNT_CODES.has(code)) return false;
        return !(sellingView && code === "FACTORY_FINISHED_GOODS");
      };
      const cleanLedgerForUs = ledgerForUs.filter(
        (a) =>
          (keepsLedgerStock(a) ||
            (!inventoryCategoryRx.test(a.category) &&
              !inventoryCategoryRx.test(a.name) &&
              !(ledgerStock && (a.code || "").trim().toUpperCase() === "FACTORY_FINISHED_GOODS"))) &&
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

      // ── Factory Worker Advances ───────────────────────────────────────────
      // The "Factory Worker Advances" ledger account is a ledger balance and
      // stays in the classification. What factory_worker_advances (the Payroll &
      // Benefits "Advances" KPI) holds over it — repayments and deductions are
      // not always posted back — is listed under `notInLedger`.
      const workerAdvRes = await db.execute(sql`
        SELECT COALESCE(SUM(remaining_balance::numeric), 0) AS total
        FROM   factory_worker_advances
        WHERE  company_id = ${companyId}
          AND  remaining_balance > 0
      `);
      const workerAdvRow = resultRows(workerAdvRes)[0] ?? {};
      const workerAdvancesTable = round2(toMoney(String(workerAdvRow.total ?? "0")).toNumber());
      const isWorkerAdvanceLedger = (a: { name?: string | null }) =>
        (a.name || "").toLowerCase().trim().replace(/\s+/g, " ") === "factory worker advances";
      const workerAdvancesLedger = round2(
        cleanLedgerForUs.filter(isWorkerAdvanceLedger).reduce((sum, a) => sum + a.value, 0) -
          ledgerOnUs.filter(isWorkerAdvanceLedger).reduce((sum, a) => sum + a.value, 0)
      );

      // ── Bank accounts (balance engine): like a Bank ledger account, an asset,
      // or a liability when overdrawn. A bank linked to a ledger account keeps
      // its own opening and bank-only lines here; lines naming the ledger are
      // in the ledger account's line above (engine priority), never in both.
      const bankForUs = parties.forUs.filter((line) => line.partyKind === "bank");
      const bankOnUs = parties.onUs.filter((line) => line.partyKind === "bank");
      const totalBankAssets = round2(bankForUs.reduce((s, line) => s + line.value, 0));
      const totalBankOverdrafts = round2(bankOnUs.reduce((s, line) => s + line.value, 0));

      // ── Customers (balance engine): DR is an asset, CR a liability ──────────
      const customerDrItems = parties.forUs.filter((line) => line.partyKind === "customer");
      const customerCrItems = parties.onUs.filter((line) => line.partyKind === "customer");
      const totalCustomerDr = round2(customerDrItems.reduce((s, c) => s + c.value, 0));
      const totalCustomerCr = round2(customerCrItems.reduce((s, c) => s + c.value, 0));

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

            const expectedAsOfByContract = new Map<number, Decimal>();
            for (const c of activeContracts) {
              const billingDay = getRentalBillingDay(c.startDate as string);
              const rows = ledgerByContract.get(c.id) ?? [];
              let expected = new MoneyDecimal(0);
              for (const row of rows) {
                const billingDate = getRentalPeriodDueDate(row.year, row.month, billingDay);
                if (billingDate <= asOf) expected = expected.plus(toMoney(row.expectedAmount as string));
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
            const paidAsOfByContract = new Map<number, Decimal>();
            postedRows.forEach((r) => paidAsOfByContract.set(parseInt(r.contract_id), toMoney(r.paid)));

            // Positive = tenant still owes (outstanding receivable); negative =
            // tenant overpaid (advance credit we hold). Both count at their size.
            let rentTotal = new MoneyDecimal(prepaidRent);
            for (const c of activeContracts) {
              const expected = expectedAsOfByContract.get(c.id) ?? new MoneyDecimal(0);
              rentTotal = rentTotal.plus(expected.minus(paidAsOfByContract.get(c.id) ?? 0).abs());
            }
            prepaidRent = round2(rentTotal.toNumber());
          }
        }
      }

      // ── Employee payroll payable / receivables (balance engine) ─────────────
      // Employees' employee_id lines with their openings, as of the date: an
      // employee in credit is part of Payroll Payable, one in debit owes us and
      // is listed. employees.current_balance (the payroll page's figure) is no
      // longer the source; what it holds over the ledger is under `notInLedger`.
      const employeeReceivableItems = parties.forUs.filter((line) => line.partyKind === "employee");
      const payrollLine = parties.onUs.find((line) => line.code === "EMPLOYEE_PAYROLL_PAYABLE");
      const employeeSalariesPayable = round2(payrollLine?.value ?? 0);
      const employeeReceivablesTotal = round2(employeeReceivableItems.reduce((s, e) => s + e.value, 0));

      // Not yet in the ledger: the engine's memo lines (unposted factory
      // invoices, POS credit sales, unjournalled container amounts, payroll and
      // salary-advance differences), unfinalized orders and the worker-advance
      // table's excess over the ledger. Never part of the totals below.
      const notInLedger = notInLedgerSectionWithInformational([
        ...parties.notInLedger.lines,
        ...factoryOrderMemoLines({
          pendingOrders,
          verifiedOrders,
          loadingOrders,
          pendingTotal,
          verifiedTotal,
          loadingTotal,
        }),
        ...workerAdvanceMemoLines(workerAdvancesTable, workerAdvancesLedger),
      ]);

      // forUsTotal: ledger assets + inventory + raw material + balance on table + stock OTW
      //             + customer receivables (DR) + overpaid suppliers + prepaidRent
      //             + employee receivables + bank accounts in debit. Unfinalized orders and the other
      //             operational amounts are under `notInLedger`, not here.
      const totalSupplierOverpaymentsRounded = round2(totalSupplierOverpayments);
      const forUsTotal = round2(
        cleanLedgerForUsTotal +
          baleInventoryValue +
          rawMaterialStockValue +
          selectedBalanceOnTableValue +
          stockOtwValue +
          totalCustomerDr +
          totalSupplierOverpaymentsRounded +
          prepaidRent +
          employeeReceivablesTotal +
          totalBankAssets
      );

      // onUsTotal: ledger liabilities + supplier balances + customer credit balances (CR) + employee salaries
      //            + rent payable + overdrawn bank accounts
      const onUsTotal = round2(
        ledgerOnUsTotal +
          totalSupplierLiabilities +
          totalCustomerCr +
          employeeSalariesPayable +
          rentPayable +
          totalBankOverdrafts
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
        ...bankForUs.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
        ...customerDrItems.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
        // Overpaid suppliers: they owe us the excess back — show as an asset
        ...supplierForUs.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
        ...(prepaidRent > 0
          ? [{ name: "Prepaid Rent", code: "PREPAID_RENT", value: prepaidRent, category: "Prepaid Rent" }]
          : []),
        // Employees who owe the company (debit balance on the ledger) — a receivable
        ...employeeReceivableItems.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
      ];

      // Group ledger on-us by category
      const ledgerOnUsGrouped: Record<string, number> = {};
      for (const a of [...ledgerOnUs, ...bankOnUs]) {
        ledgerOnUsGrouped[a.category] = (ledgerOnUsGrouped[a.category] || 0) + a.value;
      }

      const onUsAccounts: {
        name: string;
        code: string;
        value: number;
        category: string;
        breakdown?: { label: string; native: string; usd: number }[];
      }[] = [
        ...supplierOnUs.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
        ...ledgerOnUs.sort((a, b) => b.value - a.value).map((a) => ({ ...a, value: round2(a.value) })),
        ...bankOnUs.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
        {
          name: "Payroll Payable",
          code: "EMPLOYEE_PAYROLL_PAYABLE",
          value: employeeSalariesPayable,
          category: "Liability",
        },
        ...customerCrItems.map(({ partyKind: _kind, partyId: _id, ...line }) => line),
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
        // Bales of unfinalized orders, at cost, inside Stock In Hand (before the
        // cut-over; after it they are in the ledger's finished goods).
        reservedBales: { count: ledgerStock ? 0 : reservedBaleCount, cost: ledgerStock ? 0 : reservedBaleCost },
        inventoryValueBasis: valuationMode === "selling" ? "selling-price-per-bale" : "bale-cost",
        ledgerLiabilities: round2(ledgerOnUsTotal),
        bankAssets: totalBankAssets,
        bankOverdrafts: totalBankOverdrafts,
        payrollPayable: employeeSalariesPayable,
        notInLedger,
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
