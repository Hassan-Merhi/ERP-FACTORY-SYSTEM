// Extracted from ./useUnifiedRentalAccountingState.tsx

export type Mod = "ERP" | "FACTORY" | "PROPERTIES";

type Contract = {
  id: number;
  unitId: number;
  unitNumber: string;
  unitType: string;
  locationGroup: string;
  tenantName: string;
  status: string;
  currency: string;
  monthlyRent: string;
  startDate: string;
  endDate: string | null;
  internal: boolean;
  perspective?: "TENANT" | "LANDLORD";
  linkedCompanyId: number | null;
};

export type Contracts = { module: Mod; perspective: "MIXED_BY_CONTRACT"; contracts: Contract[]; limitedTo: number };

type Period = {
  ledgerRowId: number | null;
  year: number;
  month: number;
  dueDate: string;
  expected: string;
  paid: string;
  outstanding: string;
  overpayment: string;
  scheduled: string;
  accrualVoucherId: number | null;
  accrualStale: boolean;
  usedPrepaidAccount: boolean;
  usedAdvanceAccount: boolean;
  cachedPaid: string | null;
  cacheDifference: string | null;
  status: string;
  postedPaymentIds: number[];
};

export type Payment = {
  id: number;
  date: string;
  period: string;
  status: string;
  amount: string;
  currency: string;
  historicalRate: string;
  voucherId: number | null;
  voucherNumber: string | null;
  groupId: string | null;
  isGuaranteeActivity: boolean;
  ledgerRowId: number | null;
};

export type Guarantee = {
  contractPledgeNative: string;
  statementFlag: boolean;
  statedPostedNative: string | null;
  ledgerEvidenceUsd: string;
  vouchers: Array<{
    voucherId: number;
    voucherNumber: string;
    date: string;
    accountCode: string | null;
    signedUsd: string;
  }>;
};

export type Expense = {
  id: number;
  voucherId: number;
  voucherNumber: string | null;
  category: string;
  amountUsd: string;
  note: string | null;
  sourceStatus: "active" | "reversed" | "retired" | "optional";
};

export type Detail = {
  module: Mod;
  perspective: "TENANT" | "LANDLORD";
  asOfDate: string;
  contract: Contract;
  totals: {
    expectedDue: string;
    postedAgainstDue: string;
    outstanding: string;
    advanceFuturePeriods: string;
    scheduledNotPosted: string;
    maintenanceExpensesBaseUsd: string;
    depositPledgeNative: string;
    depositBalanceEvidenceUsd: string;
  };
  periods: Period[];
  payments: Payment[];
  guarantee: Guarantee;
  expenses: Expense[];
  warnings: string[];
  limitations: Record<string, string>;
};

export type Category = "maintenance" | "repairs" | "utilities" | "insurance" | "property_tax" | "other_property_cost";
