import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClipboardCheck, FileText, Award } from "lucide-react";
import FactorySupplierReport from "@/pages/factory/FactorySupplierReport";
import FactorySupplierStatement from "@/pages/factory/FactorySupplierStatement";
import FactorySupplierScoreboard from "@/pages/factory/FactorySupplierScoreboard";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";

type Section = "report" | "statement" | "scores";
const SECTIONS = ["report", "statement", "scores"] as const;
const HIDDEN_KEYS: Record<Section, string> = {
  report: "hide_tab_supplier_intel_report",
  statement: "hide_tab_supplier_intel_statement",
  scores: "hide_tab_supplier_intel_scores",
};

export default function FactorySupplierHub() {
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hidden = myAccess?.hiddenCostFields ?? [];
  const sections: Section[] = SECTIONS.filter((section) => !hidden.includes(HIDDEN_KEYS[section]));
  const defaultSection: Section = sections[0] ?? "report";
  const allowedSections: readonly Section[] = sections.length > 0 ? sections : SECTIONS;

  const [section, setSection] = useHubQueryState<Section>({
    key: "section",
    allowedValues: allowedSections,
    defaultValue: defaultSection,
    clearKeys: ["tab"],
  });

  if (sections.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Supplier Intelligence tabs are available for this user.</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Tabs value={section} onValueChange={(value) => setSection(value as Section)} className="flex flex-col h-full overflow-hidden">
        <div className="border-b px-4 pt-3 flex-shrink-0 overflow-x-auto">
          <TabsList className="flex-nowrap">
            {sections.includes("report") && (
              <TabsTrigger value="report" data-testid="tab-supplier-hub-report">
                <FileText className="h-4 w-4 mr-2" />
                Supplier Report
              </TabsTrigger>
            )}
            {sections.includes("statement") && (
              <TabsTrigger value="statement" data-testid="tab-supplier-hub-statement">
                <ClipboardCheck className="h-4 w-4 mr-2" />
                Supplier Statement
              </TabsTrigger>
            )}
            {sections.includes("scores") && (
              <TabsTrigger value="scores" data-testid="tab-supplier-hub-scores">
                <Award className="h-4 w-4 mr-2" />
                Supplier Scores
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        {sections.includes("report") && (
          <TabsContent value="report" className="flex-1 overflow-auto mt-0 p-4">
            <FactorySupplierReport />
          </TabsContent>
        )}
        {sections.includes("statement") && (
          <TabsContent value="statement" className="flex-1 overflow-auto mt-0 p-4">
            <FactorySupplierStatement />
          </TabsContent>
        )}
        {sections.includes("scores") && (
          <TabsContent value="scores" className="flex-1 overflow-auto mt-0 p-4">
            <FactorySupplierScoreboard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
