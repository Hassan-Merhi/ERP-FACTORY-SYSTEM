import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InStockBale } from "./RemoveFromStockTab";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface RemoveFromStockTableProps {
  viewMode: "condensed" | "detailed";
  loading: boolean;
  filteredBales: InStockBale[] | undefined;
  condensedRows: { groupKey: string; articleCode: string; productName: string; qty: number; totalWeight: number; baleIds: number[]; }[];
  selectedBaleIds: Set<number>;
  onToggleBale: (id: number) => void;
  onToggleCondensedRow: (ids: number[]) => void;
  formatDisplayDate: (date: Date | string) => string;
  onPrintBale: (bale: InStockBale) => void;
}

export function RemoveFromStockTable({
  viewMode,
  loading,
  filteredBales,
  condensedRows,
  selectedBaleIds,
  onToggleBale,
  onToggleCondensedRow,
  formatDisplayDate,
  onPrintBale,
}: RemoveFromStockTableProps) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30">
            <TableHead className="w-12"></TableHead>
            {viewMode === "detailed" ? (
              <>
                <TableHead>Ref Number</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Finalized At</TableHead>
                <TableHead>Finalized By</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="w-20"></TableHead>
              </>
            ) : (
              <>
                <TableHead>Article Code</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead className="text-center">Count</TableHead>
                <TableHead className="text-right">Total Weight</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                Loading inventory...
              </TableCell>
            </TableRow>
          ) : (viewMode === "detailed" ? filteredBales : condensedRows)?.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                No matching bales in stock.
              </TableCell>
            </TableRow>
          ) : viewMode === "detailed" ? (
            filteredBales?.map((bale) => (
              <TableRow key={bale.id} className={selectedBaleIds.has(bale.id) ? "bg-primary/5" : ""}>
                <TableCell>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    checked={selectedBaleIds.has(bale.id)}
                    onChange={() => onToggleBale(bale.id)}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs font-bold">{bale.referenceNumber}</TableCell>
                <TableCell>
                  <div className="font-medium text-sm">{bale.productName}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{bale.articleCode}</div>
                </TableCell>
                <TableCell className="text-xs">{bale.locationName}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDisplayDate(bale.finalizedAt ?? "")}</TableCell>
                <TableCell className="text-xs">{bale.finalizedByName || "-"}</TableCell>
                <TableCell className="text-right font-bold text-sm">
                  {parseFloat(bale.weightKg || "0").toFixed(1)}{" "}
                  <span className="text-[10px] text-muted-foreground">KG</span>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onPrintBale(bale)}>
                    <Printer className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          ) : (
            condensedRows.map((row) => (
              <TableRow
                key={row.groupKey}
                className={row.baleIds.every((id: number) => selectedBaleIds.has(id)) ? "bg-primary/5" : ""}
              >
                <TableCell>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    checked={row.baleIds.every((id: number) => selectedBaleIds.has(id))}
                    onChange={() => onToggleCondensedRow(row.baleIds)}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs font-bold">{row.articleCode}</TableCell>
                <TableCell className="font-medium text-sm">{row.productName}</TableCell>
                <TableCell className="text-center font-bold">{row.qty}</TableCell>
                <TableCell className="text-right font-bold text-sm">
                  {row.totalWeight.toFixed(1)} <span className="text-[10px] text-muted-foreground">KG</span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
