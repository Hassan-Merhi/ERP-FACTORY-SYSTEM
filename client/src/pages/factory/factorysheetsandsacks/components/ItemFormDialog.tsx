import type { ClientErrorLike } from "@/lib/clientError";
/**
 * ItemFormDialog — extracted sub-component.
 *
 * Extracted from FactorySheetsAndSacks.tsx during the Phase 4 god-file split.
 */
import { useId, useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { Input } from "@/components/ui/input";
import { DecimalInput, MoneyInput } from "@/components/ui/decimal-input";
import { FormGrid } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type { SheetsAndSacksItem } from "../types";
import { TYPES, fmt } from "../utils";
import { ColorPicker } from "./ColorPicker";

export // ─── Item Form Dialog ─────────────────────────────────────────────────────────
function ItemFormDialog({
  open,
  onClose,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  existing?: SheetsAndSacksItem | null;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [type, setType] = useState<string>(existing?.type ?? "Sheet");
  const [name, setName] = useState(existing?.name ?? "");
  const [size, setSize] = useState(existing?.size ?? "");
  const [packQty, setPackQty] = useState(existing?.packQty != null ? String(existing.packQty) : "");
  const [pcsPerPack, setPcsPerPack] = useState(existing?.pcsPerPack != null ? String(existing.pcsPerPack) : "");
  const [unitPrice, setUnitPrice] = useState(existing?.unitPrice ?? "");
  const [rowColor, setRowColor] = useState(existing?.rowColor ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const totalPcs = useMemo(() => (parseInt(packQty) || 0) * (parseInt(pcsPerPack) || 0), [packQty, pcsPerPack]);
  const totalValue = useMemo(() => totalPcs * (parseFloat(unitPrice) || 0), [totalPcs, unitPrice]);

  const recordChanges = useExistingRecordChangeAccess();
  const saveMutation = useMutation({
    mutationFn: async (data: {
      type: string;
      name: string;
      size: string | null;
      quantity: number;
      packQty: number | null;
      pcsPerPack: number | null;
      unitPrice: number;
      rowColor: string | null;
      notes: string | null;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (existing) return apiRequest("PATCH", `/api/factory/sheets-sacks/${existing.id}`, data);
      return apiRequest("POST", "/api/factory/sheets-sacks", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks"] });
      toast({ title: existing ? "Item updated" : "Item added" });
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const handleSubmit = () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    saveMutation.mutate({
      type,
      name: name.trim(),
      size: size.trim() || null,
      quantity: totalPcs,
      packQty: packQty !== "" ? parseInt(packQty) : null,
      pcsPerPack: pcsPerPack !== "" ? parseInt(pcsPerPack) : null,
      unitPrice: parseFloat(unitPrice) || 0,
      rowColor: rowColor || null,
      notes: notes.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit Item" : "Add Item"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-type`}>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id={`${formId}-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${formId}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Purple Sheet 50kg"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-size`}>Size / Weight</Label>
            <Input
              id={`${formId}-size`}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="e.g. 50kg, 100×80cm"
            />
          </div>
          <FormGrid minColumnWidth="9rem" className="gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-packs`}>Qty (packs)</Label>
              <DecimalInput
                id={`${formId}-packs`}
                step="1"
                min="0"
                value={packQty}
                onChange={(e) => setPackQty(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-pieces`}># / Pack (pcs)</Label>
              <DecimalInput
                id={`${formId}-pieces`}
                step="1"
                min="0"
                value={pcsPerPack}
                onChange={(e) => setPcsPerPack(e.target.value)}
                placeholder="0"
              />
            </div>
          </FormGrid>
          <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total pcs</span>
            <span className="font-mono font-semibold">{totalPcs.toLocaleString("en-US")}</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-price`}>Price per piece ($)</Label>
            <MoneyInput
              id={`${formId}-price`}
              min="0"
              step="0.001"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              placeholder="0.000"
            />
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total value</span>
            <span className="font-mono font-semibold">${fmt(totalValue)}</span>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Row Color</p>
            <ColorPicker value={rowColor} onChange={setRowColor} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-notes`}>Notes</Label>
            <Textarea
              id={`${formId}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              className="resize-none"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <FormSubmitButton
            type="button"
            onClick={handleSubmit}
            pending={saveMutation.isPending}
            pendingLabel="Saving…"
          >
            {existing ? "Update" : "Add Item"}
          </FormSubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Deduct Dialog ────────────────────────────────────────────────────────────
