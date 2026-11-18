import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { ArrowLeftRight } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { AuthMe } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import {
  canUsePropertiesCapability,
  PROPERTIES_RENTAL_TABS,
  type PropertiesRentalTab,
} from "@/properties/config/propertiesNavigation";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/page-state";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { RentalsHub } from "./RentalsHub";
// Each rentals tab owns independent data, calendars and report components.
const PropertiesRentalWarehouses = lazy(() => import("./PropertiesRentalWarehouses"));
const PropertiesRentalShops = lazy(() => import("./PropertiesRentalShops"));
const PropertiesRentalPayments = lazy(() => import("./PropertiesRentalPayments"));

const RENTAL_TABS = PROPERTIES_RENTAL_TABS.map((item) => item.value);
const TAB_LOADING_TITLES: Record<PropertiesRentalTab, string> = {
  warehouses: "Loading warehouses…",
  shops: "Loading shops…",
  payments: "Loading rental payments…",
};

export default function PropertiesRentalsHub() {
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { selectedCompany } = useCompany();
  // Visibility only; the server continues to authorize transfer writes.
  const isDeveloper = canUsePropertiesCapability("developer", user, selectedCompany);
  const [tab, setTab] = useHubQueryState<PropertiesRentalTab>({
    key: "tab",
    allowedValues: RENTAL_TABS,
    defaultValue: "warehouses",
    omitDefault: true,
  });

  return (
    <RentalsHub
      module="PROPERTIES"
      value={tab}
      onValueChange={setTab}
      tools={
        isDeveloper ? (
          <nav aria-label="Rental management tools">
            <Button asChild variant="outline" size="sm">
              <Link href="/properties/transfer" data-testid="link-properties-rentals-transfer">
                <ArrowLeftRight className="mr-2 h-4 w-4" aria-hidden="true" />
                Cash Transfer
              </Link>
            </Button>
          </nav>
        ) : undefined
      }
    >
      <Suspense fallback={<LoadingState title={TAB_LOADING_TITLES[tab]} />}>
        {tab === "warehouses" ? (
          <PropertiesRentalWarehouses />
        ) : tab === "shops" ? (
          <PropertiesRentalShops />
        ) : (
          <PropertiesRentalPayments />
        )}
      </Suspense>
    </RentalsHub>
  );
}
