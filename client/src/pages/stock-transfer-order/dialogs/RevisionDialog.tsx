/**
 * RevisionDialog — extracted from StockTransferOrder.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { GitBranch } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatNumber } from "@/lib/formatNumber";
import type { StockTransferRevision } from "../../stocktransferorder/types";

export function RevisionDialog({
  computeRevisionItems,
  confirmSaveAsRevision,
  isSavingRevision,
  revisionDialogOpen,
  revisionNote,
  revisions,
  setRevisionDialogOpen,
  setRevisionNote,
}: {
  computeRevisionItems: () => {
    stockItemId: number;
    stockItemName: string;
    sourceLocationId: number | null;
    sourceLocationName: string;
    originalQuantity: number;
    delta: number;
    newQuantity: number;
  }[];
  confirmSaveAsRevision: () => Promise<void>;
  isSavingRevision: boolean;
  revisionDialogOpen: boolean;
  revisionNote: string;
  revisions: StockTransferRevision[];
  setRevisionDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRevisionNote: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <Dialog open={revisionDialogOpen} onOpenChange={setRevisionDialogOpen}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Save as Revision
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will update the order <strong>and</strong> record the changes as{" "}
            <strong>Rev {revisions.length + 1}</strong>.
          </p>
          {(() => {
            const items = computeRevisionItems();
            return items.length === 0 ? (
              <p className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2">
                No differences detected compared to the saved order.
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
            <Label htmlFor="revision-note">Note (optional)</Label>
            <Textarea
              id="revision-note"
              placeholder="Why was this revised? e.g. Shop sold 10 bales of fabric"
              value={revisionNote}
              onChange={(e) => setRevisionNote(e.target.value)}
              rows={2}
              data-testid="input-revision-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRevisionDialogOpen(false)} disabled={isSavingRevision}>
            Cancel
          </Button>
          <Button
            onClick={confirmSaveAsRevision}
            disabled={isSavingRevision || computeRevisionItems().length === 0}
            data-testid="button-confirm-revision"
          >
            {isSavingRevision ? "Saving..." : "Save Revision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
