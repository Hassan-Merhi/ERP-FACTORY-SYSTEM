import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Banknote, RotateCcw, Scissors } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {} from "@/components/ui/dialog";
import {} from "@/components/ui/dropdown-menu";

import { AdvancesView } from "./factoryadvancestab/components/AdvancesView";
import { RepaymentsView } from "./factoryadvancestab/components/RepaymentsView";
import { DeductionsView } from "./factoryadvancestab/components/DeductionsView";
import type { FactoryMyAccess } from "@shared/apiTypes";
export default function FactoryAdvancesTab() {
  const [subTab, setSubTab] = useState<"advances" | "repayments" | "deductions">("advances");

  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const showAdvances = !hiddenTabs.includes("hide_tab_advances_advances");
  const showRepayments =
    settings?.advancesTabRepaymentsEnabled !== false && !hiddenTabs.includes("hide_tab_advances_repayments");
  const showDeductions = !hiddenTabs.includes("hide_tab_advances_deductions");
  const visibleTabs = [
    showAdvances ? "advances" : null,
    showRepayments ? "repayments" : null,
    showDeductions ? "deductions" : null,
  ].filter((value): value is "advances" | "repayments" | "deductions" => value !== null);
  const activeTab = visibleTabs.includes(subTab) ? subTab : visibleTabs[0];

  useEffect(() => {
    if (activeTab && subTab !== activeTab) setSubTab(activeTab);
  }, [activeTab, subTab]);

  if (!activeTab) {
    return <div className="p-4 text-sm text-muted-foreground">No Advances tabs are available for this user.</div>;
  }

  return (
    <Tabs value={activeTab} onValueChange={(value) => setSubTab(value as "advances" | "repayments" | "deductions")}>
      <TabsList className="mb-4">
        {showAdvances && (
          <TabsTrigger value="advances" data-testid="subtab-advances">
            <Banknote className="h-4 w-4 mr-2" />
            Advances
          </TabsTrigger>
        )}
        {showRepayments && (
          <TabsTrigger value="repayments" data-testid="subtab-repayments">
            <RotateCcw className="h-4 w-4 mr-2" />
            Repayments
          </TabsTrigger>
        )}
        {showDeductions && (
          <TabsTrigger value="deductions" data-testid="subtab-deductions">
            <Scissors className="h-4 w-4 mr-2" />
            Deductions
          </TabsTrigger>
        )}
      </TabsList>

      {showAdvances && (
        <TabsContent value="advances" className="mt-0">
          <AdvancesView />
        </TabsContent>
      )}
      {showRepayments && (
        <TabsContent value="repayments" className="mt-0">
          <RepaymentsView />
        </TabsContent>
      )}
      {showDeductions && (
        <TabsContent value="deductions" className="mt-0">
          <DeductionsView />
        </TabsContent>
      )}
    </Tabs>
  );
}
