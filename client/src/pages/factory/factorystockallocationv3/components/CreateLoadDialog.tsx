import type { ClientErrorLike } from "@/lib/clientError";
/**
 * CreateLoadDialog — extracted sub-component.
 *
 * Extracted from FactoryStockAllocationV3.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertTriangle, Loader2 } from "lucide-react";

import type { Proforma } from "../types";

export function CreateLoadDialog({
  proforma,
  open,
  onClose,
}: {
  proforma: Proforma | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [loadName, setLoadName] = useState("");
  const [expectedDate, setExpectedDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [notes, setNotes] = useState("");

  const createMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/factory/v3/loads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ proformaId: proforma!.id, loadName, expectedLoadDate: expectedDate, notes }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Load created", description: `"${loadName}" added to Expected to Load.` });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/proformas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
      setLoadName("");
      setNotes("");
      onClose();
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send to Expected to Load</DialogTitle>
        </DialogHeader>
        {proforma && proforma.v3ActiveCount > 0 && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800">
            <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
            <p className="text-sm text-orange-700 dark:text-orange-300">
              This proforma already has {proforma.v3ActiveCount} active loading job(s). You can still create another —
              make sure quantities and bales are correct.
            </p>
          </div>
        )}
        <div className="space-y-4 py-1">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Proforma</Label>
            <p className="text-sm font-medium">
              {proforma?.name} · {proforma?.customerName}
            </p>
          </div>
          <div>
            <Label htmlFor="v3-load-name" className="text-xs mb-1 block">
              Load Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="v3-load-name"
              value={loadName}
              onChange={(e) => setLoadName(e.target.value)}
              placeholder="e.g. Container 1, Truck A"
              data-testid="input-v3-load-name"
            />
          </div>
          <div>
            <Label htmlFor="v3-load-date" className="text-xs mb-1 block">
              Expected Load Date <span className="text-red-500">*</span>
            </Label>
            <Input
              id="v3-load-date"
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
              data-testid="input-v3-load-date"
            />
          </div>
          <div>
            <Label htmlFor="v3-load-notes" className="text-xs mb-1 block">
              Notes
            </Label>
            <Textarea
              id="v3-load-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              data-testid="input-v3-load-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-v3-create-load-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !loadName.trim() || !expectedDate}
            data-testid="button-v3-create-load-submit"
          >
            {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Create Load
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────── Main Page ───────────────────────
