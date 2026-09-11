import { useState } from "react";
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
  const [subTab, setSubTab] = useState("advances");

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

  const showRepayments =
    settings?.advancesTabRepaymentsEnabled !== false && !hiddenTabs.includes("hide_tab_advances_repayments");

  return (
    <Tabs value={subTab} onValueChange={setSubTab}>
      <TabsList className="mb-4">
        <TabsTrigger value="advances" data-testid="subtab-advances">
          <Banknote className="h-4 w-4 mr-2" />
          Advances
        </TabsTrigger>
        {showRepayments && (
          <TabsTrigger value="repayments" data-testid="subtab-repayments">
            <RotateCcw className="h-4 w-4 mr-2" />
            Repayments
          </TabsTrigger>
        )}
        <TabsTrigger value="deductions" data-testid="subtab-deductions">
          <Scissors className="h-4 w-4 mr-2" />
          Deductions
        </TabsTrigger>
      </TabsList>

      <TabsContent value="advances" className="mt-0">
        <AdvancesView />
      </TabsContent>
      {showRepayments && (
        <TabsContent value="repayments" className="mt-0">
          <RepaymentsView />
        </TabsContent>
      )}
      <TabsContent value="deductions" className="mt-0">
        <DeductionsView />
      </TabsContent>
    </Tabs>
  );
}
