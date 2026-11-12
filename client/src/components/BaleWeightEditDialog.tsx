import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

export interface WeightEditBale {
  id: number;
  referenceNumber: string;
  weightKg: number | string;
}

export function BaleWeightEditDialog({
  bale,
  onClose,
  onSuccess,
}: {
  bale: WeightEditBale | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [newWeight, setNewWeight] = useState("");
  const recordChanges = useExistingRecordChangeAccess();

  // Reset input whenever a different bale is opened
  useEffect(() => {
    if (bale) setNewWeight("");
  }, [bale]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setNewWeight("");
      onClose();
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const w = parseFloat(newWeight);
      if (isNaN(w) || w <= 0) throw new Error("Enter a valid positive weight.");
      return apiRequest("PATCH", `/api/factory/bales/${bale!.id}/weight`, { weightKg: w.toFixed(3) });
    },
    onSuccess: () => {
      toast({
        title: "Weight corrected",
        description: `${bale!.referenceNumber}: ${Number(bale!.weightKg).toFixed(3)} kg → ${parseFloat(newWeight).toFixed(3)} kg. Updated in bale, loads, invoices, and orders.`,
      });
      setNewWeight("");
      onClose();
      onSuccess();
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  if (!bale) return null;

  return (
    <Dialog open={!!bale} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Correct Bale Weight</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm space-y-1">
            <div className="text-muted-foreground">Reference</div>
            <div className="font-mono font-medium">{bale.referenceNumber}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Current weight (kg)</Label>
              <div className="font-mono text-sm px-3 py-2 rounded-md border bg-muted/30">
                {Number(bale.weightKg).toFixed(3)}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bale-new-weight">New weight (kg)</Label>
              <Input
                id="bale-new-weight"
                type="number"
                min="0.001"
                step="0.001"
                placeholder="e.g. 40.000"
                value={newWeight}
                onChange={(e) => setNewWeight(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && recordChanges.allowed && newWeight && parseFloat(newWeight) > 0)
                    mutation.mutate();
                }}
                autoFocus
                data-testid="input-new-weight"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Updates the bale record, loading orders, invoice scans, and customer order lines. Cost is recalculated
            automatically.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {recordChanges.allowed && (
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !newWeight || parseFloat(newWeight) <= 0}
              data-testid="button-confirm-weight"
            >
              {mutation.isPending ? "Saving…" : "Save Weight"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
