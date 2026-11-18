// Extracted from ./employeeNetPositionRoutes.ts: the Factory Net Position asset/liability rows and response body.
import type { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import type { loadNetPositionLedgerBalances } from "./netPositionLedgerBalances";
import type { classifyFactoryNetPositionLedger } from "./netPositionLedgerClassification";
import type { loadFactoryNetPositionPipeline } from "./netPositionPipeline";
import type { computeFactoryNetPositionTotals } from "./netPositionTotals";

type ClassifyFactoryNetPositionLedgerResult = Awaited<ReturnType<typeof classifyFactoryNetPositionLedger>>;
type ComputeFactoryNetPositionTotalsResult = Awaited<ReturnType<typeof computeFactoryNetPositionTotals>>;
type ComputeNetPositionSupplierBalancesResult = Awaited<ReturnType<typeof computeNetPositionSupplierBalances>>;
type LoadFactoryNetPositionPipelineResult = Awaited<ReturnType<typeof loadFactoryNetPositionPipeline>>;
type LoadNetPositionLedgerBalancesResult = Awaited<ReturnType<typeof loadNetPositionLedgerBalances>>;

export function buildFactoryNetPositionBody({
  baleInventoryValue,
  rawMaterialStockValue,
  selectedBalanceOnTableValue,
  stockOtwValue,
  verifiedTotal,
  loadingTotal,
  verifiedOrders,
  loadingOrders,
  fxGainUsd,
  fxGainBreakdown,
  cleanLedgerForUs,
  round2,
  customerDrItems,
  supplierItems,
  prepaidRent,
  employeeReceivableItems,
  workerAdvancesValue,
  ledgerOnUs,
  fxLossUsd,
  fxLossBreakdown,
  employeeSalariesPayable,
  customerCrItems,
  rentPayable,
  supplierLiabilitiesAtHistoricBasis,
  totalCustomerCr,
  asOf,
  fxAgentWallets,
  fxAgentWalletWarnings,
  forUsTotal,
  onUsTotal,
  netPosition,
  totalSupplierLiabilities,
  supplierFxGainUsd,
  supplierFxLossUsd,
  walletFxGainUsd,
  walletFxLossUsd,
  totalSupplierOverpayments,
  valuationMode,
  cleanLedgerForUsTotal,
  pendingOrders,
  pendingTotal,
  ledgerOnUsTotal,
}: {
  baleInventoryValue: ComputeFactoryNetPositionTotalsResult["baleInventoryValue"];
  rawMaterialStockValue: LoadFactoryNetPositionPipelineResult["rawMaterialStockValue"];
  selectedBalanceOnTableValue: ComputeFactoryNetPositionTotalsResult["selectedBalanceOnTableValue"];
  stockOtwValue: LoadFactoryNetPositionPipelineResult["stockOtwValue"];
  verifiedTotal: LoadFactoryNetPositionPipelineResult["verifiedTotal"];
  loadingTotal: LoadFactoryNetPositionPipelineResult["loadingTotal"];
  verifiedOrders: LoadFactoryNetPositionPipelineResult["verifiedOrders"];
  loadingOrders: LoadFactoryNetPositionPipelineResult["loadingOrders"];
  fxGainUsd: ComputeFactoryNetPositionTotalsResult["fxGainUsd"];
  fxGainBreakdown: ComputeFactoryNetPositionTotalsResult["fxGainBreakdown"];
  cleanLedgerForUs: ComputeFactoryNetPositionTotalsResult["cleanLedgerForUs"];
  round2: (n: number) => number;
  customerDrItems: ComputeFactoryNetPositionTotalsResult["customerDrItems"];
  supplierItems: ComputeNetPositionSupplierBalancesResult["supplierItems"];
  prepaidRent: ComputeFactoryNetPositionTotalsResult["prepaidRent"];
  employeeReceivableItems: ComputeFactoryNetPositionTotalsResult["employeeReceivableItems"];
  workerAdvancesValue: ComputeFactoryNetPositionTotalsResult["workerAdvancesValue"];
  ledgerOnUs: ClassifyFactoryNetPositionLedgerResult["ledgerOnUs"];
  fxLossUsd: ComputeFactoryNetPositionTotalsResult["fxLossUsd"];
  fxLossBreakdown: ComputeFactoryNetPositionTotalsResult["fxLossBreakdown"];
  employeeSalariesPayable: ComputeFactoryNetPositionTotalsResult["employeeSalariesPayable"];
  customerCrItems: ComputeFactoryNetPositionTotalsResult["customerCrItems"];
  rentPayable: ComputeFactoryNetPositionTotalsResult["rentPayable"];
  supplierLiabilitiesAtHistoricBasis: number;
  totalCustomerCr: ComputeFactoryNetPositionTotalsResult["totalCustomerCr"];
  asOf: string;
  fxAgentWallets: LoadNetPositionLedgerBalancesResult["fxAgentWallets"];
  fxAgentWalletWarnings: LoadNetPositionLedgerBalancesResult["fxAgentWalletWarnings"];
  forUsTotal: ComputeFactoryNetPositionTotalsResult["forUsTotal"];
  onUsTotal: ComputeFactoryNetPositionTotalsResult["onUsTotal"];
  netPosition: ComputeFactoryNetPositionTotalsResult["netPosition"];
  totalSupplierLiabilities: ComputeNetPositionSupplierBalancesResult["totalSupplierLiabilities"];
  supplierFxGainUsd: number;
  supplierFxLossUsd: number;
  walletFxGainUsd: ComputeFactoryNetPositionTotalsResult["walletFxGainUsd"];
  walletFxLossUsd: ComputeFactoryNetPositionTotalsResult["walletFxLossUsd"];
  totalSupplierOverpayments: ComputeNetPositionSupplierBalancesResult["totalSupplierOverpayments"];
  valuationMode: LoadFactoryNetPositionPipelineResult["valuationMode"];
  cleanLedgerForUsTotal: ComputeFactoryNetPositionTotalsResult["cleanLedgerForUsTotal"];
  pendingOrders: LoadFactoryNetPositionPipelineResult["pendingOrders"];
  pendingTotal: LoadFactoryNetPositionPipelineResult["pendingTotal"];
  ledgerOnUsTotal: ClassifyFactoryNetPositionLedgerResult["ledgerOnUsTotal"];
}) {
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
    ...(fxGainUsd > 0
      ? [
          {
            name: "Unrealized FX Gains",
            code: "FX_UNREALIZED_GAIN",
            value: fxGainUsd,
            category: "Exchange Rate Gains",
            breakdown: fxGainBreakdown,
          },
        ]
      : []),
    ...cleanLedgerForUs.sort((a, b) => b.value - a.value).map((a) => ({ ...a, value: round2(a.value) })),
    ...customerDrItems
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
      .map((c) => ({
        ...(c.ledgerAccountId ? { id: c.ledgerAccountId } : {}),
        name: c.name,
        code: "CUSTOMER_DR",
        partyKind: "customer",
        partyId: c.customerId,
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
        value: round2(s.balanceUsd + (s.fxBasisAdjustmentUsd ?? 0)),
        category: "Supplier",
        breakdown: s.breakdown,
      })),
    ...(fxLossUsd > 0
      ? [
          {
            name: "Unrealized FX Losses",
            code: "FX_UNREALIZED_LOSS",
            value: fxLossUsd,
            category: "Exchange Rate Losses",
            breakdown: fxLossBreakdown,
          },
        ]
      : []),
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
        partyKind: "customer",
        partyId: c.customerId,
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
  mergedLedgerOnUsGrouped["Liability"] = round2((mergedLedgerOnUsGrouped["Liability"] || 0) + employeeSalariesPayable);
  const onUsBreakdown = [
    ...(supplierLiabilitiesAtHistoricBasis > 0
      ? [{ name: "Suppliers", value: supplierLiabilitiesAtHistoricBasis }]
      : []),
    ...(fxLossUsd > 0 ? [{ name: "Exchange Rate Losses", value: fxLossUsd }] : []),
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
    supplierLiabilities: supplierLiabilitiesAtHistoricBasis,
    supplierLiabilitiesCurrentRate: round2(totalSupplierLiabilities),
    supplierFxGain: supplierFxGainUsd,
    supplierFxLoss: supplierFxLossUsd,
    walletFxGain: walletFxGainUsd,
    walletFxLoss: walletFxLossUsd,
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

  return { responseBody };
}
