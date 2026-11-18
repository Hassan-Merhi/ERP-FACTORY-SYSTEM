// Extracted from ./SupplierStatement.tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ArrowRightLeft, BookOpen, ChevronDown, Trash2 } from "lucide-react";
import { SupplierStatementRows } from "./SupplierStatementRows";
import type { SupplierStatementProps } from "./SupplierStatement";

export function SupplierStatementTransfers({
  statementData,
  toggleStmtSection,
  collapsedStmtSections,
  statementSupplierId,
  formatDate,
  formatNum,
  canChangeExistingRecords,
  wrapAdminAction,
  deleteFxTransferMutation,
  primaryCc,
  sfTotalPurchases,
  sfTotalPayments,
  sfPurchasesQty,
  sfTxCount,
  currencyTotals,
  statDateFilter,
  setStatDateFilter,
  displayedRows,
  balanceByKey,
  typeBadge,
  statusColor,
  statusDisplayLabel,
  onEditPayment,
  onDeletePayment,
}: {
  statementData: NonNullable<SupplierStatementProps["statementData"]>;
  toggleStmtSection: SupplierStatementProps["toggleStmtSection"];
  collapsedStmtSections: SupplierStatementProps["collapsedStmtSections"];
  statementSupplierId: SupplierStatementProps["statementSupplierId"];
  formatDate: SupplierStatementProps["formatDate"];
  formatNum: SupplierStatementProps["formatNum"];
  canChangeExistingRecords: Exclude<SupplierStatementProps["canChangeExistingRecords"], undefined>;
  wrapAdminAction: SupplierStatementProps["wrapAdminAction"];
  deleteFxTransferMutation: SupplierStatementProps["deleteFxTransferMutation"];
  primaryCc: SupplierStatementProps["primaryCc"];
  sfTotalPurchases: SupplierStatementProps["sfTotalPurchases"];
  sfTotalPayments: SupplierStatementProps["sfTotalPayments"];
  sfPurchasesQty: SupplierStatementProps["sfPurchasesQty"];
  sfTxCount: SupplierStatementProps["sfTxCount"];
  currencyTotals: SupplierStatementProps["currencyTotals"];
  statDateFilter: SupplierStatementProps["statDateFilter"];
  setStatDateFilter: SupplierStatementProps["setStatDateFilter"];
  displayedRows: SupplierStatementProps["displayedRows"];
  balanceByKey: SupplierStatementProps["balanceByKey"];
  typeBadge: SupplierStatementProps["typeBadge"];
  statusColor: SupplierStatementProps["statusColor"];
  statusDisplayLabel: SupplierStatementProps["statusDisplayLabel"];
  onEditPayment: SupplierStatementProps["onEditPayment"];
  onDeletePayment: SupplierStatementProps["onDeletePayment"];
}) {
  return (
    <>
      {statementData.fxTransfers && statementData.fxTransfers.length > 0 && (
        <div className="rounded-xl border overflow-hidden">
          <div
            className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 cursor-pointer hover-elevate"
            onClick={() => toggleStmtSection("fxTransfers")}
          >
            <span className="flex items-center gap-2 flex-1">
              <ArrowRightLeft className="h-4 w-4" />
              <span className="text-sm font-semibold">FX Settlement Log</span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${collapsedStmtSections.has("fxTransfers") ? "" : "rotate-180"}`}
              />
            </span>
          </div>
          {!collapsedStmtSections.has("fxTransfers") && (
            <div>
              <div className="table-responsive">
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="w-32">Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">From</TableHead>
                      <TableHead className="text-right">Cost (USD)</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statementData.fxTransfers.map((f) => {
                      const isSelf = f.toSupplierId === f.fromSupplierId;
                      const isIncoming = f.toSupplierId === statementSupplierId;
                      const displayRate = parseFloat(f.fxRateToUsd) > 0 ? 1 / parseFloat(f.fxRateToUsd) : 0;
                      return (
                        <TableRow key={f.id}>
                          <TableCell className="text-sm">{formatDate(f.date)}</TableCell>
                          <TableCell className="text-sm">
                            {isSelf ? "Internal Settlement" : isIncoming ? "Transfer In" : "Transfer Out"}
                            {f.sourceType && <span className="ml-1 opacity-60">({f.sourceType})</span>}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {f.fromCurrencyCode} {formatNum(f.fromAmount)} @ {displayRate.toFixed(4)}
                          </TableCell>
                          <TableCell className="text-right text-sm font-bold tabular-nums">
                            ${formatNum(f.toAmountUsd)}
                          </TableCell>
                          <TableCell className="text-right">
                            {canChangeExistingRecords && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive"
                                onClick={() =>
                                  wrapAdminAction(() => deleteFxTransferMutation.mutate(f.id), "Delete FX Transfer")
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border overflow-hidden">
        <div
          className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 cursor-pointer hover-elevate"
          onClick={() => toggleStmtSection("allActivity")}
        >
          <span className="flex items-center gap-2 flex-1">
            <BookOpen className="h-4 w-4" />
            <span className="text-sm font-semibold">Account Ledger</span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${collapsedStmtSections.has("allActivity") ? "" : "rotate-180"}`}
            />
          </span>
        </div>
        {!collapsedStmtSections.has("allActivity") && (
          <div className="p-4">
            <SupplierStatementRows
              statementData={statementData}
              primaryCc={primaryCc}
              sfTotalPurchases={sfTotalPurchases}
              sfTotalPayments={sfTotalPayments}
              sfPurchasesQty={sfPurchasesQty}
              sfTxCount={sfTxCount}
              currencyTotals={currencyTotals}
              statDateFilter={statDateFilter}
              setStatDateFilter={setStatDateFilter}
              displayedRows={displayedRows}
              balanceByKey={balanceByKey}
              formatDate={formatDate}
              formatNum={formatNum}
              typeBadge={typeBadge}
              statusColor={statusColor}
              statusDisplayLabel={statusDisplayLabel}
              onEditPayment={onEditPayment}
              onDeletePayment={onDeletePayment}
            />
          </div>
        )}
      </div>
    </>
  );
}
