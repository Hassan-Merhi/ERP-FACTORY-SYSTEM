import { Card } from "@/components/ui/card";

import { Switch } from "@/components/ui/switch";

import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { Upload, ShoppingCart } from "lucide-react";
import { CompanyTimezoneCard } from "./CompanyTimezoneCard";
import { useCompany } from "@/contexts/CompanyContext";

export function PosSettingsTab() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const { data: companySettings } = useQuery({
    queryKey: ["/api/company-settings", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const res = await fetch(`/api/company-settings?companyId=${selectedCompany?.id}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await modeApiRequest("POST", "/api/company-settings", {
        companyId: selectedCompany?.id,
        posExcelImportEnabled: enabled,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/company-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/company-settings", selectedCompany?.id] });
      toast({ title: "Updated", description: "POS Excel Import setting has been saved." });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  if (!selectedCompany) {
    return (
      <Card className="p-6">
        <p className="text-muted-foreground">Select a company to configure POS settings.</p>
      </Card>
    );
  }

  const isEnabled = companySettings?.posExcelImportEnabled ?? false;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShoppingCart className="h-5 w-5" />
        <h2 className="text-lg font-semibold" data-testid="text-pos-settings-title">
          POS Settings
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Configure features available to POS users for {selectedCompany.name}.
      </p>

      <CompanyTimezoneCard />

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-500/10 rounded-lg">
              <Upload className="h-6 w-6 text-green-500" />
            </div>
            <div>
              <h3 className="font-semibold" data-testid="text-pos-excel-import-title">
                POS Excel Import
              </h3>
              <p className="text-sm text-muted-foreground">
                Allow POS users to import sales from Excel files. When enabled, a "POS Import" option appears in their
                sidebar.
              </p>
            </div>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={(checked) => toggleMutation.mutate(checked)}
            disabled={toggleMutation.isPending}
            data-testid="switch-pos-excel-import"
          />
        </div>
      </Card>
    </div>
  );
}
