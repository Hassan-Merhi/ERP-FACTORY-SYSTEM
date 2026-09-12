/**
 * SaveAsRevisionDialog — extracted from StockTransferForm.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GitBranch } from "lucide-react";

export function SaveAsRevisionDialog({
  computeTransferRevisionItems,
  confirmTransferSaveAsRevision,
  isTransferSavingRevision,
  setTransferRevisionDialogOpen,
  setTransferRevisionNote,
  transferRevisionDialogOpen,
  transferRevisionNote,
  transferRevisions,
}: {
  computeTransferRevisionItems: () => {
    stockItemId: number;
    stockItemName: string;
    sourceLocationId: number | null;
    sourceLocationName: string;
    originalQuantity: number;
    delta: number;
    newQuantity: number;
  }[];
  confirmTransferSaveAsRevision: () => Promise<void>;
  isTransferSavingRevision: boolean;
  setTransferRevisionDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTransferRevisionNote: React.Dispatch<React.SetStateAction<string>>;
  transferRevisionDialogOpen: boolean;
  transferRevisionNote: string;
  transferRevisions: readonly unknown[];
}) {
  return (
    <Dialog open={transferRevisionDialogOpen} onOpenChange={setTransferRevisionDialogOpen}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Save as Revision
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will update the transfer <strong>and</strong> record the changes as{" "}
            <strong>Rev {transferRevisions.length + 1}</strong>.
          </p>
          {(() => {
            const items = computeTransferRevisionItems();
            return items.length === 0 ? (
              <p className="text-sm status-warning rounded-md px-3 py-2">
                No differences detected compared to the saved transfer.
              </p>
            ) : (
              <div className="border rounded-md overflow-hidden text-sm">
                <table className="w-full">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-2 font-medium">Item</th>
                      <th className="text-right p-2 font-medium">Was</th>
                      <th className="text-right p-2 font-medium">Change</th>
                      <th className="text-right p-2 font-medium">Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="p-2 font-medium truncate max-w-[120px]">{item.stockItemName}</td>
                        <td className="p-2 text-right font-mono text-muted-foreground">
                          {formatNumber(item.originalQuantity, 0)}
                        </td>
                        <td
                          className={`p-2 text-right font-mono font-semibold ${item.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                        >
                          {item.delta > 0 ? "+" : ""}
                          {formatNumber(item.delta, 0)}
                        </td>
                        <td className="p-2 text-right font-mono">{formatNumber(item.newQuantity, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
          <div className="space-y-1.5">
            <Label htmlFor="transfer-revision-note">Note (optional)</Label>
            <Textarea
              id="transfer-revision-note"
              placeholder="Why was this revised? e.g. Shop sold 10 bales"
              value={transferRevisionNote}
              onChange={(e) => setTransferRevisionNote(e.target.value)}
              rows={2}
              data-testid="input-transfer-revision-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setTransferRevisionDialogOpen(false)}
            disabled={isTransferSavingRevision}
          >
            Cancel
          </Button>
          <Button
            onClick={confirmTransferSaveAsRevision}
            disabled={isTransferSavingRevision || computeTransferRevisionItems().length === 0}
            data-testid="button-confirm-transfer-revision"
          >
            {isTransferSavingRevision ? "Saving..." : "Save Revision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
