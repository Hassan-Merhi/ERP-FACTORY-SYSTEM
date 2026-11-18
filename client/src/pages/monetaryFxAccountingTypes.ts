// Response shapes of the /api/accounting/monetary-fx endpoints (moved out of MonetaryFxAccounting.tsx).
export type Domain = "customer" | "supplier" | "factory_supplier";
export type Account = { accountKind: "bank" | "ledger"; accountId: number; name: string };
export type Rate = {
  currency: string;
  baseCurrency: string;
  effectiveDate: string;
  rateBasePerUnit: string;
  rateUnitPerBase: string;
  source: string;
  rateId: number | null;
};
export type RateMatrix = {
  asOfDate: string;
  baseCurrency: string;
  rates: Array<{ currency: string; rate: Rate | null }>;
};
export type Bucket = {
  currency: string;
  nativeBalance: string;
  historicalUsdBasis: string;
  rate: Rate | null;
  translatedUsd: string | null;
  unrealizedDifferenceUsd: string | null;
  verified: boolean;
  issues: string[];
  journalTreatment: string;
};
export type Valuation = {
  accountName: string;
  accountKind: string;
  asOfDate: string;
  accountId: number;
  buckets: Bucket[];
  totals: {
    historicalUsd: string;
    translatedUsd: string | null;
    unrealizedDifferenceUsd: string | null;
    unresolvedCurrencies: string[];
    posting: string;
  };
};
export type Realized = {
  matchId: number;
  domain: Domain;
  partyId: number;
  nativeCurrency: string;
  nativeMatchedAmount: string;
  chargeVoucher: string;
  settlementVoucher: string;
  chargeHistoricalUsd: string;
  settlementHistoricalUsd: string;
  realizedGainUsd: string;
  status: "ready" | "no_difference" | "recognized" | "reversed" | "blocked";
  postable: boolean;
  issue: string | null;
  recognitionVoucherId: number | null;
};
export type RealizedList = {
  items: Realized[];
  asOfDate: string;
  limitedToMostRecent: number;
  recognitionStatusAsOf: boolean;
  asOfLimitations: string;
};
