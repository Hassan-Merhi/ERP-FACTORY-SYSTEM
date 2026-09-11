import type { ClientErrorLike } from "@/lib/clientError";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { Loader2 } from "lucide-react";
import type { SettingsPosReceipt } from "./settingsTypes";

export function POSReceiptSettings() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  const { data: settings, isLoading } = useQuery<SettingsPosReceipt>({
    queryKey: ["/api/settings/pos-receipt", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });

  const updateMutation = useMutation({
    mutationFn: async (newSettings: SettingsPosReceipt) => {
      const res = await apiRequest("POST", `/api/settings/pos-receipt/${selectedCompany?.id}`, newSettings);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/pos-receipt", selectedCompany?.id] });
      toast({ title: "Success", description: "Receipt settings updated" });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;

  const current = settings || { showLogo: true, showAddress: true, showFooter: true };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>Show Company Logo</Label>
        <Switch
          checked={current.showLogo}
          onCheckedChange={(val) => updateMutation.mutate({ ...current, showLogo: val })}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label>Show Address</Label>
        <Switch
          checked={current.showAddress}
          onCheckedChange={(val) => updateMutation.mutate({ ...current, showAddress: val })}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label>Show Footer Message</Label>
        <Switch
          checked={current.showFooter}
          onCheckedChange={(val) => updateMutation.mutate({ ...current, showFooter: val })}
        />
      </div>
    </div>
  );
}
