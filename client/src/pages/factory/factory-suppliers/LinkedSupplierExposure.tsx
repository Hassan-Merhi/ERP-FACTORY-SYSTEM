import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, ChevronRight } from "lucide-react";
import { StatementResponse } from "./factorySupplierTypes";

interface LinkedSupplierExposureProps {
  statementData: StatementResponse;
  statementSupplierId: number;
  supplierIncludeOtw: boolean;
  collapsedStmtSections: Set<string>;
  toggleStmtSection: (key: string) => void;
  setStatementReturnToParent: (val: boolean) => void;
  setStatementSupplierId: (id: number | null) => void;
  formatDate: (val: string) => string;
  formatNum: (val: string) => string;
  openFxConversionDialog: (
    fromSupplierId: number,
    toSupplierId: number,
    currencyCode: string,
    netPayable: string,
    totalCommission?: string
  ) => void;
}

export function LinkedSupplierExposure({
  statementData,
  statementSupplierId,
  supplierIncludeOtw,
  collapsedStmtSections,
  toggleStmtSection,
  setStatementReturnToParent,
  setStatementSupplierId,
  formatDate,
  formatNum,
  openFxConversionDialog,
}: LinkedSupplierExposureProps) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <div
        className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 cursor-pointer hover-elevate"
        onClick={() => toggleStmtSection("linkedSuppliers")}
      >
        <span className="flex items-center gap-2 flex-1">
          <span className="text-sm font-semibold">Linked Supplier Exposure</span>
          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform ${collapsedStmtSections.has("linkedSuppliers") ? "" : "rotate-180"}`}
          />
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            const url = `/api/factory/suppliers/${statementSupplierId}/linked-statement/export?includeOtw=${supplierIncludeOtw}`;
            window.open(url, "_blank");
          }}
          data-testid="button-export-linked-statement"
        >
          <FileText className="h-3.5 w-3.5 mr-1.5" />
          Export Excel
        </Button>
      </div>
      {!collapsedStmtSections.has("linkedSuppliers") && (
        <div>
          <div className="table-responsive">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30">
                <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Supplier
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Containers
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Last Activity
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Exposure / Balances
                  </TableHead>
                  <TableHead className="w-12 py-2"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(statementData.linkedSupplierGroups || []).map((group) => (
                  <TableRow key={group.supplierId} className="hover:bg-muted/30 transition-colors align-top">
                    <TableCell className="font-bold py-3">
                      <button
                        onClick={() => {
                          setStatementReturnToParent(true);
                          setStatementSupplierId(group.supplierId);
                        }}
                        className="hover:underline text-left"
                      >
                        {group.supplierName}
                      </button>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{group.containerCount}</TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {group.lastActivity ? formatDate(group.lastActivity) : "—"}
                    </TableCell>
                    <TableCell className="text-right py-2">
                      <div className="space-y-1.5">
                        {(group.currencyGroups || [])
                          .filter(
                            (cg) =>
                              Math.abs(parseFloat(cg.netPayable)) > 0.005 ||
                              Math.abs(parseFloat(cg.totalCommission)) > 0.005
                          )
                          .map((cg) => {
                            const netPay = parseFloat(cg.netPayable);
                            const isOverpaid = netPay < -0.005;
                            const ccPrefix = cg.currencyCode !== "USD" ? `${cg.currencyCode} ` : "$";
                            const hasComm = parseFloat(cg.totalCommission) > 0;
                            return (
                              <div key={cg.currencyCode} className="flex flex-col items-end gap-0.5">
                                <div className="flex items-center gap-2">
                                  {cg.currencyCode !== "USD" && (netPay > 0 || hasComm) && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-5 px-1.5 text-[10px]"
                                      onClick={() => {
                                        const hasBalance = netPay > 0;
                                        openFxConversionDialog(
                                          group.supplierId,
                                          statementSupplierId,
                                          cg.currencyCode,
                                          hasBalance ? cg.netPayable : "0",
                                          cg.totalCommission
                                        );
                                      }}
                                    >
                                      Settle to Pool
                                    </Button>
                                  )}
                                  <span
                                    className={`text-sm tabular-nums font-bold ${isOverpaid ? "text-green-600 dark:text-green-400" : ""}`}
                                  >
                                    {isOverpaid
                                      ? `${ccPrefix}${formatNum(String(Math.abs(netPay)))} CR`
                                      : `${ccPrefix}${formatNum(cg.netPayable)}`}
                                  </span>
                                  <Badge variant="outline" className="text-[10px] py-0 px-1 font-bold">
                                    {cg.currencyCode}
                                  </Badge>
                                </div>
                                {hasComm && (
                                  <div className="text-[10px] text-destructive font-medium">
                                    incl. {ccPrefix}
                                    {formatNum(cg.totalCommission)} commission
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setStatementReturnToParent(true);
                          setStatementSupplierId(group.supplierId);
                        }}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
