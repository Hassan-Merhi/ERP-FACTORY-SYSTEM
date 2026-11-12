/**
 * DeductDialog — extracted sub-component.
 *
 * Extracted from FactorySheetsAndSacks.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

import type { SheetsAndSacksItem } from "../types";

export // ─── Deduct Dialog ────────────────────────────────────────────────────────────
function DeductDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item: SheetsAndSacksItem }) {
  const { toast } = useToast();
  const hasPacks = item.pcsPerPack != null && item.pcsPerPack > 0;
  const [packsStr, setPacksStr] = useState("");
  const [pcsStr, setPcsStr] = useState("");
  const [notes, setNotes] = useState("");

  const pcsToDeduct = useMemo(() => {
    if (hasPacks && packsStr !== "") return (parseInt(packsStr) || 0) * (item.pcsPerPack as number);
    return parseInt(pcsStr) || 0;
  }, [hasPacks, packsStr, pcsStr, item.pcsPerPack]);

  const currentQty = parseFloat(item.quantity || "0");
  const remaining = Math.max(0, currentQty - pcsToDeduct);

  const recordChanges = useExistingRecordChangeAccess();
  const deductMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/factory/sheets-sacks/${item.id}/deduct`, {
        pieces: pcsToDeduct,
        packs: hasPacks && packsStr !== "" ? parseInt(packsStr) || 0 : null,
        notes: notes.trim() || null,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Deduction failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks/log"] });
      toast({
        title: "Deduction recorded",
        description: `${pcsToDeduct.toLocaleString()} pcs removed from ${item.name}`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Deduction failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Deduct from {item.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Current stock</span>
            <span className="font-mono font-semibold">{currentQty.toLocaleString("en-US")} pcs</span>
          </div>
          {hasPacks && (
            <div className="space-y-1.5">
              <Label>
                Packs to deduct <span className="text-muted-foreground text-xs">(× {item.pcsPerPack} pcs/pack)</span>
              </Label>
              <Input
                type="number"
                min="0"
                value={packsStr}
                onChange={(e) => {
                  setPacksStr(e.target.value);
                  setPcsStr("");
                }}
                placeholder="0"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{hasPacks ? "Or pieces to deduct" : "Pieces to deduct"}</Label>
            <Input
              type="number"
              min="0"
              value={hasPacks ? (packsStr !== "" ? String(pcsToDeduct) : pcsStr) : pcsStr}
              onChange={(e) => {
                setPcsStr(e.target.value);
                if (hasPacks) setPacksStr("");
              }}
              readOnly={hasPacks && packsStr !== ""}
              placeholder="0"
            />
          </div>
          <div
            className={`rounded-md px-3 py-2 flex items-center justify-between text-sm ${remaining === 0 && pcsToDeduct > 0 ? "bg-destructive/10" : "bg-muted/50"}`}
          >
            <span className="text-muted-foreground">Remaining after deduction</span>
            <span className={`font-mono font-semibold ${remaining === 0 && pcsToDeduct > 0 ? "text-destructive" : ""}`}>
              {remaining.toLocaleString("en-US")} pcs
            </span>
          </div>
          <div className="space-y-1.5">
            <Label>
              Reason / Notes <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Used in production batch #42"
              className="resize-none"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => deductMutation.mutate()}
            disabled={pcsToDeduct <= 0 || deductMutation.isPending}
          >
            {deductMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Deduct {pcsToDeduct > 0 ? `${pcsToDeduct.toLocaleString()} pcs` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Restock Dialog ───────────────────────────────────────────────────────────
