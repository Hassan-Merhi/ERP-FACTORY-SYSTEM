import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * GenerateMissingAccountingEntryDialog — extracted from FactoryWorkerDetail.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryWorkerDetailModel } from "../../factoryworkerdetail/useFactoryWorkerDetailModel";

type FactoryWorkerDetailModel = ReturnType<typeof useFactoryWorkerDetailModel>;
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function GenerateMissingAccountingEntryDialog({
  cashAccounts,
  fixAcctCashId,
  fixAcctMutation,
  fixAcctOpen,
  fixAcctTargetId,
  setFixAcctCashId,
  setFixAcctOpen,
  setFixAcctTargetId,
  wrapAdminAction,
}: {
  cashAccounts: FactoryWorkerDetailModel["cashAccounts"];
  fixAcctCashId: FactoryWorkerDetailModel["fixAcctCashId"];
  fixAcctMutation: FactoryWorkerDetailModel["fixAcctMutation"];
  fixAcctOpen: FactoryWorkerDetailModel["fixAcctOpen"];
  fixAcctTargetId: FactoryWorkerDetailModel["fixAcctTargetId"];
  setFixAcctCashId: FactoryWorkerDetailModel["setFixAcctCashId"];
  setFixAcctOpen: FactoryWorkerDetailModel["setFixAcctOpen"];
  setFixAcctTargetId: FactoryWorkerDetailModel["setFixAcctTargetId"];
  wrapAdminAction: FactoryWorkerDetailModel["wrapAdminAction"];
}) {
  return (
    <Dialog
      open={fixAcctOpen}
      onOpenChange={(open) => {
        if (!open) {
          setFixAcctOpen(false);
          setFixAcctTargetId(null);
          setFixAcctCashId("");
        }
      }}
    >
      <DialogContent data-testid="dialog-fix-acct">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-amber-500" />
            Generate Missing Accounting Entry
          </DialogTitle>
          <DialogDescription>
            This payroll was marked paid without a cash account. Select an account to create the missing payment
            voucher.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Cash Account</Label>
            <UnifiedAccountPicker
              value={fixAcctCashId}
              onChange={setFixAcctCashId}
              options={(cashAccounts ?? []).map((account) => ({ value: String(account.id), name: account.name }))}
              placeholder="Select cash account"
              testId="select-fix-acct-cash"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFixAcctOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              wrapAdminAction(
                () => fixAcctTargetId && fixAcctMutation.mutate({ id: fixAcctTargetId, cashId: fixAcctCashId }),
                "Generate Entry"
              )
            }
            disabled={fixAcctMutation.isPending || !fixAcctCashId}
            data-testid="button-confirm-fix-acct"
          >
            {fixAcctMutation.isPending ? "Generating..." : "Generate Entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
