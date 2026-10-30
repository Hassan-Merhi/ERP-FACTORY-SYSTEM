import { useMutation } from "@tanstack/react-query";
import { RefreshCw, Shield } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type RefreshTarget = "regular" | "privileged";

const REFRESH_ENDPOINTS: Record<RefreshTarget, string> = {
  regular: "/api/admin/force-refresh-all",
  privileged: "/api/admin/force-refresh-privileged",
};

export function GlobalForceRefreshCard() {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async (target: RefreshTarget) => {
      await apiRequest("POST", REFRESH_ENDPOINTS[target], {});
    },
    onSuccess: (_data, target) => {
      toast({
        title: target === "regular" ? "Refresh sent to regular users" : "Refresh sent to admins, owners and developers",
        description: "Targeted users will see a five-second countdown and refresh automatically.",
      });
      // Only the privileged command targets this administrator's own browser.
      // Check immediately instead of waiting for the next 15-second poll.
      if (target === "privileged") {
        window.dispatchEvent(new Event("erp:check-build-info"));
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Could not force refresh",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Card className="border-amber-300/50" data-testid="card-global-force-refresh">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <RefreshCw className="h-4 w-4" /> Refresh Regular Users
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Refresh all logged-in users except Admin, Owner and Developer.
              Their browsers show a five-second countdown, then refresh automatically.
            </p>
          </div>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("regular")}
            data-testid="button-force-refresh-all-users"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {mutation.isPending && mutation.variables === "regular" ? "Sending…" : "Force Refresh Regular Users"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <Shield className="h-4 w-4" /> Refresh Admin / Owner / Developer
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Separately refresh only Admin, Owner and Developer sessions.
              Regular users are not affected.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("privileged")}
            data-testid="button-force-refresh-privileged-users"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {mutation.isPending && mutation.variables === "privileged" ? "Sending…" : "Force Refresh Admin / Owner / Dev"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          No confirmation prompts. Targeted devices refresh five seconds after receiving the command.
          Offline or suspended devices catch up when they reconnect or resume.
        </p>
      </CardContent>
    </Card>
  );
}
