import { useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import type { ClientErrorLike } from "@/lib/clientError";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CONFIRMATION = "CLEAR ALL INSURANCE";

interface InsuranceClearDialogProps {
  open: boolean;
  companyName?: string;
  onClose: () => void;
}

export function InsuranceClearDialog({ open, companyName, onClose }: InsuranceClearDialogProps) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [confirmation, setConfirmation] = useState("");

  const close = () => {
    if (clearMutation.isPending) return;
    setConfirmation("");
    onClose();
  };

  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("POST", "/api/insurance/admin/clear-all", { confirmation });
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries();
      toast({
        title: "Insurance records cleared",
        description: `${result.membersDeleted} member(s), ${result.vouchersDeleted} voucher(s), and ${result.ledgerAccountsArchived} Insurance account(s) removed.`,
      });
      close();
    },
    onError: (error: ClientErrorLike) =>
      toast({ title: "Clear failed", description: error.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            Clear All Insurance Records
          </DialogTitle>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>This permanently deletes accounting history</AlertTitle>
          <AlertDescription>
            For {companyName || "the selected company"}, this removes all Insurance members, monthly imported amounts,
            Insurance vouchers and voucher entries, and archives the Insurance ledger accounts. Other modules and
            unrelated vouchers are not touched.
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label htmlFor="insurance-clear-confirmation">
            Type <span className="font-mono font-semibold">{CONFIRMATION}</span> to continue
          </Label>
          <Input
            id="insurance-clear-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            data-testid="input-clear-insurance-confirmation"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={clearMutation.isPending}>
            Cancel
          </Button>
          {recordChanges.allowed && (
            <Button
              variant="destructive"
              onClick={() => clearMutation.mutate()}
              disabled={confirmation !== CONFIRMATION || clearMutation.isPending}
              data-testid="button-confirm-clear-insurance"
            >
              {clearMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Delete All Insurance Data
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
