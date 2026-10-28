import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function GlobalForceRefreshCard() {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/force-refresh-all", {});
    },
    onSuccess: () => {
      setConfirmOpen(false);
      toast({
        title: "Refresh sent to all users",
        description: "Active sessions will reload automatically. Background or offline devices refresh when they reconnect.",
      });
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
    <>
      <Card className="border-amber-300/50" data-testid="card-global-force-refresh">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <RefreshCw className="h-4 w-4" /> Force Refresh All Users
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Hard reload ERP + Factory on every logged-in device, including Android and iPhone browsers.
              Users with suspended or offline apps will update when they return online.
            </p>
          </div>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => setConfirmOpen(true)}
            data-testid="button-force-refresh-all-users"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Force Refresh All
          </Button>
        </CardContent>
      </Card>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force refresh every logged-in user?</AlertDialogTitle>
            <AlertDialogDescription>
              This will reload all open ERP + Factory sessions, including this device.
              Unsaved form changes and in-progress work may be lost. It does not sign users out.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-force-refresh-all"
            >
              {mutation.isPending ? "Sending…" : "Force refresh everyone"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
