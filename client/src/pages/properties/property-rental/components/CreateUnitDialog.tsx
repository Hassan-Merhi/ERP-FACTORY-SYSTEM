import type { ClientErrorLike } from "@/lib/clientError";
/**
 * CreateUnitDialog — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {} from "lucide-react";
import { useApiBase } from "../shared";

export // ──────────────────────────────────────────────────────────
// CREATE UNIT DIALOG
// ──────────────────────────────────────────────────────────
function CreateUnitDialog({
  unitType,
  onClose,
  testIdPrefix,
}: {
  unitType: "WAREHOUSE" | "SHOP";
  onClose: () => void;
  testIdPrefix: string;
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const [form, setForm] = useState({ unitNumber: "", locationGroup: "", size: "", dimensions: "", notes: "" });

  const create = useMutation({
    mutationFn: () => apiRequest("POST", apiBase + "/units", { ...form, unitType }),
    onSuccess: () => {
      toast({ title: "Unit created" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid={`dialog-${testIdPrefix}-create`}>
        <DialogHeader>
          <DialogTitle>Add New {unitType === "WAREHOUSE" ? "Warehouse" : "Shop"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Unit # *</Label>
            <Input
              value={form.unitNumber}
              onChange={(e) => setForm((f) => ({ ...f, unitNumber: e.target.value }))}
              placeholder="e.g. KOLWEZI A1"
              data-testid={`input-${testIdPrefix}-unit-number`}
            />
          </div>
          <div>
            <Label>Location Group *</Label>
            <Input
              value={form.locationGroup}
              onChange={(e) => setForm((f) => ({ ...f, locationGroup: e.target.value.toUpperCase() }))}
              placeholder="e.g. KOLWEZI / LSHI / KIWELE"
              data-testid={`input-${testIdPrefix}-location`}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Size</Label>
              <Input
                value={form.size}
                onChange={(e) => setForm((f) => ({ ...f, size: e.target.value }))}
                placeholder="420 m²"
                data-testid={`input-${testIdPrefix}-size`}
              />
            </div>
            <div>
              <Label>Dimensions</Label>
              <Input
                value={form.dimensions}
                onChange={(e) => setForm((f) => ({ ...f, dimensions: e.target.value }))}
                placeholder="35 X 12"
                data-testid={`input-${testIdPrefix}-dim`}
              />
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              data-testid={`input-${testIdPrefix}-notes`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.unitNumber || !form.locationGroup || create.isPending}
            data-testid={`button-${testIdPrefix}-create-submit`}
          >
            {create.isPending ? "Saving…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────
// UNIT ACTION DIALOG (4 tabs + ledger)
// ──────────────────────────────────────────────────────────
