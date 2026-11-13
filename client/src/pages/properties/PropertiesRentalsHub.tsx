import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Building2, ClipboardList, ArrowLeftRight } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { AuthMe } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import {
  canUsePropertiesCapability,
  PROPERTIES_RENTAL_TABS,
  type PropertiesRentalTab,
} from "@/properties/config/propertiesNavigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
// Each rentals tab owns independent data, calendars and report components.
const PropertiesRentalWarehouses = lazy(() => import("./PropertiesRentalWarehouses"));
const PropertiesRentalShops = lazy(() => import("./PropertiesRentalShops"));
const PropertiesRentalPayments = lazy(() => import("./PropertiesRentalPayments"));

const RENTAL_TABS = PROPERTIES_RENTAL_TABS.map((item) => item.value);

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
    <div className="properties-rentals-hub space-y-4" data-testid="properties-rentals-hub">
      {isDeveloper && (
        <nav aria-label="Rental management tools" className="flex justify-end">
          <Link
            href="/properties/transfer"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
            data-testid="link-properties-rentals-transfer"
          >
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            Cash Transfer
          </Link>
        </nav>
      )}
      <Tabs value={tab} onValueChange={(value) => setTab(value as PropertiesRentalTab)}>
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList
            className="properties-rentals-tabs w-max min-w-full sm:min-w-0 sm:w-fit"
            aria-label="Rental sections"
          >
            <TabsTrigger value="warehouses" data-testid="tab-properties-rentals-warehouses">
              <Building2 className="mr-2 h-4 w-4" />
              Warehouses
            </TabsTrigger>
            <TabsTrigger value="shops" data-testid="tab-properties-rentals-shops">
              <Building2 className="mr-2 h-4 w-4" />
              Shops
            </TabsTrigger>
            <TabsTrigger value="payments" data-testid="tab-properties-rentals-payments">
              <ClipboardList className="mr-2 h-4 w-4" />
              Payments
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="warehouses" className="mt-4">
          <Suspense
            fallback={
              <div role="status" className="p-6 text-sm text-muted-foreground">
                Loading warehouses…
              </div>
            }
          >
            <PropertiesRentalWarehouses />
          </Suspense>
        </TabsContent>
        <TabsContent value="shops" className="mt-4">
          <Suspense
            fallback={
              <div role="status" className="p-6 text-sm text-muted-foreground">
                Loading shops…
              </div>
            }
          >
            <PropertiesRentalShops />
          </Suspense>
        </TabsContent>
        <TabsContent value="payments" className="mt-4">
          <Suspense
            fallback={
              <div role="status" className="p-6 text-sm text-muted-foreground">
                Loading rental payments…
              </div>
            }
          >
            <PropertiesRentalPayments />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
