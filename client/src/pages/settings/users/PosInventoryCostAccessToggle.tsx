import { useMutation, useQuery } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
  const endpoint = `/api/admin/users/${userId}/security-permissions`;
  const queryKey = [endpoint, companyId] as const;

  const { data, isLoading, isError } = useQuery<SecurityPermissionsResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load security permissions");
      return res.json();
    },
    staleTime: 30_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!data) throw new Error("Permissions are still loading");
      if (data.companyId !== companyId) {
        throw new Error("Switch to this company before changing POS cost access");
      }

      const next = new Set(data.permissions);
      if (enabled) next.add(POS_INVENTORY_COST_PERMISSION);
      else next.delete(POS_INVENTORY_COST_PERMISSION);

      const res = await apiRequest("PUT", endpoint, { permissions: Array.from(next).sort() });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to update POS cost access");
      }
      return res.json() as Promise<SecurityPermissionsResponse>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
      toast({
        title: updated.permissions.includes(POS_INVENTORY_COST_PERMISSION) ? "Cost price enabled" : "Cost price hidden",
        description: "This POS user's stock inventory cost access has been updated for this company.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update cost access", description: error.message, variant: "destructive" });
    },
  });

  const enabled = data?.permissions.includes(POS_INVENTORY_COST_PERMISSION) === true;

  if (isError) {
    return (
      <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        Cost-price permission could not be loaded. You may need Security Permissions access.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
      <div className="flex items-start gap-2 min-w-0">
        <DollarSign className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">Show cost price in Stock Inventory</p>
          <p className="text-xs text-muted-foreground">
            Allows this POS user to see Avg Rate and Total Value in assigned locations. Other POS users remain hidden.
          </p>
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => mutation.mutate(checked)}
        disabled={isLoading || !data || mutation.isPending}
        aria-label="Show inventory cost price for this POS user"
        data-testid={`switch-pos-inventory-cost-${userId}-${companyId}`}
      />
    </div>
  );
}
