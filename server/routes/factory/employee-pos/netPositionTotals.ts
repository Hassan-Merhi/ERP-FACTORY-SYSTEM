// Extracted from ./employeeNetPositionRoutes.ts: FX movements, receivables, payables and the Factory Net Position totals.
import { computeLiveFactoryRentalPositions } from "./netPositionLiveRent";
import { db } from "../../../db";
import { PERPETUAL_STOCK_ACCOUNT_CODES } from "../../../netPositionHelper";
import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { loadFactoryNetPositionEmployees } from "../../../services/factory/netPositionEmployees";
import type { computeHistoricalFactoryAssetLiabilityOperations } from "../../../services/factory/netPositionHistoricalAssets";
import type { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import type { loadNetPositionLedgerBalances } from "./netPositionLedgerBalances";
import type { classifyFactoryNetPositionLedger } from "./netPositionLedgerClassification";
import type { loadFactoryNetPositionPipeline } from "./netPositionPipeline";

type ClassifyFactoryNetPositionLedgerResult = Awaited<ReturnType<typeof classifyFactoryNetPositionLedger>>;
type ComputeHistoricalFactoryAssetLiabilityOperationsResult = Awaited<
  ReturnType<typeof computeHistoricalFactoryAssetLiabilityOperations>
>;
type ComputeNetPositionSupplierBalancesResult = Awaited<ReturnType<typeof computeNetPositionSupplierBalances>>;
type LoadFactoryNetPositionEmployeesResult = Awaited<ReturnType<typeof loadFactoryNetPositionEmployees>>;
type LoadFactoryNetPositionPipelineResult = Awaited<ReturnType<typeof loadFactoryNetPositionPipeline>>;
type LoadNetPositionLedgerBalancesResult = Awaited<ReturnType<typeof loadNetPositionLedgerBalances>>;

export async function computeFactoryNetPositionTotals({
  round2,
  valuationMode,
  inventorySellingValue,
  inventorySellValue,
  balanceOnTableValue,
  ledgerForUs,
  ledgerOnUs,
  walletFxDifferences,
  supplierFxGainUsd,
  supplierFxLossUsd,
  supplierItems,
  historicalAssets,
  companyId,
  customerItems,
  asOf,
  employeeBalances,
  totalSupplierOverpayments,
  rawMaterialStockValue,
  stockOtwValue,
  verifiedTotal,
  loadingTotal,
  ledgerOnUsTotal,
  supplierLiabilitiesAtHistoricBasis,
}: {
  round2: (n: number) => number;
  valuationMode: LoadFactoryNetPositionPipelineResult["valuationMode"];
  inventorySellingValue: LoadFactoryNetPositionPipelineResult["inventorySellingValue"];
  inventorySellValue: LoadFactoryNetPositionPipelineResult["inventorySellValue"];
  balanceOnTableValue: LoadFactoryNetPositionPipelineResult["balanceOnTableValue"];
  ledgerForUs: ClassifyFactoryNetPositionLedgerResult["ledgerForUs"];
  ledgerOnUs: ClassifyFactoryNetPositionLedgerResult["ledgerOnUs"];
  walletFxDifferences: LoadNetPositionLedgerBalancesResult["walletFxDifferences"];
  supplierFxGainUsd: number;
  supplierFxLossUsd: number;
  supplierItems: ComputeNetPositionSupplierBalancesResult["supplierItems"];
  historicalAssets: ComputeHistoricalFactoryAssetLiabilityOperationsResult | null;
  companyId: number;
  customerItems: ClassifyFactoryNetPositionLedgerResult["customerItems"];
  asOf: string;
  employeeBalances: LoadFactoryNetPositionEmployeesResult;
  totalSupplierOverpayments: ComputeNetPositionSupplierBalancesResult["totalSupplierOverpayments"];
  rawMaterialStockValue: LoadFactoryNetPositionPipelineResult["rawMaterialStockValue"];
  stockOtwValue: LoadFactoryNetPositionPipelineResult["stockOtwValue"];
  verifiedTotal: LoadFactoryNetPositionPipelineResult["verifiedTotal"];
  loadingTotal: LoadFactoryNetPositionPipelineResult["loadingTotal"];
  ledgerOnUsTotal: ClassifyFactoryNetPositionLedgerResult["ledgerOnUsTotal"];
  supplierLiabilitiesAtHistoricBasis: number;
}) {
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
  // Only count wallet FX when its source account actually survives the
  // authoritative Net Position classifier and suppression rules.
  const presentedLedgerIds = new Set(
    [...cleanLedgerForUs, ...ledgerOnUs].filter((a) => a.id !== undefined).map((a) => a.id)
  );
  const visibleWalletFx = [...walletFxDifferences.entries()]
    .filter(([id]) => presentedLedgerIds.has(id))
    .map(([id, movement]) => ({ ...movement, sourceKey: `ledger:${id}` }));
  const walletFxGainUsd = round2(visibleWalletFx.reduce((sum, wallet) => sum + Math.max(0, wallet.delta), 0));
  const walletFxLossUsd = round2(visibleWalletFx.reduce((sum, wallet) => sum + Math.max(0, -wallet.delta), 0));
  const fxGainUsd = round2(supplierFxGainUsd + walletFxGainUsd);
  const fxLossUsd = round2(supplierFxLossUsd + walletFxLossUsd);
  const fxGainBreakdown = [
    ...supplierItems
      .filter((item) => (item.fxBasisAdjustmentUsd ?? 0) > 0)
      .map((item) => ({
        label: `Supplier: ${item.name}`,
        native: "",
        usd: round2(item.fxBasisAdjustmentUsd ?? 0),
        sourceKey: item.supplierId ? `supplier:${item.supplierId}` : undefined,
      })),
    ...visibleWalletFx
      .filter((wallet) => wallet.delta > 0)
      .map((wallet) => ({
        label: `FX Agent: ${wallet.name}`,
        native: "EUR",
        usd: wallet.delta,
        sourceKey: wallet.sourceKey,
      })),
  ];
  const fxLossBreakdown = [
    ...supplierItems
      .filter((item) => (item.fxBasisAdjustmentUsd ?? 0) < 0)
      .map((item) => ({
        label: `Supplier: ${item.name}`,
        native: "",
        usd: round2(-(item.fxBasisAdjustmentUsd ?? 0)),
        sourceKey: item.supplierId ? `supplier:${item.supplierId}` : undefined,
      })),
    ...visibleWalletFx
      .filter((wallet) => wallet.delta < 0)
      .map((wallet) => ({
        label: `FX Agent: ${wallet.name}`,
        native: "EUR",
        usd: -wallet.delta,
        sourceKey: wallet.sourceKey,
      })),
  ];

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

  // ── Factory shop rent: prepaid asset versus unpaid-rent liability ─────
  // Match Shop Rentals' credit by counting only POSTED rent paid in excess
  // of billing-day-aware expected rent. Do not add outstanding rent to
  // Prepaid Rent: unpaid contracts belong in Rent Payable on the other side.
  const liveRent = historicalAssets ? null : await computeLiveFactoryRentalPositions(companyId, asOf);
  const prepaidRent = historicalAssets?.prepaidRent ?? liveRent?.prepaidRent ?? 0;
  const rentPayable = historicalAssets?.rentPayable ?? liveRent?.rentPayable ?? 0;

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
      workerAdvancesValue +
      fxGainUsd
  );

  // onUsTotal: ledger liabilities + supplier balances + customer credit balances (CR) + employee salaries + rent payable
  const onUsTotal = round2(
    ledgerOnUsTotal +
      supplierLiabilitiesAtHistoricBasis +
      fxLossUsd +
      totalCustomerCr +
      employeeSalariesPayable +
      rentPayable
  );
  const netPosition = round2(forUsTotal - onUsTotal);

  return {
    baleInventoryValue,
    selectedBalanceOnTableValue,
    cleanLedgerForUs,
    cleanLedgerForUsTotal,
    walletFxGainUsd,
    walletFxLossUsd,
    fxGainUsd,
    fxLossUsd,
    fxGainBreakdown,
    fxLossBreakdown,
    workerAdvancesValue,
    customerDrItems,
    customerCrItems,
    totalCustomerCr,
    prepaidRent,
    rentPayable,
    employeeReceivableItems,
    employeeSalariesPayable,
    forUsTotal,
    onUsTotal,
    netPosition,
  };
}
