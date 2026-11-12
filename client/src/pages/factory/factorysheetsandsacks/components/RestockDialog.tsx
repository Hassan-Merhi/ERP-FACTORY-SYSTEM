/**
 * RestockDialog — extracted sub-component.
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

export // ─── Restock Dialog ───────────────────────────────────────────────────────────
function RestockDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item: SheetsAndSacksItem }) {
  const { toast } = useToast();
  const hasPacks = item.pcsPerPack != null && item.pcsPerPack > 0;
  const [packsStr, setPacksStr] = useState("");
  const [pcsStr, setPcsStr] = useState("");
  const [notes, setNotes] = useState("");

  const pcsToAdd = useMemo(() => {
    if (hasPacks && packsStr !== "") return (parseInt(packsStr) || 0) * (item.pcsPerPack as number);
    return parseInt(pcsStr) || 0;
  }, [hasPacks, packsStr, pcsStr, item.pcsPerPack]);

  const currentQty = parseFloat(item.quantity || "0");
  const newTotal = currentQty + pcsToAdd;

  const recordChanges = useExistingRecordChangeAccess();
  const restockMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/factory/sheets-sacks/${item.id}/restock`, {
        pieces: pcsToAdd,
        packs: hasPacks && packsStr !== "" ? parseInt(packsStr) || 0 : null,
        notes: notes.trim() || null,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Restock failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks/log"] });
      toast({ title: "Stock added", description: `${pcsToAdd.toLocaleString()} pcs added to ${item.name}` });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Restock failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Stock — {item.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Current stock</span>
            <span className="font-mono font-semibold">{currentQty.toLocaleString("en-US")} pcs</span>
          </div>
          {hasPacks && (
            <div className="space-y-1.5">
              <Label>
                Packs to add <span className="text-muted-foreground text-xs">(× {item.pcsPerPack} pcs/pack)</span>
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
            <Label>{hasPacks ? "Or pieces to add" : "Pieces to add"}</Label>
            <Input
              type="number"
              min="0"
              value={hasPacks ? (packsStr !== "" ? String(pcsToAdd) : pcsStr) : pcsStr}
              onChange={(e) => {
                setPcsStr(e.target.value);
                if (hasPacks) setPacksStr("");
              }}
              readOnly={hasPacks && packsStr !== ""}
              placeholder="0"
            />
          </div>
          <div className="rounded-md bg-green-50 dark:bg-green-950/30 px-3 py-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">New total after add</span>
            <span className="font-mono font-semibold text-green-700 dark:text-green-400">
              {newTotal.toLocaleString("en-US")} pcs
            </span>
          </div>
          <div className="space-y-1.5">
            <Label>
              Reason / Notes <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. New delivery from supplier"
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
            className="bg-green-600 hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600 text-white"
            onClick={() => restockMutation.mutate()}
            disabled={pcsToAdd <= 0 || restockMutation.isPending}
          >
            {restockMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Add {pcsToAdd > 0 ? `${pcsToAdd.toLocaleString()} pcs` : "Stock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Movement Log ─────────────────────────────────────────────────────────────
