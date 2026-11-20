import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * PostAccountingPreviewDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useAdvancesModel } from "../advances/useAdvancesModel";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
import { Fragment } from "react";
import { BookOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { fmt } from "../utils";

export function PostAccountingPreviewDialog({
  cashAccounts,
  formatDate,
  postAccountingMutation,
  postAccountingOpen,
  postCashAccountId,
  setPostAccountingOpen,
  setPostCashAccountId,
  unvouchered,
  unvoucheredLoading,
}: {
  cashAccounts: AdvancesModel["cashAccounts"];
  formatDate: AdvancesModel["formatDate"];
  postAccountingMutation: AdvancesModel["postAccountingMutation"];
  postAccountingOpen: AdvancesModel["postAccountingOpen"];
  postCashAccountId: AdvancesModel["postCashAccountId"];
  setPostAccountingOpen: AdvancesModel["setPostAccountingOpen"];
  setPostCashAccountId: AdvancesModel["setPostCashAccountId"];
  unvouchered: AdvancesModel["unvouchered"];
  unvoucheredLoading: AdvancesModel["unvoucheredLoading"];
}) {
  return (
    <Dialog
      open={postAccountingOpen}
      onOpenChange={(open) => {
        setPostAccountingOpen(open);
        if (!open) setPostCashAccountId("");
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Post Accounting for Old Advances — Preview</DialogTitle>
          <DialogDescription>
            Creates a Payment voucher (DR Factory Worker Advances / CR Cash) for every advance that has no accounting
            entry yet. Review what will be posted before confirming.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>
              Cash Account to Credit <span className="text-destructive">*</span>
            </Label>
            <UnifiedAccountPicker
                options={(cashAccounts || []).map((account) => ({ value: String(account.id), name: account.name }))}
                value={postCashAccountId}
                onChange={setPostCashAccountId}
                placeholder={"Select cash account"}
                testId={"select-post-cash-account"}
              />
          </div>

          {unvoucheredLoading ? (
            <LoadingState className="py-6" />
          ) : !unvouchered?.length ? (
            <EmptyState
              icon={BookOpen}
              title="No unvouchered advances found"
              description="All advances already have accounting entries"
              className="py-8"
            />
          ) : (
            (() => {
              const selectedAcct = (cashAccounts || []).find((a) => String(a.id) === postCashAccountId);
              const grandTotal = unvouchered.reduce((sum, advance) => sum + parseFloat(advance.amount || "0"), 0);
              const grouped: Record<string, typeof unvouchered> = {};
              for (const adv of unvouchered) {
                const key = adv.workerName || `Worker #${adv.workerId}`;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(adv);
              }

              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Advances to Post</p>
                      <p className="font-bold">{unvouchered.length}</p>
                    </div>
                    <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground mb-1">DR Factory Advances</p>
                      <p className="font-bold font-mono text-blue-700 dark:text-blue-400">{fmt(grandTotal)}</p>
                    </div>
                    <div className="rounded-md bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground mb-1">
                        CR {selectedAcct ? selectedAcct.name : "Cash Account"}
                      </p>
                      <p className="font-bold font-mono text-amber-700 dark:text-amber-400">{fmt(grandTotal)}</p>
                    </div>
                  </div>

                  <div className="border rounded-md overflow-hidden">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/20">
                      <span>Worker / Date</span>
                      <span className="text-right">Type</span>
                      <span className="text-right text-blue-600 dark:text-blue-400">DR Advances</span>
                      <span className="text-right text-amber-600 dark:text-amber-400">
                        CR {selectedAcct?.name ?? "Cash"}
                      </span>
                    </div>
                    <div className="divide-y max-h-56 overflow-y-auto">
                      {Object.entries(grouped).map(([workerName, advs]) => (
                        <Fragment key={workerName}>
                          <div className="px-4 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground flex justify-between">
                            <span>{workerName}</span>
                            <span className="font-mono">
                              {fmt(advs.reduce((sum, advance) => sum + parseFloat(advance.amount || "0"), 0))}
                            </span>
                          </div>
                          {advs.map((adv) => (
                            <div
                              key={adv.id}
                              className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 text-sm items-center"
                              data-testid={`row-unvouchered-${adv.id}`}
                            >
                              <span className="text-muted-foreground text-xs">{formatDate(adv.advanceDate)}</span>
                              <Badge variant="outline" className="text-xs">
                                {adv.repaymentType === "manual_repayment" ? "Loan" : "Salary Ded."}
                              </Badge>
                              <span className="font-mono text-right text-blue-700 dark:text-blue-400">
                                {fmt(adv.amount)}
                              </span>
                              <span className="font-mono text-right text-amber-700 dark:text-amber-400">
                                {fmt(adv.amount)}
                              </span>
                            </div>
                          ))}
                        </Fragment>
                      ))}
                    </div>
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 text-sm font-bold bg-muted/20 border-t">
                      <span>Total</span>
                      <span></span>
                      <span className="font-mono text-right text-blue-700 dark:text-blue-400">{fmt(grandTotal)}</span>
                      <span className="font-mono text-right text-amber-700 dark:text-amber-400">{fmt(grandTotal)}</span>
                    </div>
                  </div>

                  {!postCashAccountId && (
                    <p className="text-xs text-muted-foreground text-center">
                      Select a cash account above to enable posting.
                    </p>
                  )}
                </div>
              );
            })()
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setPostAccountingOpen(false);
              setPostCashAccountId("");
            }}
            data-testid="button-cancel-post-accounting"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!postCashAccountId || !unvouchered?.length) return;
              postAccountingMutation.mutate({ cashAccountId: parseInt(postCashAccountId) });
            }}
            disabled={!postCashAccountId || !unvouchered?.length || postAccountingMutation.isPending}
            data-testid="button-confirm-post-accounting"
          >
            {postAccountingMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Posting…
              </>
            ) : (
              `Confirm — Post ${fmt(unvouchered?.reduce((sum, advance) => sum + parseFloat(advance.amount || "0"), 0) ?? 0)} (${unvouchered?.length ?? 0} entries)`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
