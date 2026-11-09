import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy } from "@/lib/queryPolicies";

/**
 * Single company-scoped cache identity for the ERP page grant response.
 * The access boundary still mirrors the legacy URL-only key for older screens;
 * new route guards and menus should never read that unscoped key.
 */
export function erpPageAccessQueryOptions(
  companyId: string | number | null | undefined,
  hasUser: boolean,
) {
  return {
    queryKey: companyQueryKey("/api/my-erp-pages", companyId),
    ...accessQueryPolicy,
    enabled: Boolean(hasUser && companyId != null),
  };
}
