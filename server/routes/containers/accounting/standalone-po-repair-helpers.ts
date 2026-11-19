// Extracted from ./standalone-po-repair.ts
import { storage } from "../../../storage";

export interface StandaloneRepairSummary {
  handled: boolean;
  scannedPOs: number;
  repairedStandaloneSupplierVouchers: number;
  normalizedStandaloneParentFreight: number;
  skipped: string[];
  errors: string[];
}

export async function isStandaloneErpCompany(companyId: number): Promise<boolean> {
  const [company, allCompanies, legacyParentCompanyId] = await Promise.all([
    storage.getCompanyById(companyId),
    storage.getAllCompanies(),
    storage.getParentCompanyId(),
  ]);

  if (!company) return false;
  if (company.parentCompanyId) return false;

  // The legacy global parent setting may identify the root company itself, but
  // it must never turn another unlinked company into a subsidiary.
  if (legacyParentCompanyId === companyId) return false;

  // A root company that is explicitly referenced by a child is also not a
  // standalone company, even if the old global parent setting is stale.
  if (allCompanies.some((candidate) => candidate.parentCompanyId === companyId)) return false;

  return true;
}

export function normalizedUsdFields(debit: number, credit: number) {
  return {
    debitAmount: debit.toFixed(2),
    creditAmount: credit.toFixed(2),
    transactionCurrency: "USD",
    transactionDebitAmount: debit.toFixed(6),
    transactionCreditAmount: credit.toFixed(6),
    baseDebitAmount: debit.toFixed(6),
    baseCreditAmount: credit.toFixed(6),
    historicalExchangeRate: "1.0000000000",
    rateConvention: "IDENTITY",
  } as const;
}
