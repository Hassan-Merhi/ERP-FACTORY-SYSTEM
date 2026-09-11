/**
 * ApproveRevisionDialog — extracted from StockTransferForm.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

interface RevisionItem {
  stockItemName?: string;
  delta?: string;
  originalQuantity?: string;
  newQuantity?: string;
}

interface Revision {
  id: number;
  revisionNumber?: number;
  sourceLocationName?: string;
  items?: RevisionItem[];
}

interface ApproveRevisionMutation {
  isPending: boolean;
  mutate: (revisionId: number) => void;
}

export function ApproveRevisionDialog({
  approveRevisionMutation,
  approveRevisionTarget,
  setApproveRevisionTarget,
  pendingRevisions = [],
}: {
  approveRevisionMutation: ApproveRevisionMutation;
  approveRevisionTarget: Revision | null;
  setApproveRevisionTarget: (target: Revision | null) => void;
  /**
   * Every revision still awaiting review. Approving one applies all of them,
   * so the dialog previews the whole set rather than just the clicked row.
   */
  pendingRevisions?: Revision[];
}) {
  const revisionsToApply = approveRevisionTarget
    ? pendingRevisions.some((rev) => rev.id === approveRevisionTarget.id)
      ? pendingRevisions
      : [approveRevisionTarget]
    : [];
  const multiple = revisionsToApply.length > 1;

  return (
    <Dialog
      open={!!approveRevisionTarget}
      onOpenChange={(open) => {
        if (!open) setApproveRevisionTarget(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{multiple ? `Approve ${revisionsToApply.length} Revisions` : "Approve Revision"}</DialogTitle>
          <DialogDescription>
            {multiple
              ? "All pending adjustments on this transfer are applied together. This action cannot be undone."
              : "The following quantity changes will be applied to the transfer. This action cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        {revisionsToApply.map((revision) => (
          <div key={revision.id} className="space-y-1">
            {multiple && (
              <p className="text-xs font-medium text-muted-foreground">
                Rev {revision.revisionNumber}
                {revision.sourceLocationName ? ` · ${revision.sourceLocationName}` : ""}
              </p>
            )}
            <div className="table-responsive rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-2 font-medium">Item</th>
                    <th className="text-right p-2 font-medium">Was</th>
                    <th className="text-right p-2 font-medium">Change</th>
                    <th className="text-right p-2 font-medium">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {(revision.items ?? [])
                    .filter((item) => parseFloat(item.delta as string) !== 0)
                    .map((item, idx: number) => {
                      const delta = parseFloat(item.delta as string);
                      return (
                        <tr key={idx} className="border-t">
                          <td className="p-2 font-medium">{item.stockItemName}</td>
                          <td className="p-2 text-right font-mono text-muted-foreground">
                            {formatNumber(parseFloat(item.originalQuantity as string), 0)}
                          </td>
                          <td
                            className={`p-2 text-right font-mono font-semibold ${delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                          >
                            {delta > 0 ? "+" : ""}
                            {formatNumber(delta, 0)}
                          </td>
                          <td className="p-2 text-right font-mono font-semibold">
                            {formatNumber(parseFloat(item.newQuantity as string), 0)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setApproveRevisionTarget(null)}
            data-testid="button-approve-revision-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            disabled={approveRevisionMutation.isPending}
            onClick={() => approveRevisionTarget && approveRevisionMutation.mutate(approveRevisionTarget.id)}
            data-testid="button-approve-revision-confirm"
          >
            {approveRevisionMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Applying…
              </>
            ) : (
              "Approve & Apply"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
