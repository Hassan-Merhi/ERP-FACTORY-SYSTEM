import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, UserRound } from "lucide-react";
import FactoryCustomers from "@/pages/factory/FactoryCustomers";
import FactorySuppliers from "@/pages/factory/FactorySuppliers";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";

type Section = "customers" | "suppliers";
const SECTIONS = ["customers", "suppliers"] as const;

export default function FactoryPartiesHub() {
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hidden = myAccess?.hiddenCostFields ?? [];
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
    <div className="flex flex-col h-full overflow-hidden">
      <Tabs
        value={section}
        onValueChange={(value) => setSection(value as Section)}
        className="flex flex-col h-full overflow-hidden"
      >
        {/* Shared page-header grammar (accent bar, icon, subtitle) like the other hubs and the ERP pages. */}
        <div className="shrink-0 border-b border-slate-200/70 bg-gradient-to-r from-slate-50 via-white to-blue-50/60 px-4 pt-3 dark:border-[#1b3452] dark:from-[#0a182c] dark:via-[#0a1b34] dark:to-[#09172b] [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-2">
          <PageHeader
            title="Parties"
            subtitle="Customers and suppliers of the factory"
            icon={<Users className="h-5 w-5" />}
            showBackButton={false}
          />
        </div>
        <div className="erp-mobile-scroll-tabs shrink-0 border-b border-slate-200/70 bg-slate-50/70 px-4 pb-2 pt-1 dark:border-[#1b3452] dark:bg-[#071628]">
          <TabsList className="w-max min-w-full rounded-xl bg-slate-200/50 p-1 sm:w-fit sm:min-w-0 dark:bg-[#14263d]" aria-label="Factory parties sections">
            {showCustomers && (
              <TabsTrigger value="customers" className="rounded-lg px-4 py-2 font-semibold transition-colors data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:data-[state=active]:bg-blue-600 dark:data-[state=active]:text-white" data-testid="tab-parties-customers">
                <Users className="h-4 w-4 mr-2" />
                Customers
              </TabsTrigger>
            )}
            {showSuppliers && (
              <TabsTrigger value="suppliers" className="rounded-lg px-4 py-2 font-semibold transition-colors data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:data-[state=active]:bg-blue-600 dark:data-[state=active]:text-white" data-testid="tab-parties-suppliers">
                <UserRound className="h-4 w-4 mr-2" />
                Suppliers
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {showCustomers && (
          <TabsContent value="customers" className="flex-1 overflow-auto mt-0 p-4">
            <FactoryCustomers />
          </TabsContent>
        )}

        {showSuppliers && (
          <TabsContent value="suppliers" className="flex-1 overflow-auto mt-0 p-4">
            <FactorySuppliers />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
