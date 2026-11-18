// Extracted from ./UnifiedAccountingDashboard.tsx to keep that module under the source-size cap.

export interface Line {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  category: string;
  amountUsd: string;
  openingSideAssumed: boolean;
  currentSourceIsMutable: boolean;
}

type Classes = {
  cash_and_banks: string;
  customer_and_party: string;
  recognized_inventory: string;
  fixed_assets: string;
  other: string;
};

export interface Dashboard {
  companyId: number;
  asOfDate: string;
  fromDate: string;
  currency: "USD";
  presentation: "STANDALONE_BOOKED_NOT_GROUP_CONSOLIDATED";
  source: string;
  financialPosition: {
    assetsUsd: string;
    liabilitiesUsd: string;
    netAssetsUsd: string;
    equityIncludingEarningsUsd: string;
    reportedBalanceSheetDifferenceUsd: string;
    unexplainedDifferenceUsd: string;
    trialBalanceDifferenceUsd: string;
    cashAndBanksUsd: string;
    liabilitiesAndEquityUsd: string;
    assetClasses: Classes;
    liabilityClasses: Classes;
    unclassifiedUsd: string;
    unclassifiedAccounts: number;
    isBalanced: boolean;
  };
  performance: {
    salesRevenueUsd: string;
    otherIncomeUsd: string;
    costOfSalesUsd: string;
    operatingExpensesUsd: string;
    grossProfitUsd: string;
    netProfitUsd: string;
    recognizedCashMovementUsd: string;
    cashFlowClassificationDifferenceUsd: string;
  };
  controls: {
    certified: false;
    trialBalanceBalanced: boolean;
    perpetualPostingGloballyReady: boolean;
    blockers: string[];
    warnings: string[];
  };
  operations: {
    requestedValuationBasis: "cost" | "selling";
    financialStatementValuationBasis: "historical_booked_cost";
    perpetualStockLedgerActiveAsOf: boolean;
    cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
    erpStock: {
      costUsd: string;
      subLedgerSignedUsd: string;
      asOfBasis: "as-of" | "current";
      shortageValueUsd: string;
      unitemizedMovementValueUsd: string;
      anomalousRows: number;
      locations: number;
    } | null;
    factoryStock: {
      rawUsd: string;
      wipUsd: string;
      finishedUsd: string;
      totalUsd: string;
      unvaluedCount: number;
      unvaluedSample: Array<{ source: string; id: number; reason: string }>;
      reservedForOrders: { bales: number; cost: string };
      soldNotInvoiced: { bales: number; cost: string };
      basis: "CURRENT_COST_ONLY";
    } | null;
    bookedStockAssetUsd: string;
    managementCostCandidateUsd: string | null;
    managementCostCandidateBasis:
      "CURRENT_COST_MEMO" | "WITHHELD_MIXED_DATES" | "WITHHELD_INCOMPLETE_COST" | "NOT_LOADED";
    managementSellingValueUsd: null;
    managementSellingValueAvailableIn: string;
    glToOperationalAtCost: Array<{
      accountCode: string;
      bookedGlUsd: string;
      operationalCostUsd: string | null;
      differenceUsd: string | null;
      comparable: boolean;
      reason: string;
    }>;
    operationalAmountsAddedToBookedNetAssets: false;
    completeness: {
      factoryHistoricalValuationAvailable: boolean;
      erpHistoricalValuationAvailable: boolean;
      stockCostFullyValued: boolean;
    };
    warnings: string[];
  };
  drilldown: {
    topAssetAccounts: Line[];
    topLiabilities: Line[];
    topRevenueAccounts: Line[];
    topCostAccounts: Line[];
    topExpenses: Line[];
  };
  disclosures: string[];
  reportStatus: "PROVISIONAL_NOT_CERTIFIED";
  historicalFx: {
    ready: boolean;
    legacyCompatibilityMode: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    unresolvedLedgerOpeningCount: number;
    unresolvedBankOpeningCount: number;
    unresolvedCustomerOpeningCount: number;
    unresolvedSupplierOpeningCount: number;
    certified: false;
    caveat: string;
  };
}

export const money = (v: string) =>
  Number(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const classNames: Record<keyof Classes, string> = {
  cash_and_banks: "Cash & banks",
  customer_and_party: "Customer / party accounts",
  recognized_inventory: "Recognized stock accounts",
  fixed_assets: "Fixed assets",
  other: "Other accounts",
};

const classes = Object.keys(classNames) as Array<keyof Classes>;

export async function read(url: string): Promise<Dashboard> {
  const res = await fetch(url, { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? "Dashboard data could not be loaded");
  return body as Dashboard;
}

export function Value({ label, value, explain }: { label: string; value: string; explain?: string }) {
  return (
    <div className="min-w-0 border-b pb-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg sm:text-xl font-semibold tabular-nums">
        {money(value)} <span className="text-xs font-normal">USD</span>
      </p>
      {explain && <p className="text-xs text-muted-foreground">{explain}</p>}
    </div>
  );
}

export function Breakdown({ title, totals }: { title: string; totals: Classes }) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      {classes.map((cat) => (
        <div key={cat} className="flex justify-between gap-3 text-sm border-b py-1">
          <span>{classNames[cat]}</span>
          <span className="tabular-nums">{money(totals[cat])}</span>
        </div>
      ))}
    </div>
  );
}
