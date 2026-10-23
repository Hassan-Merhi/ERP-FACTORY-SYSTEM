import { FactoryNetPositionDateError } from "@shared/factoryNetPositionAsOf";
import {
  resolveFactoryNetPositionAsOf,
  netPositionKnownTransactionThrough,
  netPositionRecordedThrough,
  netPositionVoucherEntryKnown,
} from "../../../services/factory/netPositionAsOf";
import { loadFactoryNetPositionEmployees } from "../../../services/factory/netPositionEmployees";
import { loadHistoricalFactoryPipeline } from "../../../services/factory/netPositionHistoricalPipeline";
import { computeHistoricalFactoryAssetLiabilityOperations } from "../../../services/factory/netPositionHistoricalAssets";
import { loadFactoryHistoricalCoverage } from "../../../services/factory/netPositionHistoryCoverage";
import { loadFxWalletHistoryGaps } from "../../../services/factory/netPositionFxWalletCoverage";
import { finishFactoryNetPosition } from "./netPositionHistoricalResponse";
import { computeLiveFactoryPrepaidRent } from "./netPositionLiveRent";
import {
  fxAgentTablesExist,
  loadFxAgentWallets,
  getFxAgentWalletSnapshot,
} from "../../../services/factory/fxAgentWalletDb";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  classifyNetPositionAccounts,
  getAccountNetBalance,
  PERPETUAL_STOCK_ACCOUNT_CODES,
  type AccountLike,
} from "../../../netPositionHelper";

import { customerOrders, customers, ledgerAccounts, voucherEntries, companies, vouchers } from "@shared/schema";
import { eq, and, desc, sql, inArray, isNull, lte } from "drizzle-orm";
import { getCustomerLedgerAndMemo } from "../customers-core/customerLedgerSplit";
import { loadHeldChargeSnapshot } from "../customers-core/heldUnfinalizedCustomerCharges";
import { computeNetPositionInventory } from "./netPositionInventory";
import { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import { resultRows } from "../../../lib/queryResult";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { ledgerCarriesStock } from "../../../services/accounting/perpetualInventory/reportBasis";

export function registerEmployeeNetPositionRoutes(app: Express) {
  app.get("/api/factory/net-position", requireAuth, async (req: Request, res: Response) => {
    // Set once the date resolves: any later failure of a past date is a
    // structured 503, never a partial or current-day figure.
    let historicalRequest = false;
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

      // Resolve one company-local cutoff for ALL downstream components.
      // Each category will adopt the effective+recorded predicate in Phases 3–6.
      const asOfContext = await resolveFactoryNetPositionAsOf(companyId, req.query.asOf);
      const asOf = asOfContext.asOf;
      historicalRequest = asOfContext.isHistorical;
      // Perform a read-only prerequisite and evidence check BEFORE invoking
      // any reconstruction query that refers to trigger-added scan timestamps.
      const historyCoverage = asOfContext.isHistorical
        ? await loadFactoryHistoricalCoverage(companyId, asOfContext)
        : null;
      const employeeBalances = await loadFactoryNetPositionEmployees(companyId, asOfContext);
      const historicalAssets = asOfContext.isHistorical
        ? await computeHistoricalFactoryAssetLiabilityOperations(companyId, asOfContext)
        : null;

      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

      // Load user-configured display FX rates (set in Settings → FX Rates)
      const fxRateRows = await db.execute(sql`
        SELECT DISTINCT ON (currency_code) currency_code, rate_to_usd
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual' AND effective_date <= ${asOf}::date
          ${
            asOfContext.isHistorical
              ? sql`AND ${netPositionRecordedThrough(sql`created_at`, asOfContext, "utc-naive-timestamp")}`
              : sql``
          }
        ORDER BY currency_code, effective_date DESC, created_at DESC, id DESC
      `);
      const configFxRates: Record<string, number> = {};
      for (const row of fxRateRows.rows) {
        const currency = String(row.currency_code ?? "")
          .trim()
          .toUpperCase();
        if (currency) configFxRates[currency] = toMoney(row.rate_to_usd as string).toNumber();
      }
      // Only use manually configured rates — no hardcoded fallbacks
      const getConfigFx = (cc: string): number => {
        const currency = cc.trim().toUpperCase();
        if (currency === "USD") return 1;
        const rate = configFxRates[currency];
        if (!rate || !Number.isFinite(rate) || rate <= 0)
          throw new Error(`Missing confirmed USD exchange rate for ${cc}`);
        return rate;
      };

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
      } = await computeNetPositionSupplierBalances({
        companyId,
        asOf,
        knownAt: asOfContext.isHistorical ? asOfContext : undefined,
        round2,
        getConfigFx,
      });

      // ── 2. ERP ledger account balances for the factory company ──────────
      const factoryAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            asOfContext.isHistorical
              ? sql`(${ledgerAccounts.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${ledgerAccounts.deletedAt}`, asOfContext, "utc-naive-timestamp")})`
              : isNull(ledgerAccounts.deletedAt),
            asOfContext.isHistorical
              ? netPositionRecordedThrough(sql`${ledgerAccounts.createdAt}`, asOfContext, "utc-naive-timestamp")
              : sql`TRUE`
          )
        );

      // Ledger lines on legacy EMP-<code> accounts also mutate the employee
      // cached balance. For historic snapshots their voucher movement belongs
      // on the employee row exactly once; retain any ledger ACCOUNT OPENING.
      // Exact match, as netPositionEmployees and employeeBalancePosting map them.
      const historicalEmployeeCodes = new Set(employeeBalances.map((e) => `EMP-${e.code}`));
      const legacyEmployeeLedgerIds = new Set(
        asOfContext.isHistorical
          ? factoryAccounts.filter((a) => a.code && historicalEmployeeCodes.has(a.code)).map((a) => a.id)
          : []
      );
      const countedAsEmployee = (e: { ledgerAccountId: number | null; employeeId: number | null }) =>
        asOfContext.isHistorical &&
        e.employeeId == null &&
        e.ledgerAccountId != null &&
        legacyEmployeeLedgerIds.has(e.ledgerAccountId);

      const factoryVouchers = await db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            asOfContext.isHistorical
              ? sql`(${vouchers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${vouchers.deletedAt}`, asOfContext, "utc-naive-timestamp")})`
              : isNull(vouchers.deletedAt),
            asOfContext.isHistorical
              ? netPositionKnownTransactionThrough(
                  sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`,
                  sql`${vouchers.createdAt}`,
                  asOfContext,
                  "utc-naive-timestamp"
                )
              : sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${asOf}`
          )
        );

      const fVoucherIds = factoryVouchers.map((v) => v.id);
      const factoryEntries =
        fVoucherIds.length > 0
          ? await db
              .select()
              .from(voucherEntries)
              .where(
                and(
                  inArray(voucherEntries.voucherId, fVoucherIds),
                  asOfContext.isHistorical
                    ? netPositionVoucherEntryKnown(
                        sql`${voucherEntries.createdAt}`,
                        sql`${voucherEntries.voucherId}`,
                        asOfContext
                      )
                    : sql`TRUE`
                )
              )
          : [];

      const exactBalances = new Map<number, { debit: Decimal; credit: Decimal }>();
      for (const e of factoryEntries) {
        if (!e.ledgerAccountId || countedAsEmployee(e)) continue;
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
      // ── 2c. Customer balances — ALL customers, authoritative formula ─────────
      // Customer ledger accounts can carry premature CHARGE-PRE debits.
      // The Parties page and this page now share one reconciled projection.
      // To avoid counting a linked account twice we:
      //   a) exclude customer-owned ledger accounts from the ledger classification, and
      //   b) compute every customer's balance via the same formula as the Customers page.
      const allCustomersForNP = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.companyId, companyId),
            asOfContext.isHistorical
              ? sql`(${customers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${customers.deletedAt}`, asOfContext, "utc-naive-timestamp")})`
              : isNull(customers.deletedAt),
            asOfContext.isHistorical
              ? netPositionRecordedThrough(sql`${customers.createdAt}`, asOfContext, "utc-naive-timestamp")
              : sql`TRUE`
          )
        );

      // The previous code hid pre-finalization customer debits in the statement
      // while keeping them on Parties AND in the net-position account totals.
      // Exclude BOTH sides of the same premature voucher from this projected
      // dashboard (the trial balance remains the unmodified ledger).
      const heldSnapshot = await loadHeldChargeSnapshot(
        companyId,
        allCustomersForNP.map((c) => c.id),
        asOf,
        asOfContext.isHistorical ? asOfContext : undefined
      );
      let projectedAccountBalances = accBalances;
      if (heldSnapshot.voucherIds.size > 0) {
        const netByAccount = new Map<number, { debit: Decimal; credit: Decimal }>();
        for (const entry of factoryEntries) {
          if (!entry.ledgerAccountId || heldSnapshot.voucherIds.has(entry.voucherId) || countedAsEmployee(entry))
            continue;
          const current = netByAccount.get(entry.ledgerAccountId);
          netByAccount.set(entry.ledgerAccountId, {
            debit: toMoney(entry.debitAmount).plus(current?.debit ?? 0),
            credit: toMoney(entry.creditAmount).plus(current?.credit ?? 0),
          });
        }
        projectedAccountBalances = new Map(
          [...netByAccount].map(([id, value]) => [
            id,
            { debit: value.debit.toNumber(), credit: value.credit.toNumber() },
          ])
        );
      }

      // Revalue only specifically activated FX-agent ledger accounts for the
      // current/as-of Net Position display. No voucher/book amount is mutated.
      // If an account was changed outside the wallet, leave the historic book
      // balance visible and return a warning rather than invent an FX amount.
      const fxAgentWallets: Array<{
        accountId: number;
        name: string;
        eur: string;
        usd: string;
        currentUsd: string | null;
        rate: string | null;
        synchronized: boolean;
      }> = [];
      const fxAgentWalletWarnings: string[] = [];
      if (await fxAgentTablesExist()) {
        if (historyCoverage && asOfContext.isHistorical) {
          historyCoverage.gaps.push(...(await loadFxWalletHistoryGaps(companyId, asOfContext)));
        }
        const wallets = await loadFxAgentWallets(
          companyId,
          asOf,
          db,
          asOfContext.isHistorical ? asOfContext : undefined
        );
        projectedAccountBalances = new Map(projectedAccountBalances);
        for (const wallet of wallets) {
          const account = factoryAccounts.find((a) => a.id === wallet.ledgerAccountId);
          if (!account) continue;
          const rate = configFxRates.EUR ? String(configFxRates.EUR) : null;
          const projectedBook = toMoney(getAccountNetBalance(account as AccountLike, projectedAccountBalances));
          const snapshot = await getFxAgentWalletSnapshot(
            wallet,
            asOf,
            db,
            rate,
            asOfContext.isHistorical ? { scope: asOfContext, ledgerBookUsd: projectedBook.toFixed(6) } : undefined
          );
          const matching = snapshot.synchronized && projectedBook.minus(snapshot.state.totalBookUsd).abs().lte("0.01");
          fxAgentWallets.push({
            accountId: account.id,
            name: account.name,
            eur: snapshot.state.eur,
            usd: snapshot.state.usd,
            currentUsd: snapshot.currentUsd,
            rate,
            synchronized: matching,
          });
          if (!matching || snapshot.currentUsd === null) {
            fxAgentWalletWarnings.push(
              !matching
                ? account.name + ": FX wallet and posted ledger do not agree; showing historical ledger value"
                : account.name + ": Set EUR rate in Factory Settings to value this FX balance"
            );
            continue;
          }
          const change = toMoney(snapshot.currentUsd).minus(projectedBook);
          const before = projectedAccountBalances.get(account.id) || { debit: 0, credit: 0 };
          projectedAccountBalances.set(account.id, {
            debit: before.debit + (change.gt(0) ? change.toNumber() : 0),
            credit: before.credit + (change.lt(0) ? change.negated().toNumber() : 0),
          });
        }
      }
      const classified = classifyNetPositionAccounts(factoryAccounts as AccountLike[], projectedAccountBalances, {
        ledgerStockAccounts: ledgerStock,
        additionalExcludedCodes: factoryExcludedCodes,
        // Supplier-type ledger accounts are independently calculated.
        includeSupplierTypeAccounts: false,
      });

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
        // Stock credit balances are inventory contra-assets, not separate supplier debts.
        if (PERPETUAL_STOCK_ACCOUNT_CODES.has((a.code || "").trim().toUpperCase())) return false;
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
      const ledgerOnUsTotal = round2(ledgerOnUs.reduce((s: number, a) => s + a.value, 0));

      const customerItems: { name: string; balanceUsd: number; ledgerAccountId?: number }[] = [];

      if (allCustomersForNP.length > 0) {
        // Match the Parties page's combined ledger + operational balance exactly.
        const figures = await getCustomerLedgerAndMemo(
          companyId,
          allCustomersForNP.map((c) => c.id),
          asOf,
          asOfContext.isHistorical ? asOfContext : undefined
        );
        for (const c of allCustomersForNP) {
          const f = figures.get(c.id);
          const balance = (f?.ledger ?? new MoneyDecimal(0)).plus(f?.memoTotal ?? 0);
          if (balance.abs().gte(0.01))
            customerItems.push({
              name: c.legalName || `Customer #${c.id}`,
              balanceUsd: round2(balance.toNumber()),
              ledgerAccountId: c.ledgerAccountId || undefined,
            });
        }
      }

      // Inventory valuations - finished stock, raw material, stock on the
      // water and material in process - are computed in ./netPositionInventory.
      // Only Stock In Hand switches valuation mode; Balance on Table stays on
      // its original all-time blended raw-material cost basis.
      const valuationMode = req.query.valuationMode === "selling" ? "selling" : "cost";
      const {
        inventorySellValue: computedInventorySellValue,
        inventorySellingValue,
        rawMaterialStockValue: computedRawMaterialStockValue,
        stockOtwValue: computedStockOtwValue,
        balanceOnTableValue: computedBalanceOnTableValue,
      } = await computeNetPositionInventory({
        companyId,
        asOf,
        getConfigFx,
        configFxRates,
        supplierLockedRateMapNp,
        allContainersF,
      });

      // Only the historical report reconstructs OTW and scan/verification
      // lifecycle from dated events. The live/current Net Position keeps its
      // existing accepted behavior; no source orders or containers are edited.
      const historicalPipeline = asOfContext.isHistorical
        ? await loadHistoricalFactoryPipeline(companyId, asOfContext, getConfigFx)
        : null;
      const stockOtwValue = historicalPipeline?.stockOtwValue ?? computedStockOtwValue;

      // From the cut-over the ledger's factory stock accounts replace the computed
      // values (the selling-price view keeps its bale value, in place of the
      // ledger's finished goods at cost).
      const inventorySellValue = computedInventorySellValue;
      const rawMaterialStockValue = computedRawMaterialStockValue;
      const balanceOnTableValue = computedBalanceOnTableValue;

      // ── 4. Pending, Verified & Loading orders (upcoming receivables) ──────────
      // Verified and Loading orders are included in the dashboard's "What We Have"
      // at their current order values, even though they have not been invoiced.
      // Pending Verification stays informational. These are dashboard pipeline
      // values only: do not create or change ledger receivables here.
      //
      // Allocated bales are excluded from Stock In Hand by
      // computeNetPositionInventory, including bales still marked IN_STOCK,
      // so an order's allocated stock is not also valued as available inventory.
      const pendingVerifiedRows = historicalPipeline
        ? []
        : await db
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

      const pendingOrders =
        historicalPipeline?.pendingOrders ??
        pendingVerifiedRows.filter((r) => r.status === "PENDING_VERIFICATION").map(mapOrder);
      const verifiedOrders =
        historicalPipeline?.verifiedOrders ?? pendingVerifiedRows.filter((r) => r.status === "VERIFIED").map(mapOrder);
      const loadingOrders =
        historicalPipeline?.loadingOrders ?? pendingVerifiedRows.filter((r) => r.status === "LOADING").map(mapOrder);

      const pendingTotal =
        historicalPipeline?.pendingTotal ?? round2(pendingOrders.reduce((s, o) => s + o.grandTotal, 0));
      const verifiedTotal =
        historicalPipeline?.verifiedTotal ?? round2(verifiedOrders.reduce((s, o) => s + o.grandTotal, 0));
      const loadingTotal =
        historicalPipeline?.loadingTotal ?? round2(loadingOrders.reduce((s, o) => s + o.grandTotal, 0));

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
      // Also strip the "Factory Worker Advances" ledger account — its balance drifts from
      // reality because advance repayments/deductions aren't always posted back to it.
      // factory_worker_advances.remaining_balance (used by the Payroll & Benefits "Advances"
      // KPI) is the authoritative source; we recompute it fresh below instead.
      const cleanLedgerForUs = ledgerForUs.filter(
        (a) =>
          !PERPETUAL_STOCK_ACCOUNT_CODES.has((a.code || "").trim().toUpperCase()) &&
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
      let workerAdvancesValue: number;
      if (historicalAssets) {
        workerAdvancesValue = historicalAssets.workerAdvancesValue;
      } else {
        const workerAdvRes = await db.execute(sql`
          SELECT COALESCE(SUM(remaining_balance::numeric), 0) AS total
          FROM factory_worker_advances
          WHERE company_id = ${companyId} AND remaining_balance > 0
        `);
        const workerAdvRow = resultRows(workerAdvRes)[0] ?? {};
        workerAdvancesValue = round2(toMoney(String(workerAdvRow.total ?? "0")).toNumber());
      }

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
      const prepaidRent = historicalAssets?.prepaidRent ?? (await computeLiveFactoryPrepaidRent(companyId, asOf));
      const rentPayable = historicalAssets?.rentPayable ?? 0;

      // One signed, dated Employee projection shared with payroll-breakdown.
      // Today preserves employees.current_balance; historical dates replay
      // opening + recorded vouchers and do not subtract from today's cache.
      let salariesPayableExact = new MoneyDecimal(0);
      let receivablesExact = new MoneyDecimal(0);
      const employeeReceivableItems: { name: string; balanceUsd: number }[] = [];
      for (const employee of employeeBalances) {
        const bal = toMoney(employee.balance);
        if (bal.greaterThan(0)) salariesPayableExact = salariesPayableExact.plus(bal);
        else if (bal.lessThan(0)) {
          receivablesExact = receivablesExact.plus(bal.abs());
          if (employee.name)
            employeeReceivableItems.push({
              name: employee.name,
              balanceUsd: bal.abs().toNumber(),
            });
        }
      }
      const employeeSalariesPayable = round2(salariesPayableExact.toNumber());
      const employeeReceivablesTotal = round2(receivablesExact.toNumber());

      // forUsTotal: ledger assets + inventory + raw material + balance on table + stock OTW
      //             + customer receivables (DR) + verified orders + loading orders
      //             + overpaid suppliers (they owe us the overpayment back)
      //             + prepaidRent (we overpaid our landlord → asset)
      //             + employee receivables (negative employee balances — they owe us back)
      //             (allocated bales are excluded from baleInventoryValue — no double-count)
      const totalSupplierOverpaymentsRounded = round2(totalSupplierOverpayments);
      const forUsTotal = round2(
        cleanLedgerForUsTotal +
          baleInventoryValue +
          rawMaterialStockValue +
          selectedBalanceOnTableValue +
          stockOtwValue +
          totalCustomerDr +
          // Operational net-position projection: count VERIFIED and LOADING
          // orders once, at their displayed selling totals. No accounting
          // receivable is posted until actual finalization; PENDING is excluded.
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
      const verifiedOrderEntry = {
        name: "Verified Orders (Not Invoiced)",
        code: "VERIFIED_ORDERS",
        value: verifiedTotal,
        category: "Uninvoiced Orders",
      };
      const loadingOrderEntry = {
        name: "Loading Orders (In Progress)",
        code: "LOADING_ORDERS",
        value: loadingTotal,
        category: "Uninvoiced Orders",
      };

      const forUsAccounts = [
        factoryInventoryEntry,
        factoryRawMaterialEntry,
        ...(selectedBalanceOnTableValue > 0 ? [factoryBalanceOnTableEntry] : []),
        ...(stockOtwValue > 0 ? [factoryStockOtwEntry] : []),
        ...(verifiedOrders.length > 0 ? [verifiedOrderEntry] : []),
        ...(loadingOrders.length > 0 ? [loadingOrderEntry] : []),
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

      const responseBody = {
        asOf,
        fxAgentWallets,
        fxAgentWalletWarnings,
        forUsTotal,
        onUsTotal,
        netPosition,
        netPositionLabel: netPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
        forUs: { total: forUsTotal, breakdown: forUsBreakdown, accounts: forUsAccounts },
        onUs: { total: onUsTotal, breakdown: onUsBreakdown, accounts: onUsAccounts },
        supplierLiabilities: round2(totalSupplierLiabilities),
        supplierOverpayments: round2(totalSupplierOverpayments),
        stockOtwValue,
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
      };

      res.json(
        await finishFactoryNetPosition({
          companyId,
          scope: asOfContext,
          body: responseBody,
          valuationMode,
          historyCoverage,
          pipelineWarnings: historicalPipeline?.warnings ?? [],
          assetWarnings: historicalAssets?.warnings ?? [],
        })
      );
    } catch (error: unknown) {
      if (error instanceof FactoryNetPositionDateError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      logger.error("Factory net-position error:", { error: error });
      if (historicalRequest || (error instanceof Error && error.message.startsWith("HISTORICAL_"))) {
        const fxMissing = error instanceof Error && error.message.startsWith("Missing confirmed USD exchange rate");
        return res.status(503).json({
          code: "HISTORICAL_NET_POSITION_UNAVAILABLE",
          message:
            "The historical snapshot could not be constructed. No current-day balance was substituted." +
            (fxMissing ? ` ${(error as Error).message} known by the selected date.` : ""),
        });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Payroll Payable Breakdown (view-only, for Net Position page) ────────────
  // GET /api/factory/net-position/payroll-breakdown
  // Returns one row per active employee whose currentBalance > 0.
  // This endpoint is purely informational and does NOT affect any Net Position
  // calculation, account, or balance — it is read-only.
}
