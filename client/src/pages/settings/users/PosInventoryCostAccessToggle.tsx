import { useMutation, useQuery } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { translatePosInventoryCostText, type PosInventoryCostTranslationKey } from "@/i18n/posInventoryCostTranslations";
import { apiRequest, queryClient } from "@/lib/queryClient";

const POS_INVENTORY_COST_PERMISSION = "inventory.cost.view";

interface PosInventoryCostAccessToggleProps {
  userId: string;
  companyId: number;
}

interface SecurityPermissionsResponse {
  userId: string;
  companyId: number;
  permissions: string[];
}

export function PosInventoryCostAccessToggle({ userId, companyId }: PosInventoryCostAccessToggleProps) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: PosInventoryCostTranslationKey) => translatePosInventoryCostText(key, language);
  const endpoint = `/api/admin/users/${userId}/security-permissions`;
  const queryKey = [endpoint, companyId] as const;

  const { data, isLoading, isError } = useQuery<SecurityPermissionsResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error(tr("loadPermissionsFailed"));
      return res.json();
    },
    staleTime: 30_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!data) throw new Error(tr("permissionsLoading"));
      if (data.companyId !== companyId) throw new Error(tr("switchCompany"));

      const next = new Set(data.permissions);
      if (enabled) next.add(POS_INVENTORY_COST_PERMISSION);
      else next.delete(POS_INVENTORY_COST_PERMISSION);

      const res = await apiRequest("PUT", endpoint, { permissions: Array.from(next).sort() });
      return res.json() as Promise<SecurityPermissionsResponse>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
      toast({
        title: updated.permissions.includes(POS_INVENTORY_COST_PERMISSION) ? tr("enabledTitle") : tr("hiddenTitle"),
        description: tr("updatedDescription"),
      });
    },
    onError: (error: Error) => {
      toast({ title: tr("updateErrorTitle"), description: error.message || tr("updateFailed"), variant: "destructive" });
    },
  });

  const enabled = data?.permissions.includes(POS_INVENTORY_COST_PERMISSION) === true;

  if (isError) {
    return <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">{tr("loadError")}</div>;
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
      <div className="flex items-start gap-2 min-w-0">
        <DollarSign className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{tr("title")}</p>
          <p className="text-xs text-muted-foreground">{tr("description")}</p>
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => mutation.mutate(checked)}
        disabled={isLoading || !data || mutation.isPending}
        aria-label={tr("ariaLabel")}
        data-testid={`switch-pos-inventory-cost-${userId}-${companyId}`}
      />
    </div>
  );
}
