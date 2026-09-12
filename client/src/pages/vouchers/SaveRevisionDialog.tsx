import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GitBranch } from "lucide-react";

type RevisionChange = {
  stockItemName: string;
  originalQuantity: number;
  delta: number;
  newQuantity: number;
};

interface SaveRevisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transferRevisionsCount: number;
  revisionItems: RevisionChange[];
  revisionNote: string;
  setRevisionNote: (note: string) => void;
  isSaving: boolean;
  onConfirm: () => void;
  formatNumber: (num: unknown, decimals?: number) => string;
}

export function SaveRevisionDialog({
  open,
  onOpenChange,
  transferRevisionsCount,
  revisionItems,
  revisionNote,
  setRevisionNote,
  isSaving,
  onConfirm,
  formatNumber,
}: SaveRevisionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            <strong>Rev {transferRevisionsCount + 1}</strong>.
          </p>
          {revisionItems.length === 0 ? (
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
                  {revisionItems.map((item, idx) => (
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
          )}
          <div className="space-y-1.5">
            <Label htmlFor="transfer-revision-note">Note (optional)</Label>
            <Textarea
              id="transfer-revision-note"
              placeholder="Why was this revised? e.g. Shop sold 10 bales"
              value={revisionNote}
              onChange={(e) => setRevisionNote(e.target.value)}
              rows={2}
              data-testid="input-transfer-revision-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isSaving || revisionItems.length === 0}
            data-testid="button-confirm-transfer-revision"
          >
            {isSaving ? "Saving..." : "Save Revision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
