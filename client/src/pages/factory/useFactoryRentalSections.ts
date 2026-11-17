import { useQuery } from "@tanstack/react-query";
import { useFactoryVisibleSections } from "@/components/FactorySidebar";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { RENTAL_SECTIONS, rentalSectionHref, type RentalSection } from "@/properties/config/rentalSections";

/**
 * Rental tabs a Factory user may open: the same check the sidebar and the
 * Factory route guard apply to each `/factory/rental/*` route (Warehouses is
 * developer-only, Payments admin-only). Visibility only; routes and the
 * server keep authorizing.
 */
export function useFactoryRentalSections(): readonly RentalSection[] {
  const { data: user } = useQuery(authenticatedUserQueryOptions());
  const { isPinnedVisible } = useFactoryVisibleSections(user ? { role: user.role ?? undefined } : undefined);
  return RENTAL_SECTIONS.filter((section) => isPinnedVisible({ url: rentalSectionHref("FACTORY", section) }));
}
