// Extracted from ./CreateMixBatchDialog.tsx
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useCreateMixBatchDialogState } from "./useCreateMixBatchDialogState";
import { formatUsd } from "@/lib/moneyDisplay";

export function CreateMixBatchDialogContent({
  handleRemoveSource,
  selectedSources,
}: Pick<ReturnType<typeof useCreateMixBatchDialogState>, "handleRemoveSource" | "selectedSources">) {
  return (
    <div className="border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Weight (kg)</TableHead>
            <TableHead className="text-right">Cost/kg</TableHead>
            <TableHead className="text-right">Total Cost</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {selectedSources.map((selection) => (
            <TableRow key={`${selection.type}-${selection.sourceId}`}>
              <TableCell>
                <Badge variant={selection.type === "batch" ? "secondary" : "outline"}>
                  {selection.type === "batch" ? "Batch" : "Supplier"}
                </Badge>
              </TableCell>
              <TableCell className="font-medium">{selection.label}</TableCell>
              <TableCell className="text-right font-mono">
                {selection.weightKg.toLocaleString(undefined, {
                  minimumFractionDigits: 3,
                  maximumFractionDigits: 3,
                })}
              </TableCell>
              <TableCell className="text-right font-mono">{formatUsd(selection.costPerKg, 4)}</TableCell>
              <TableCell className="text-right font-mono">{formatUsd(selection.totalCost, 0, 2)}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveSource(selection.type, selection.sourceId)}
                  data-testid={`button-remove-${selection.type}-${selection.sourceId}`}
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
