import type { Company } from "@/contexts/CompanyContext";

/**
 * Read-only historical reporting assignment, verified via the primary Render
 * production database public.companies table on 2026-11-09:
 * id=13, code=HP, company_type=properties, name=HASSAN PROPERTIES.
 *
 * Match stable identity fields; the company display name is deliberately not
 * used. Both ID and code must match so an unrelated company with a reused ID
 * in another environment cannot silently receive this special view.
 *
 * This does NOT authorize any requests or financial writes. Server company
 * scope, ledger access and all voucher posting rules remain authoritative.
 */
export const HASSAN_PROPERTIES_REPORTING_COMPANY_ID = 13;
export const HASSAN_PROPERTIES_REPORTING_COMPANY_CODE = "HP";

export function hasHassanPropertiesHistoricalReportingPolicy(
  company: Pick<Company, "id" | "code" | "companyType"> | null | undefined,
): boolean {
  return (
    company?.companyType === "properties" &&
    company.id === HASSAN_PROPERTIES_REPORTING_COMPANY_ID &&
    company.code === HASSAN_PROPERTIES_REPORTING_COMPANY_CODE
  );
}
