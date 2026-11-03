import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import { factoryPageAllowsRole, hasFactoryPageKey, resolveFactoryPage } from "@/app/factoryAccessRegistry";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy } from "@/lib/queryPolicies";

export interface FactoryRelatedLink {
  href: string;
  label: string;
}

/**
 * Contextual links to existing Factory pages. This is navigation only:
 * authorization and business logic remain with the original destination.
 *
 * Wait for authoritative company-scoped grants before displaying links; the
 * caller must not expose an action just because access is still loading.
 */
export function FactoryRelatedLinks({
  links,
  className = "",
}: {
  links: readonly FactoryRelatedLink[];
  className?: string;
}) {
  const { selectedCompany } = useCompany();
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { data: access } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    ...accessQueryPolicy,
    enabled: !!user && !!selectedCompany?.id,
  });

  if (!user || !selectedCompany?.id || !access || access.companyId !== selectedCompany.id) return null;
  // FactoryRoutes gates these destinations using user.role, not currentRole.
  const role = user.role ?? "";
  const visibleLinks = links.filter(({ href }) => {
    const page = resolveFactoryPage(href);
    if (!page || !factoryPageAllowsRole(page, role)) return false;
    if (page.hideKey && access.hiddenCostFields?.includes(page.hideKey)) return false;
    // The Factory route guard bypasses per-user page lists for privileged roles.
    // The canonical registry now restricts Cost Centers to Developer only.
    if (["Admin", "Owner", "Developer"].includes(role)) return true;
    return access.fullAccess || hasFactoryPageKey(page, access.pageKeys ?? []);
  });
  if (visibleLinks.length === 0) return null;

  return (
    <nav aria-label="Related Factory workflows" className={`flex flex-wrap items-center gap-2 ${className}`}>
      {visibleLinks.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className="inline-flex min-h-9 items-center rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
          data-testid={`link-factory-related-${href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
