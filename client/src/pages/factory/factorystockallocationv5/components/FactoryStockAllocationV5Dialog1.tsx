import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { useFactoryStockAllocationV5Model } from "../useFactoryStockAllocationV5Model";

type Model = ReturnType<typeof useFactoryStockAllocationV5Model>;
export function FactoryStockAllocationV5Dialog1({ model }: { model: Model }) {
  const {
    addCtDialog,
    setAddCtDialog,
    ctCount,
    ctNames,
    handleCtCountChange,
    handleCtNameChange,
    addContainersMut,
    submitAddContainers,
  } = model;
  return (
    <Dialog
      open={!!addCtDialog}
      onOpenChange={(open) => {
        if (!open) setAddCtDialog(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Containers</DialogTitle>
        </DialogHeader>

        {addCtDialog && (
          <div className="flex flex-col gap-4 py-1">
            <p className="text-sm text-muted-foreground">
              Adding to <span className="font-semibold text-foreground">{addCtDialog.proformaName}</span> (
              {addCtDialog.existingCount} existing container{addCtDialog.existingCount !== 1 ? "s" : ""})
            </p>

            {/* Number of containers */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium w-36 shrink-0">Number to add</label>
              <Input
                type="number"
                min={1}
                max={50}
                value={ctCount}
                onChange={(e) => handleCtCountChange(parseInt(e.target.value) || 1)}
                className="w-24"
                data-testid="input-v5-ct-count"
              />
            </div>

            {/* Editable name list */}
            <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
              {ctNames.map((name, idx) => {
                const isDupe = ctNames.filter((n) => n.trim() === name.trim() && name.trim()).length > 1;
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-6 text-right shrink-0">{idx + 1}.</span>
                    <Input
                      value={name}
                      onChange={(e) => handleCtNameChange(idx, e.target.value)}
                      placeholder={`Container ${addCtDialog.existingCount + idx + 1}`}
                      className={cn("flex-1", isDupe && "border-destructive focus-visible:ring-destructive")}
                      data-testid={`input-v5-ct-name-${idx}`}
                    />
                    {isDupe && <span className="text-[11px] text-destructive shrink-0">duplicate</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setAddCtDialog(null)} data-testid="button-v5-ct-cancel">
            Cancel
          </Button>
          <Button onClick={submitAddContainers} disabled={addContainersMut.isPending} data-testid="button-v5-ct-submit">
            {addContainersMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Adding…
              </>
            ) : (
              `Add ${ctCount} Container${ctCount !== 1 ? "s" : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
