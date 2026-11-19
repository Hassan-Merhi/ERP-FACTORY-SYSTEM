// Extracted from ./EditMixBatchDialog.tsx
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useEditMixBatchDialogState } from "./useEditMixBatchDialogState";
import { formatUsd } from "@/lib/moneyDisplay";

export function EditMixBatchDialogContent({
  handleRemoveSource,
  handleUpdateSourceWeight,
  historicalSourcesLocked,
  originalSupplierRates,
  selectedSources,
}: Pick<
  ReturnType<typeof useEditMixBatchDialogState>,
  | "handleRemoveSource"
  | "handleUpdateSourceWeight"
  | "historicalSourcesLocked"
  | "originalSupplierRates"
  | "selectedSources"
>) {
  return (
    <div className="border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Weight (kg)</TableHead>
            <TableHead className="text-right">Current $/kg</TableHead>
            <TableHead className="text-right">Estimated cost</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {selectedSources.map((sel) => (
            <TableRow key={`${sel.type}-${sel.sourceId}`}>
              <TableCell>
                <Badge variant={sel.type === "batch" ? "secondary" : "outline"}>
                  {sel.type === "batch" ? "Batch" : "Supplier"}
                </Badge>
              </TableCell>
              <TableCell className="font-medium">{sel.label}</TableCell>
              <TableCell className="text-right">
                <Input
                  type="number"
                  className="h-7 w-28 text-right font-mono text-xs ml-auto"
                  value={sel.weightKg}
                  step="0.001"
                  min="0.001"
                  onChange={(e) => handleUpdateSourceWeight(sel.type, sel.sourceId, e.target.value)}
                  disabled={historicalSourcesLocked}
                  data-testid={`input-weight-${sel.type}-${sel.sourceId}`}
                />
              </TableCell>
              <TableCell className="text-right">
                {sel.type === "supplier" ? (
                  <div className="text-right">
                    <span
                      className="font-mono text-xs text-muted-foreground"
                      data-testid={`text-cost-per-kg-${sel.type}-${sel.sourceId}`}
                      title={
                        historicalSourcesLocked
                          ? "Recorded weighted-average supplier rate at the time of the mix"
                          : "Current supplier rate, used only for an edit estimate"
                      }
                    >
                      {formatUsd(sel.costPerKg, 4)}
                    </span>
                    {!historicalSourcesLocked && originalSupplierRates.has(sel.sourceId) && (
                      <div
                        className="text-[11px] text-muted-foreground"
                        title="Saved weighted-average supplier cost in this batch"
                      >
                        Recorded: {formatUsd(originalSupplierRates.get(sel.sourceId)!, 4)}
                      </div>
                    )}
                  </div>
                ) : (
                  <span
                    className="font-mono text-xs text-muted-foreground"
                    title="Recorded cost of the upstream batch. Only its source/weight can be changed."
                    data-testid={`text-cost-per-kg-${sel.type}-${sel.sourceId}`}
                  >
                    {formatUsd(sel.costPerKg, 4)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">{formatUsd(sel.totalCost, 0, 4)}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveSource(sel.type, sel.sourceId)}
                  disabled={historicalSourcesLocked}
                  data-testid={`button-remove-${sel.type}-${sel.sourceId}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
