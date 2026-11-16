import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { FactoryRelatedLinks } from "@/components/FactoryRelatedLinks";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, UserRound } from "lucide-react";
import FactoryCustomers from "@/pages/factory/FactoryCustomers";
import FactorySuppliers from "@/pages/factory/FactorySuppliers";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

type Section = "customers" | "suppliers";
const SECTIONS = ["customers", "suppliers"] as const;

export default function FactoryPartiesHub() {
  const { selectedCompany } = useCompany();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hidden =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_parties_customers", "hide_tab_parties_suppliers"];
  const sections: Section[] = SECTIONS.filter((section) =>
    section === "customers"
      ? !hidden.includes("hide_tab_parties_customers")
      : !hidden.includes("hide_tab_parties_suppliers")
  );
  const defaultSection: Section = sections[0] ?? "customers";
  const allowedSections: readonly Section[] = sections;

  const accessReady = myAccess?.companyId === selectedCompany?.id;
  const [section, setSection] = useHubQueryState<Section>({
    key: "section",
    // Until access loads, keep a deep-linked tab instead of stripping it.
    allowedValues: accessReady ? allowedSections : SECTIONS,
    knownValues: SECTIONS,
    defaultValue: defaultSection,
    clearKeys: ["tab"],
  });

  if (!accessReady) return <LoadingSkeleton variant="page" className="p-4" />;

  if (sections.length === 0) {
    return <RestrictedTabsState />;
  }

  const showCustomers = sections.includes("customers");
  const showSuppliers = sections.includes("suppliers");

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <Tabs
        value={section}
        onValueChange={(value) => setSection(value as Section)}
        className="flex flex-col h-full overflow-hidden"
      >
        <div className="shrink-0 px-4 pt-4 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-0">
          <PageHeader
            title="Parties"
            subtitle="Customers and suppliers of the factory"
            icon={<Users className="h-5 w-5" />}
            showBackButton={false}
          />
          <FactoryRelatedLinks
            className="justify-end pb-2"
            links={[{ href: "/factory/contacts", label: "Contacts" }]}
          />
        </div>
        <div className="erp-mobile-scroll-tabs border-b px-4 pt-3 pb-1 shrink-0">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory parties sections">
            {showCustomers && (
              <TabsTrigger value="customers" data-testid="tab-parties-customers">
                <Users className="h-4 w-4 mr-2" />
                Customers
              </TabsTrigger>
            )}
            {showSuppliers && (
              <TabsTrigger value="suppliers" data-testid="tab-parties-suppliers">
                <UserRound className="h-4 w-4 mr-2" />
                Suppliers
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {showCustomers && (
          <TabsContent value="customers" className="mt-0 min-h-0 flex-1 overflow-auto p-0">
            <FactoryCustomers />
          </TabsContent>
        )}

        {showSuppliers && (
          <TabsContent value="suppliers" className="mt-0 min-h-0 flex-1 overflow-auto p-4 sm:p-6">
            <FactorySuppliers />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
