import type { ClientErrorLike } from "@/lib/clientError";
/**
 * VacantUnitInfoForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {} from "lucide-react";
import type { Unit } from "../types";
import { useApiBase } from "../shared";

export // ──────────────────────────────────────────────────────────
// START CONTRACT (vacant unit)
// ──────────────────────────────────────────────────────────
function VacantUnitInfoForm({ unit, testIdPrefix }: { unit: Unit; testIdPrefix: string }) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const [unitNumber, setUnitNumber] = useState(unit.unitNumber);
  const [dimensions, setDimensions] = useState(unit.dimensions ?? "");

  const saveUnit = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `${apiBase}/units/${unit.id}`, { unitNumber, dimensions: dimensions || null }),
    onSuccess: () => {
      toast({ title: "Unit info updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const changed = unitNumber !== unit.unitNumber || dimensions !== (unit.dimensions ?? "");

  return (
    <div className="space-y-4 pt-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label>Unit Name</Label>
          <Input
            value={unitNumber}
            onChange={(e) => setUnitNumber(e.target.value.toUpperCase())}
            data-testid={`input-${testIdPrefix}-vacant-unit-number`}
          />
        </div>
        <div>
          <Label>Dimensions</Label>
          <Input
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="e.g. 35 X 12"
            data-testid={`input-${testIdPrefix}-vacant-dimensions`}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={() => saveUnit.mutate()}
          disabled={!changed || !unitNumber || saveUnit.isPending}
          data-testid={`button-${testIdPrefix}-save-vacant-unit`}
        >
          {saveUnit.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
