import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { factoryApiRequest } from "@/lib/factoryApi";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const URL = "/api/factory/automatic-priority-mode";

type ModeResponse = {
  enabled: boolean;
  canEdit: boolean;
  changed?: boolean;
};

/**
 * Operational feature flag, deliberately independent of the "Enable All" and
 * "Save Settings" controls. Existing allocations survive switching it OFF.
 */
export function AutomaticPriorityPrintingCard() {
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const companyId = selectedCompany?.id ?? null;
  const queryKey = companyQueryKey(URL, companyId);
  const { data, isPending, isError, refetch } = useQuery<ModeResponse>({
    queryKey,
    queryFn: async () => {
      const response = await factoryApiRequest("GET", URL);
      if (!response.ok) throw new Error("Could not load Automatic Priority Printing setting");
      return response.json();
    },
    enabled: companyId !== null,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const mutation = useMutation({
    mutationFn: async (enabled: boolean): Promise<ModeResponse> => {
      const response = await factoryApiRequest("PUT", URL, { enabled });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "Setting update failed" }));
        throw new Error(body.message || "Setting update failed");
      }
      return response.json();
    },
    onSuccess: (updated) => {
      // Never locally flip the switch before the server confirms the commit.
      queryClient.setQueryData(queryKey, (previous: ModeResponse | undefined) =>
        previous ? { ...previous, enabled: updated.enabled } : updated
      );
      void queryClient.invalidateQueries({ queryKey: [URL] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
      toast({
        title: updated.enabled ? "Automatic Priority Printing enabled" : "Automatic Priority Printing disabled",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not change automatic printing", description: error.message, variant: "destructive" });
    },
  });

  const canEdit = data?.canEdit === true;
  const isDisabled = companyId === null || isPending || isError || mutation.isPending || !canEdit;
  const enabled = data?.enabled === true;

  return (
    <Card data-testid="automatic-priority-mode-card">
      <CardHeader>
        <CardTitle>Automatic Priority Printing &amp; Loading</CardTitle>
        <CardDescription>
          When ON, eligible new and reprinted bales are automatically allocated to their highest-priority loading. When
          OFF, future prints follow the original workflow. Existing allocations and their original colors are never
          reversed by this switch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="automatic-priority-mode" className="cursor-pointer">
            Automatic loading on printing
          </Label>
          <Switch
            id="automatic-priority-mode"
            data-testid="switch-automatic-priority-mode"
            aria-label="Automatic Priority Printing and Loading"
            checked={enabled}
            disabled={isDisabled}
            onCheckedChange={(nextEnabled) => mutation.mutate(nextEnabled)}
          />
        </div>
        {isError ? (
          <div className="flex items-center justify-between gap-2 text-sm text-destructive" role="alert">
            <span>Unable to read the current setting. No changes are allowed until it loads.</span>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : isPending || !companyId ? (
          <p className="text-xs text-muted-foreground">Loading company setting…</p>
        ) : !canEdit ? (
          <p className="text-xs text-muted-foreground">
            Only Admin, Owner, or Developer users can change this company-wide setting.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="automatic-priority-mode-status">
            {enabled
              ? "ON — future eligible prints use automatic loading."
              : "OFF — current printing and manual Priority Scan remain unchanged."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
