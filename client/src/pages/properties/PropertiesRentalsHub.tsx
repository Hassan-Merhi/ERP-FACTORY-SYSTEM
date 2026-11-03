import { Building2, ClipboardList, Store, ArrowLeftRight } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { AuthMe } from "@shared/apiTypes";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import PropertiesRentalWarehouses from "./PropertiesRentalWarehouses";
import PropertiesRentalShops from "./PropertiesRentalShops";
import PropertiesRentalPayments from "./PropertiesRentalPayments";

const RENTAL_TABS = ["warehouses", "shops", "payments"] as const;
type RentalTab = (typeof RENTAL_TABS)[number];

export default function PropertiesRentalsHub() {
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  // PropertiesRoutes protects /properties/transfer with user.role.
  const isDeveloper = user?.role === "Developer";
  const [tab, setTab] = useHubQueryState<RentalTab>({
    key: "tab",
    allowedValues: RENTAL_TABS,
    defaultValue: "warehouses",
    omitDefault: true,
  });

  return (
    <div className="space-y-4" data-testid="properties-rentals-hub">
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
      <Tabs value={tab} onValueChange={(value) => setTab(value as RentalTab)}>
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Rental sections">
            <TabsTrigger value="warehouses" data-testid="tab-properties-rentals-warehouses">
              <Building2 className="mr-2 h-4 w-4" />
              Warehouses
            </TabsTrigger>
            <TabsTrigger value="shops" data-testid="tab-properties-rentals-shops">
              <Store className="mr-2 h-4 w-4" />
              Shops
            </TabsTrigger>
            <TabsTrigger value="payments" data-testid="tab-properties-rentals-payments">
              <ClipboardList className="mr-2 h-4 w-4" />
              Payments
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="warehouses" className="mt-4">
          <PropertiesRentalWarehouses />
        </TabsContent>
        <TabsContent value="shops" className="mt-4">
          <PropertiesRentalShops />
        </TabsContent>
        <TabsContent value="payments" className="mt-4">
          <PropertiesRentalPayments />
        </TabsContent>
      </Tabs>
    </div>
  );
}
