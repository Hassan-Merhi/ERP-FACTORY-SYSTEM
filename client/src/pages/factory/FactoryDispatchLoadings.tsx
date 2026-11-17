import { useQuery } from "@tanstack/react-query";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { FACTORY_ACCESS_REGISTRY, hasFactoryPageKey } from "@shared/factoryAccessRegistry";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";
import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";

const INVOICING_PAGE = FACTORY_ACCESS_REGISTRY.find((page) => page.key === "factory/invoicing")!;

/**
 * Hide keys that keep this view closed. The first is the Container Loadings tab's own gate on
 * Invoicing (the server gates the loading APIs with it). The others are the retired Dispatch
 * Batches page's two tabs: a user who had either hidden does not gain this view through it.
 */
const HIDE_KEYS = ["hide_invoicing_loadings_tab", "hide_tab_dispatch_batches", "hide_tab_dispatch_reports"];

/**
 * `/factory/dispatch-batches`: the Dispatch Batches list is retired (owner decision 3, 2026-11-16)
 * for Loading Dispatch, the Dispatch button on the container loading scan. The page key and route
 * stay, so stored permissions and landing pages keep working, and the route shows Container
 * Loadings, the view `/factory/invoicing?tab=loadings` shows.
 *
 * It only opens for a user who could already open that Invoicing tab (Invoicing page access and
 * no loadings-tab restriction) and had no Dispatch Batches tab hidden; everyone else sees the
 * restricted state, never a redirect, so a Dispatch Batches landing page cannot loop. Existing
 * batches stay readable at /factory/dispatch-batches/:id.
 */
export default function FactoryDispatchLoadings() {
  const { selectedCompany } = useCompany();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });

  if (!myAccess || myAccess.companyId !== selectedCompany?.id) return <LoadingSkeleton variant="page" className="p-4" />;

  const hidden = myAccess.hasFactoryAccess === true ? myAccess.hiddenCostFields : HIDE_KEYS;
  const canOpenInvoicing = myAccess.fullAccess || hasFactoryPageKey(INVOICING_PAGE, myAccess.pageKeys);
  const showLoadings = canOpenInvoicing && !HIDE_KEYS.some((key) => hidden.includes(key));

  if (!showLoadings) return <RestrictedTabsState />;
  return <FactoryContainerLoadingScan />;
}
