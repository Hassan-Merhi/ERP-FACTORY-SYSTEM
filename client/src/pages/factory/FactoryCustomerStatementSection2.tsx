// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, ExternalLink, Save, Upload } from "lucide-react";
import { drCrClass } from "@/lib/formatNumber";
import { fmtMoney, fmtNum, LEGACY_PRICE_DESTINATION } from "./factorycustomerstatement/statementHelpers";
import { useFactoryCustomerStatementState } from "./useFactoryCustomerStatementState";

export function FactoryCustomerStatementSection2({
  addPriceDestination,
  deletePriceMutation,
  fileInputRef,
  handleExcelUpload,
  handlePriceListTemplateDownload,
  handleSavePrices,
  hasPriceEdits,
  newDestination,
  priceDestination,
  priceDestinationsQuery,
  recordChanges,
  savePricesMutation,
  selectPriceDestination,
  setNewDestination,
}: Pick<
  ReturnType<typeof useFactoryCustomerStatementState>,
  | "addPriceDestination"
  | "deletePriceMutation"
  | "fileInputRef"
  | "handleExcelUpload"
  | "handlePriceListTemplateDownload"
  | "handleSavePrices"
  | "hasPriceEdits"
  | "newDestination"
  | "priceDestination"
  | "priceDestinationsQuery"
  | "recordChanges"
  | "savePricesMutation"
  | "selectPriceDestination"
  | "setNewDestination"
>) {
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Saved Agreed Prices by Destination</p>
          <p className="text-xs text-muted-foreground">
            New proformas use only agreed prices for their own customer and destination.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePriceListTemplateDownload}
            data-testid="button-download-pricelist-template"
          >
            <Download className="h-4 w-4 mr-2" /> Download Template
          </Button>
          {recordChanges.allowed && (
            <>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                ref={fileInputRef}
                onChange={handleExcelUpload}
                className="hidden"
                data-testid="input-upload-pricelist"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={!priceDestination || savePricesMutation.isPending || deletePriceMutation.isPending}
                data-testid="button-upload-excel-pricelist"
              >
                <Upload className="h-4 w-4 mr-2" /> Upload Excel
              </Button>
            </>
          )}
          {recordChanges.allowed && hasPriceEdits && (
            <Button
              size="sm"
              onClick={handleSavePrices}
              disabled={!priceDestination || savePricesMutation.isPending || deletePriceMutation.isPending}
              data-testid="button-save-pricelist"
            >
              <Save className="h-4 w-4 mr-2" />
              {savePricesMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 p-3">
        <div className="min-w-[200px] flex-1 sm:max-w-[320px]">
          <label htmlFor="customer-price-destination" className="mb-1 block text-xs font-semibold">
            Price list destination
          </label>
          <select
            id="customer-price-destination"
            data-testid="select-price-destination"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={priceDestination}
            onChange={(e) => selectPriceDestination(e.target.value)}
            disabled={savePricesMutation.isPending || deletePriceMutation.isPending}
          >
            <option value="" disabled>
              Select destination
            </option>
            {(priceDestinationsQuery.data ?? []).map((destination) => (
              <option key={destination} value={destination}>
                {destination}
              </option>
            ))}
            {priceDestination &&
              priceDestination !== LEGACY_PRICE_DESTINATION &&
              !(priceDestinationsQuery.data ?? []).includes(priceDestination) && (
                <option value={priceDestination}>{priceDestination}</option>
              )}
            <option value={LEGACY_PRICE_DESTINATION}>Legacy / Unassigned (old prices)</option>
          </select>
        </div>
        {recordChanges.allowed && (
          <div className="flex min-w-[220px] flex-1 items-end gap-2">
            <div className="flex-1">
              <label htmlFor="customer-new-price-destination" className="mb-1 block text-xs font-semibold">
                Add another destination
              </label>
              <Input
                id="customer-new-price-destination"
                data-testid="input-new-price-destination"
                value={newDestination}
                onChange={(e) => setNewDestination(e.target.value)}
                placeholder="e.g. L'SHI, MALI"
                maxLength={120}
                disabled={savePricesMutation.isPending || deletePriceMutation.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPriceDestination();
                  }
                }}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="button-add-price-destination"
              onClick={addPriceDestination}
              disabled={!newDestination.trim() || savePricesMutation.isPending || deletePriceMutation.isPending}
            >
              Use
            </Button>
          </div>
        )}
        {priceDestinationsQuery.isError && (
          <p role="alert" className="w-full text-xs text-destructive">
            Failed to load customer destinations. Please refresh and retry.
          </p>
        )}
        {priceDestination === LEGACY_PRICE_DESTINATION ? (
          <p className="w-full text-xs text-amber-600 dark:text-amber-400">
            Older customer-wide prices are separate and are not applied to new destination-linked proformas.
          </p>
        ) : priceDestination ? (
          <p className="w-full text-xs text-muted-foreground">
            Only {priceDestination} prices will change here. Existing proforma line prices remain unchanged.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function FactoryCustomerStatementSection3({
  filteredHistory,
  formatDisplayDate,
  hasFilters,
  navigate,
  recordChanges,
  rowNotes,
  saveRowNote,
  savingRowNote,
  setRowNotes,
}: Pick<
  ReturnType<typeof useFactoryCustomerStatementState>,
  | "filteredHistory"
  | "formatDisplayDate"
  | "hasFilters"
  | "navigate"
  | "recordChanges"
  | "rowNotes"
  | "saveRowNote"
  | "savingRowNote"
  | "setRowNotes"
>) {
  return (
    <div className="rounded-xl border overflow-hidden table-responsive">
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30">
          <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Date
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Type
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Container
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Destination
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Bales
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Kg
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Debit
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Credit
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Balance
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Side
            </TableHead>
            <TableHead className="min-w-[160px] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Note
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredHistory.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={11}
                className="text-center text-muted-foreground py-8"
                data-testid="text-no-transactions"
              >
                {hasFilters ? "No rows match the current filters" : "No transactions yet"}
              </TableCell>
            </TableRow>
          ) : (
            filteredHistory.map((entry) => {
              const isInvoice = entry.referenceType === "INVOICE" && entry.referenceId;
              return (
                <TableRow
                  key={entry.id}
                  data-testid={`row-balance-${entry.id}`}
                  className={isInvoice ? "cursor-pointer hover-elevate" : undefined}
                  onClick={isInvoice ? () => navigate(`/factory/sales/invoices/${entry.referenceId}`) : undefined}
                >
                  <TableCell
                    className="text-sm font-mono whitespace-nowrap"
                    data-testid={`text-balance-date-${entry.id}`}
                  >
                    {entry.transactionDate ? formatDisplayDate(entry.transactionDate) : "-"}
                  </TableCell>
                  <TableCell data-testid={`text-balance-type-${entry.id}`}>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-xs">
                        {entry.transactionType}
                      </Badge>
                      {isInvoice && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                    </div>
                  </TableCell>
                  <TableCell
                    className="text-sm font-mono text-muted-foreground whitespace-nowrap"
                    data-testid={`text-balance-container-${entry.id}`}
                  >
                    {entry.containerNumber || "-"}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    data-testid={`text-balance-destination-${entry.id}`}
                  >
                    {entry.destination || "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-bales-${entry.id}`}>
                    {entry.totalQtyBales != null ? fmtNum(entry.totalQtyBales) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-kg-${entry.id}`}>
                    {entry.totalWeightKg != null ? fmtNum(entry.totalWeightKg) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-debit-${entry.id}`}>
                    {Number(entry.debitAmount || 0) > 0 ? fmtMoney(Number(entry.debitAmount)) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-credit-${entry.id}`}>
                    {Number(entry.creditAmount || 0) > 0 ? fmtMoney(Number(entry.creditAmount)) : "-"}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono font-semibold"
                    data-testid={`text-balance-running-${entry.id}`}
                  >
                    {fmtMoney(Math.abs(entry.runningBalance))}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs font-semibold ${drCrClass(entry.runningBalanceSide)}`}>
                      {entry.runningBalanceSide}
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-[160px]" data-mobile-cell="wide" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      value={rowNotes[entry.id] ?? ""}
                      onChange={(e) =>
                        typeof entry.id === "number" && setRowNotes((prev) => ({ ...prev, [entry.id]: e.target.value }))
                      }
                      onBlur={() => saveRowNote(entry.id, rowNotes[entry.id] ?? "")}
                      placeholder={typeof entry.id === "string" ? "—" : "Add note…"}
                      disabled={!recordChanges.allowed || savingRowNote === entry.id || typeof entry.id === "string"}
                      title={recordChanges.reason ?? undefined}
                      className="w-full text-xs bg-transparent border border-border rounded-sm px-2 py-1 placeholder:text-muted-foreground/50 focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
                      data-testid={`input-row-note-${entry.id}`}
                    />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
