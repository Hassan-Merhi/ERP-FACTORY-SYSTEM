import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { FactoryRelatedLinks } from "@/components/FactoryRelatedLinks";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, UserRound } from "lucide-react";
import FactoryCustomers from "@/pages/factory/FactoryCustomers";
import FactorySuppliers from "@/pages/factory/FactorySuppliers";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

type Section = "customers" | "suppliers";
const SECTIONS = ["customers", "suppliers"] as const;

export default function FactoryPartiesHub() {
  const { selectedCompany } = useCompany();
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id), enabled: Boolean(selectedCompany?.id), staleTime: 5 * 60000 });
  const hidden = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
    ? myAccess.hiddenCostFields
    : ["hide_tab_parties_customers", "hide_tab_parties_suppliers"];
  const sections: Section[] = SECTIONS.filter((section) =>
    section === "customers"
      ? !hidden.includes("hide_tab_parties_customers")
      : !hidden.includes("hide_tab_parties_suppliers")
  );
  const defaultSection: Section = sections[0] ?? "customers";
  const allowedSections: readonly Section[] = sections;

  const [section, setSection] = useHubQueryState<Section>({
    key: "section",
    allowedValues: allowedSections,
    knownValues: SECTIONS,
    defaultValue: defaultSection,
    clearKeys: ["tab"],
  });

  if (sections.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Parties tabs are available for this user.</div>;
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
        {/* Presentation only: preserve the hub query state and permission-gated tabs. */}
        <div className="relative mx-4 mt-4 shrink-0 overflow-hidden rounded-2xl border border-blue-500/15 bg-linear-to-r from-blue-500/10 via-background to-cyan-500/5 px-4 py-4 shadow-sm dark:border-blue-400/20 dark:from-blue-600/15 dark:via-background dark:to-blue-950/30 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-0">
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
        <div className="erp-mobile-scroll-tabs shrink-0 border-b border-border/50 px-4 pb-3 pt-3">
          <TabsList
            className="h-12 w-max min-w-full rounded-2xl border border-border/60 bg-muted/60 p-1 shadow-sm sm:min-w-0 sm:w-fit dark:border-blue-400/20 dark:bg-slate-900/80"
            aria-label="Factory parties sections"
          >
            {showCustomers && (
              <TabsTrigger
                value="customers"
                data-testid="tab-parties-customers"
                className="h-10 rounded-xl px-5 font-semibold data-[state=active]:bg-blue-600 data-[state=active]:text-white dark:data-[state=active]:bg-blue-600 dark:data-[state=active]:text-white"
              >
                <Users className="h-4 w-4 mr-2" />
                Customers
              </TabsTrigger>
            )}
            {showSuppliers && (
              <TabsTrigger
                value="suppliers"
                data-testid="tab-parties-suppliers"
                className="h-10 rounded-xl px-5 font-semibold data-[state=active]:bg-blue-600 data-[state=active]:text-white dark:data-[state=active]:bg-blue-600 dark:data-[state=active]:text-white"
              >
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
