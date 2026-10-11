import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import type { useFactoryStockAllocationV5Model } from "../useFactoryStockAllocationV5Model";

type Model = ReturnType<typeof useFactoryStockAllocationV5Model>;
export function FactoryStockAllocationV5Dialog2({ model }: { model: Model }) {
  const { editDraftDialog, setEditDraftDialog, editDraftQtys, setEditDraftQtys, editDraftMut, submitEditDraft } = model;
  return (
    <Dialog
      open={!!editDraftDialog}
      onOpenChange={(open) => {
        if (!open) setEditDraftDialog(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-muted-foreground" />
            Edit Draft Quantities
          </DialogTitle>
        </DialogHeader>

        {editDraftDialog && (
          <div className="flex flex-col gap-4 py-1">
            <p className="text-sm text-muted-foreground">
              Editing expected quantities for{" "}
              <span className="font-semibold text-foreground">{editDraftDialog.proformaName}</span>.
            </p>

            {editDraftDialog.articles.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No eligible draft containers found.</p>
            ) : (
              <div className="rounded-md border text-xs overflow-hidden">
                <div className="grid grid-cols-[1fr_60px_80px_64px] bg-muted px-3 py-2 gap-3 font-medium text-muted-foreground border-b">
                  <span>Article</span>
                  <span className="text-right">Current</span>
                  <span className="text-right">New Qty</span>
                  <span className="text-right">Ctrs</span>
                </div>
                {editDraftDialog.articles.map((a) => (
                  <div
                    key={a.articleCode}
                    className="grid grid-cols-[1fr_60px_80px_64px] px-3 py-2 gap-3 items-center border-b last:border-0"
                  >
                    <div>
                      <div className="font-medium truncate max-w-[180px]" title={a.productName}>
                        {a.productName}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono">{a.articleCode}</div>
                    </div>
                    <span className="text-right font-mono tabular-nums text-muted-foreground">
                      {a.currentExpectedQty}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      className="w-full h-7 text-xs text-right"
                      value={editDraftQtys[a.articleCode] ?? a.currentExpectedQty}
                      onChange={(e) =>
                        setEditDraftQtys((prev) => ({
                          ...prev,
                          [a.articleCode]: Math.max(0, parseInt(e.target.value) || 0),
                        }))
                      }
                      data-testid={`input-v5-edit-draft-qty-${a.articleCode}`}
                    />
                    <span className="text-right text-muted-foreground tabular-nums font-mono">{a.eligibleCount}×</span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
              Only draft containers that have not started loading will be updated. Existing loaded containers will not
              change.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setEditDraftDialog(null)} data-testid="button-v5-edit-draft-cancel">
            Cancel
          </Button>
          <Button
            onClick={submitEditDraft}
            disabled={editDraftMut.isPending || !editDraftDialog || editDraftDialog.articles.length === 0}
            data-testid="button-v5-edit-draft-submit"
          >
            {editDraftMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
