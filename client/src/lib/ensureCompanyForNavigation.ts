import type { Company } from "@/contexts/CompanyContext";

/**
 * Only the CompanyProvider may change the authenticated company session.
 * Cross-company drilldowns must await that queued operation before navigating.
 * A missing assignment, a rejected switch or a network error must leave the
 * existing workspace untouched.
 */
export async function ensureCompanyForNavigation(
  companyId: number | null | undefined,
  selectedCompany: Pick<Company, "id"> | null,
  assignedCompanies: readonly Company[],
  selectCompany: (company: Company) => Promise<boolean>
): Promise<boolean> {
  if (!Number.isSafeInteger(companyId) || !companyId || companyId <= 0) return false;
  if (selectedCompany?.id === companyId) return true;

  const target = assignedCompanies.find((company) => company.id === companyId && company.active);
  if (!target) return false;

  try {
    return (await selectCompany(target)) === true;
  } catch {
    return false;
  }
}
