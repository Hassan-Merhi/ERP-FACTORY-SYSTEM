import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Trash2, Beaker, Ship } from "lucide-react";
import ProductionSummary from "@/pages/factory/ProductionSummary";
import FactoryWaste from "@/pages/factory/FactoryWaste";
import FactoryMixOptimizer from "@/pages/factory/FactoryMixOptimizer";
import FactoryContainerTracking from "@/pages/factory/FactoryContainerTracking";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";

type Section = "production-summary" | "waste" | "mix-optimizer" | "container-tracking";
const SECTIONS = ["production-summary", "waste", "mix-optimizer", "container-tracking"] as const;
const HIDDEN_KEYS: Record<Section, string> = {
  "production-summary": "hide_tab_production_intel_summary",
  waste: "hide_tab_production_intel_waste",
  "mix-optimizer": "hide_tab_production_intel_mix",
  "container-tracking": "hide_tab_production_intel_container_tracking",
};

export default function FactoryProductionIntelHub() {
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hidden = myAccess?.hiddenCostFields ?? [];
  const sections: Section[] = SECTIONS.filter((section) => !hidden.includes(HIDDEN_KEYS[section]));
  const defaultSection: Section = sections[0] ?? "production-summary";
  const allowedSections: readonly Section[] = sections;

  const [section, setSection] = useHubQueryState<Section>({
    key: "section",
    allowedValues: allowedSections,
    knownValues: SECTIONS,
    defaultValue: defaultSection,
    clearKeys: ["tab"],
  });

  if (sections.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Production Intelligence tabs are available for this user.</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Tabs value={section} onValueChange={(value) => setSection(value as Section)} className="flex flex-col h-full overflow-hidden">
        <div className="border-b px-4 pt-3 flex-shrink-0 overflow-x-auto">
          <TabsList className="flex-nowrap">
            {sections.includes("production-summary") && (
              <TabsTrigger value="production-summary" data-testid="tab-production-intel-summary">
                <BarChart3 className="h-4 w-4 mr-2" />
                Production Summary
              </TabsTrigger>
            )}
            {sections.includes("waste") && (
              <TabsTrigger value="waste" data-testid="tab-production-intel-waste">
                <Trash2 className="h-4 w-4 mr-2" />
                Waste Tracking
              </TabsTrigger>
            )}
            {sections.includes("mix-optimizer") && (
              <TabsTrigger value="mix-optimizer" data-testid="tab-production-intel-mix">
                <Beaker className="h-4 w-4 mr-2" />
                Mix Optimizer
              </TabsTrigger>
            )}
            {sections.includes("container-tracking") && (
              <TabsTrigger value="container-tracking" data-testid="tab-production-intel-container-tracking">
                <Ship className="h-4 w-4 mr-2" />
                Container Tracking
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        {sections.includes("production-summary") && (
          <TabsContent value="production-summary" className="flex-1 overflow-auto mt-0 p-4">
            <ProductionSummary />
          </TabsContent>
        )}
        {sections.includes("waste") && (
          <TabsContent value="waste" className="flex-1 overflow-auto mt-0 p-4">
            <FactoryWaste />
          </TabsContent>
        )}
        {sections.includes("mix-optimizer") && (
          <TabsContent value="mix-optimizer" className="flex-1 overflow-auto mt-0 p-4">
            <FactoryMixOptimizer />
          </TabsContent>
        )}
        {sections.includes("container-tracking") && (
          <TabsContent value="container-tracking" className="flex-1 overflow-auto mt-0 p-4">
            <FactoryContainerTracking />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
