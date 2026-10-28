import { useMutation } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function GlobalForceRefreshCard() {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/force-refresh-all", {});
    },
    onSuccess: () => {
      toast({
        title: "Refresh sent to all users",
        description: "Every connected user will see a five-second notice and refresh automatically.",
      });
      // The administrator's device should get the same countdown without
      // waiting for the next 15-second server check.
      window.dispatchEvent(new Event("erp:check-build-info"));
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
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <RefreshCw className="h-4 w-4" /> Force Refresh All Users
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Immediately send a refresh command to all logged-in ERP + Factory browsers.
            Each connected user sees a five-second countdown and then refreshes automatically.
            Offline or suspended devices refresh when they reconnect or resume.
          </p>
        </div>
        <Button
          variant="destructive"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          data-testid="button-force-refresh-all-users"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {mutation.isPending ? "Sending…" : "Force Refresh All"}
        </Button>
      </CardContent>
    </Card>
  );
}
