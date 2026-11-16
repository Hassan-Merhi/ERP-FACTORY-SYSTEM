// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import { useFactoryCustomerStatementState } from "./useFactoryCustomerStatementState";

export function FactoryCustomerStatementSection({
  deletePriceMutation,
  handleSavePrices,
  newCode,
  newPrice,
  priceDestination,
  priceDestinationsQuery,
  priceEdits,
  priceListQuery,
  recordChanges,
  savePricesMutation,
  setNewCode,
  setNewPrice,
  setPriceEdits,
}: Pick<
  ReturnType<typeof useFactoryCustomerStatementState>,
  | "deletePriceMutation"
  | "handleSavePrices"
  | "newCode"
  | "newPrice"
  | "priceDestination"
  | "priceDestinationsQuery"
  | "priceEdits"
  | "priceListQuery"
  | "recordChanges"
  | "savePricesMutation"
  | "setNewCode"
  | "setNewPrice"
  | "setPriceEdits"
>) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30">
          <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Article Code
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Name
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Price per Bale ($)
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Last Updated
            </TableHead>
            <TableHead className="w-[50px] py-2"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!priceDestination || priceDestinationsQuery.isLoading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                Select a destination to view its agreed prices.
              </TableCell>
            </TableRow>
          ) : priceListQuery.isError ? (
            <TableRow>
              <TableCell colSpan={5} role="alert" className="text-center text-destructive py-6">
                Failed to load prices for this destination. Please retry.
              </TableCell>
            </TableRow>
          ) : priceListQuery.isLoading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center py-6">
                <Skeleton className="h-4 w-48 mx-auto" />
              </TableCell>
            </TableRow>
          ) : (priceListQuery.data ?? []).length === 0 && !newCode ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-8" data-testid="text-no-prices">
                No agreed prices for this destination yet. Upload Excel or add them manually below.
              </TableCell>
            </TableRow>
          ) : (
            (priceListQuery.data ?? []).map((entry) => (
              <TableRow key={entry.article_code} data-testid={`row-price-${entry.article_code}`}>
                <TableCell
                  className="font-mono text-sm font-medium"
                  data-testid={`text-price-code-${entry.article_code}`}
                >
                  {entry.article_code}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{entry.item_name || "-"}</TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={
                      priceEdits[entry.article_code] !== undefined
                        ? priceEdits[entry.article_code]
                        : entry.price_per_bale
                    }
                    onChange={(e) => setPriceEdits((prev) => ({ ...prev, [entry.article_code]: e.target.value }))}
                    readOnly={!recordChanges.allowed}
                    title={recordChanges.reason ?? undefined}
                    onBlur={() => {
                      if (
                        recordChanges.allowed &&
                        priceEdits[entry.article_code] !== undefined &&
                        !savePricesMutation.isPending
                      ) {
                        handleSavePrices();
                      }
                    }}
                    className="w-32 ml-auto text-right font-mono"
                    data-testid={`input-price-${entry.article_code}`}
                  />
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                  {entry.updated_at ? new Date(entry.updated_at).toLocaleDateString() : "-"}
                </TableCell>
                <TableCell>
                  {recordChanges.allowed && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() =>
                        deletePriceMutation.mutate({
                          articleCode: entry.article_code,
                          destination: priceDestination,
                        })
                      }
                      disabled={!priceDestination || deletePriceMutation.isPending || savePricesMutation.isPending}
                      data-testid={`button-delete-price-${entry.article_code}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}

          {/* Add new row */}
          {recordChanges.allowed && (
            <TableRow data-testid="row-add-price">
              <TableCell>
                <Input
                  placeholder="Article code…"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="font-mono"
                  data-testid="input-new-price-code"
                />
              </TableCell>
              <TableCell />
              <TableCell className="text-right">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={newPrice}
                  onChange={(e) => setNewPrice(e.target.value)}
                  className="w-32 ml-auto text-right font-mono"
                  data-testid="input-new-price-value"
                />
              </TableCell>
              <TableCell />
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleSavePrices}
                  disabled={
                    !priceDestination ||
                    !newCode.trim() ||
                    !newPrice ||
                    savePricesMutation.isPending ||
                    deletePriceMutation.isPending
                  }
                  data-testid="button-add-price"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
