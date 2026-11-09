import type { Company } from "@/contexts/CompanyContext";

/**
 * Read-only reporting exception. The immutable company ID must be provisioned
 * from verified company data, never inferred from the mutable display name.
 *
 * The identifier is intentionally not guessed here: the source audit does not
 * establish Hassan Properties' actual company ID. Until configured, the special
 * historical view remains disabled rather than being assigned to the wrong
 * company's ledger. See the Phase 3 execution tracker for rollout verification.
 */
const configuredId = import.meta.env.VITE_HASSAN_PROPERTIES_REPORTING_COMPANY_ID;

export const HASSAN_PROPERTIES_REPORTING_COMPANY_ID: number | null =
  typeof configuredId === "string" &&
  /^[1-9]\d*$/.test(configuredId.trim()) &&
  Number.isSafeInteger(Number(configuredId.trim()))
    ? Number(configuredId.trim())
    : null;

export function hasHassanPropertiesHistoricalReportingPolicy(
  company: Pick<Company, "id" | "companyType"> | null | undefined,
): boolean {
  return (
    HASSAN_PROPERTIES_REPORTING_COMPANY_ID !== null &&
    company?.companyType === "properties" &&
    company.id === HASSAN_PROPERTIES_REPORTING_COMPANY_ID
  );
}
