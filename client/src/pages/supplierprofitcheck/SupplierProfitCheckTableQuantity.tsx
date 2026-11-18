// Extracted from ./SupplierProfitCheckTable.tsx to keep that module under the source-size cap.
import { Input } from "@/components/ui/input";
import { TableCell } from "@/components/ui/table";
import type { ComputedRow } from "./types";
import type { useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";

type ProfitModel = ReturnType<typeof useSupplierProfitCheckModel>;

export function QuantityCell({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  return (
    <TableCell className="py-2.5">
      <QuantityInput row={row} model={model} className="w-24 h-7 text-right ml-auto font-mono" />
    </TableCell>
  );
}

export function QuantityInput({ row, model, className }: { row: ComputedRow; model: ProfitModel; className: string }) {
  return (
    <Input
      type="number"
      min="0"
      step="1"
      placeholder="0"
      value={model.qtyMap[row.stockItemId] ?? ""}
      onChange={(event) => {
        model.setQtyMap((previous) => ({ ...previous, [row.stockItemId]: event.target.value }));
        model.setQtyVersion((version) => version + 1);
      }}
      onKeyDown={(event) => model.handleArrowNav(event, "data-qty-input")}
      className={`${className} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
      data-testid={`input-qty-${row.stockItemId}`}
      data-qty-input="true"
    />
  );
}
