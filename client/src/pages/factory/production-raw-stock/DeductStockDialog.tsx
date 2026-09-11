import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";
import type { RawStockRow } from "./RawStockTable";

export interface DeductStockPayload {
  supplierId: number | null;
  kg: string;
  notes: string;
  reference: string;
  costPerKg?: string;
  currencyCode: string;
}

interface MutationLike<TVars> {
  isPending: boolean;
  mutate: (vars: TVars) => void;
}

interface DeductStockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deductingRow: RawStockRow | null;
  deductReceivedMutation: MutationLike<DeductStockPayload>;
  wrapAdminAction: (action: () => void, title: string) => void;
}

export function DeductStockDialog({
  open,
  onOpenChange,
  deductingRow,
  deductReceivedMutation,
  wrapAdminAction,
}: DeductStockDialogProps) {
  const [deductKg, setDeductKg] = useState("");
  const [deductNotes, setDeductNotes] = useState("");
  const [deductReference, setDeductReference] = useState("");

  const handleSubmit = () => {
    if (!deductKg || parseFloat(deductKg) <= 0) return;
    deductReceivedMutation.mutate({
      supplierId: deductingRow?.supplierId ?? null,
      kg: deductKg,
      notes: deductNotes,
      reference: deductReference,
      costPerKg: deductingRow?.costPerKgUsd || deductingRow?.costPerKg || undefined,
      currencyCode: "USD",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Deduct Received Stock
          </DialogTitle>
          <DialogDescription>
            Permanently remove weight from received stock (e.g. for damage, loss, or waste).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <p className="font-medium">{deductingRow?.supplierName}</p>
            <p className="text-muted-foreground mt-1">
              Available to deduct: {deductingRow?.freeKg || deductingRow?.receivedKg} kg
            </p>
          </div>

          <div className="space-y-1">
            <Label>Quantity to Deduct (KG)</Label>
            <Input
              type="number"
              step="0.001"
              value={deductKg}
              onChange={(e) => setDeductKg(e.target.value)}
              placeholder="0.000"
            />
          </div>

          <div className="space-y-1">
            <Label>Reference (optional)</Label>
            <Input
              value={deductReference}
              onChange={(e) => setDeductReference(e.target.value)}
              placeholder="e.g. Waste Log #55"
            />
          </div>

          <div className="space-y-1">
            <Label>Notes (optional)</Label>
            <Textarea
              value={deductNotes}
              onChange={(e) => setDeductNotes(e.target.value)}
              placeholder="Reason for deduction..."
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => wrapAdminAction(handleSubmit, "Deduct Stock")}
              disabled={deductReceivedMutation.isPending || !deductKg}
            >
              {deductReceivedMutation.isPending ? "Deducting..." : "Confirm Deduction"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
