import { tradingProvisioningMessages } from "./tradingProvisioningMessages";

/**
 * Stable identities for automatically provisioned at-cost Properties -> ERP
 * container trading. Never guess an existing ledger by name alone: only a
 * verified relationship ID or this exact company-scoped code is reusable.
 */
export type TradingAccountKey =
  | "sourceReceivableAccountId"
  | "destinationPayableAccountId"
  | "sourceSalesAccountId"
  | "sourcePurchaseAccountId"
  | "sourceCostAccountId"
  | "sourceChargeAccrualAccountId"
  | "destinationGitAccountId";

export type TradingAccountSpec = {
  field: TradingAccountKey;
  companyId: number;
  code: string;
  name: string;
  accountType: "Asset" | "Liability" | "Income" | "Expense";
};

export function tradingAccountSpecs(
  source: { id: number; name: string },
  destination: { id: number; name: string }
): TradingAccountSpec[] {
  return [
    {
      field: "sourceReceivableAccountId",
      companyId: source.id,
      code: `IC-AR-${destination.id}`,
      name: `Intercompany Receivable - ${destination.name}`,
      accountType: "Asset",
    },
    {
      field: "destinationPayableAccountId",
      companyId: destination.id,
      code: `IC-AP-${source.id}`,
      name: `Intercompany Payable - ${source.name}`,
      accountType: "Liability",
    },
    {
      field: "sourceSalesAccountId",
      companyId: source.id,
      code: `IC-SALES-${destination.id}`,
      name: `Intercompany Sales - ${destination.name}`,
      accountType: "Income",
    },
    {
      field: "sourcePurchaseAccountId",
      companyId: source.id,
      code: `IC-PURCH-${destination.id}`,
      name: `Original Purchases for ${destination.name}`,
      accountType: "Expense",
    },
    {
      field: "sourceCostAccountId",
      companyId: source.id,
      code: `IC-COGS-${destination.id}`,
      name: `Intercompany Cost of Goods Sold - ${destination.name}`,
      accountType: "Expense",
    },
    {
      field: "sourceChargeAccrualAccountId",
      companyId: source.id,
      code: `IC-CHARGE-${destination.id}`,
      name: `Confirmed Container Charges Payable - ${destination.name}`,
      accountType: "Liability",
    },
    {
      field: "destinationGitAccountId",
      companyId: destination.id,
      code: `IC-GIT-${source.id}`,
      name: `Intercompany Goods in Transit - ${source.name}`,
      accountType: "Asset",
    },
  ];
}

export function propertiesSupplierCode(sourceId: number, destinationId: number): string {
  return `IC-PROP-${sourceId}-${destinationId}`;
}

export function normalizedTradingName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function uniquePropertiesSupplier<T extends { legalName: string; active: boolean; deletedAt: Date | null }>(
  suppliers: T[],
  sourceName: string
): T | undefined {
  const matches = suppliers.filter(
    (supplier) => normalizedTradingName(supplier.legalName) === normalizedTradingName(sourceName)
  );
  if (matches.length > 1) throw new Error(tradingProvisioningMessages.duplicateSupplier);
  const supplier = matches[0];
  if (supplier && (!supplier.active || supplier.deletedAt)) {
    throw new Error(tradingProvisioningMessages.inactiveSupplier);
  }
  return supplier;
}
