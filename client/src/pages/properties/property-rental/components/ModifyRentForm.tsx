import type { ClientErrorLike } from "@/lib/clientError";
/**
 * ModifyRentForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogFooter } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import type { Contract } from "../types";
import { fmtMoneyCurrency } from "../utils";
import { useApiBase } from "../shared";

export // ──────────────────────────────────────────────────────────
// TAB 2: MODIFY RENT
// ──────────────────────────────────────────────────────────
function ModifyRentForm({
  contract,
  testIdPrefix,
  unitId,
}: {
  contract: Contract;
  testIdPrefix: string;
  unitId: number;
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const [newAmount, setNewAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState<"current" | "next">("next");

  const modify = useMutation({
    mutationFn: () => apiRequest("PATCH", `${apiBase}/contracts/${contract.id}/rent`, { newAmount, effectiveFrom }),
    onSuccess: () => {
      toast({ title: "Rental amount updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units", unitId, "detail"] });
      setNewAmount("");
    },
    onError: (e: ClientErrorLike) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const handleEffectiveFromChange = (value: string) => {
    if (value === "current" || value === "next") {
      setEffectiveFrom(value);
    }
  };

  return (
    <div className="space-y-3 pt-3">
      <div className="bg-muted/40 rounded-md p-3 text-sm">
        <span className="text-muted-foreground">Current Rental Amount: </span>
        <span className="font-bold">{fmtMoneyCurrency(contract.rentalAmount, contract.currency)}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>New Rental Amount ({contract.currency || "USD"}) *</Label>
          <Input
            type="number"
            step="0.01"
            value={newAmount}
            onChange={(e) => setNewAmount(e.target.value)}
            data-testid={`input-${testIdPrefix}-new-rent`}
          />
        </div>
        <div>
          <Label>Effective From</Label>
          <RadioGroup value={effectiveFrom} onValueChange={handleEffectiveFromChange} className="flex gap-4 pt-2">
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="current" id={`mc-${contract.id}`} />
              <Label htmlFor={`mc-${contract.id}`} className="font-normal cursor-pointer">
                Current Month
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="next" id={`mn-${contract.id}`} />
              <Label htmlFor={`mn-${contract.id}`} className="font-normal cursor-pointer">
                Next Month
              </Label>
            </div>
          </RadioGroup>
        </div>
      </div>
      <p className="text-xs text-muted-foreground italic">Only updates future months that haven't been paid yet.</p>
      <DialogFooter>
        <Button
          onClick={() => modify.mutate()}
          disabled={!newAmount || modify.isPending}
          data-testid={`button-${testIdPrefix}-save-rent`}
        >
          {modify.isPending ? "Saving…" : "Save New Amount"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// TAB 3: GUARANTEE TO STATEMENT
// ──────────────────────────────────────────────────────────
