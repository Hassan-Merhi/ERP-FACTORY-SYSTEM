/**
 * SupplierObEdit — extracted sub-component.
 *
 * Extracted from FactoryImport.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";

export function SupplierObEdit() {
  const { toast } = useToast();
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [obValue, setObValue] = useState("");

  const { data: suppliers } = useQuery<{ id: number; name: string; openingBalance: string; parentId: number | null }[]>(
    {
      queryKey: ["/api/factory/suppliers/with-balances"],
      select: (data) =>
        data.map((s) => ({
          id: s.id,
          name: s.name,
          openingBalance: s.openingBalance || "0",
          parentId: s.parentId ?? null,
        })),
    }
  );

  const selectedSupplier = suppliers?.find((s) => s.id.toString() === selectedSupplierId);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("PATCH", `/api/factory/suppliers/${selectedSupplierId}/opening-balance`, {
        openingBalance: obValue,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
      toast({ title: "Saved", description: `Opening balance for ${selectedSupplier?.name} updated to ${obValue}` });
      setSelectedSupplierId("");
      setObValue("");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Edit Supplier Opening Balance</CardTitle>
        <p className="text-sm text-muted-foreground">
          Directly overwrite the opening balance for any factory supplier or sub-supplier. This does not import new
          records — it only updates the opening balance value.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 max-w-md">
        <div className="space-y-2">
          <Label>Supplier</Label>
          <Select
            value={selectedSupplierId}
            onValueChange={(val) => {
              setSelectedSupplierId(val);
              const sup = suppliers?.find((s) => s.id.toString() === val);
              if (sup) setObValue(sup.openingBalance);
            }}
          >
            <SelectTrigger data-testid="select-ob-supplier">
              <SelectValue placeholder="Select supplier..." />
            </SelectTrigger>
            <SelectContent>
              {suppliers?.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>
                  {s.parentId ? "  └ " : ""}
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedSupplier && (
          <>
            <div className="p-3 rounded-md bg-muted text-sm">
              Current opening balance: <span className="font-mono font-medium">{selectedSupplier.openingBalance}</span>
            </div>
            <div className="space-y-2">
              <Label>New Opening Balance (USD)</Label>
              <Input
                type="number"
                step="0.01"
                value={obValue}
                onChange={(e) => setObValue(e.target.value)}
                data-testid="input-ob-new-value"
              />
            </div>
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending || !obValue}
              data-testid="button-ob-save"
            >
              {updateMutation.isPending ? "Saving..." : "Save Opening Balance"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
