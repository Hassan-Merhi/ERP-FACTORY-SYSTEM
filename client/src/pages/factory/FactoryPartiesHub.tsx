import { useQuery } from "@tanstack/react-query";
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
      <Tabs value={section} onValueChange={(value) => setSection(value as Section)} className="flex flex-col h-full overflow-hidden">
        <div className="border-b px-4 pt-3 flex-shrink-0 overflow-x-auto">
          <TabsList className="flex-nowrap">
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
