import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const URL = "/api/factory/automatic-priority-mode";

/**
 * Operational feature flag; intentionally separate from the bulk "Enable All"
 * settings action. OFF only affects future automatic allocations.
 */
export function AutomaticPriorityPrintingCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ enabled: boolean }>({
    queryKey: [URL],
    queryFn: async () => (await apiRequest("GET", URL)).json(),
    staleTime: 0,
  });
  const { data: user } = useQuery<{ currentRole?: string; role?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const role = (user?.currentRole || user?.role || "").toLowerCase();
  const allowed = ["admin", "owner", "developer"].includes(role);
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => (await apiRequest("PUT", URL, { enabled })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [URL] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
      toast({ title: "Automatic Priority Printing setting saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Cannot update automatic printing", description: error.message, variant: "destructive" });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic Priority Printing & Loading</CardTitle>
        <CardDescription>
          When enabled, newly printed or eligible reprinted factory bales are automatically assigned
          to the highest-priority loading that still needs their article. Turning this off restores
          ordinary printing for future actions and does not reverse earlier allocations.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <Label htmlFor="automatic-priority-mode">Automatic allocation on Print</Label>
        <Switch
          id="automatic-priority-mode"
          data-testid="switch-automatic-priority-mode"
          checked={data?.enabled === true}
          disabled={!allowed || isLoading || mutation.isPending}
          onCheckedChange={(enabled) => mutation.mutate(enabled)}
        />
      </CardContent>
    </Card>
  );
}
