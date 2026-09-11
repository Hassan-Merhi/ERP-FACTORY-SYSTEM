import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRightLeft } from "lucide-react";
import { StatementResponse } from "./factorySupplierTypes";
import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

type SuppliersModel = ReturnType<typeof useFactorySuppliersModel>;
type FxConversionForm = SuppliersModel["fxConversionForm"];

interface CurrencyPoolsProps {
  statementData: StatementResponse;
  statementSupplierId: number;
  collapsedStmtSections: Set<string>;
  toggleStmtSection: (key: string) => void;
  today: string;
  formatKg: (val: string) => string;
  formatNum: (val: string) => string;
  setFxSourceType: (val: "supplier" | "commission" | "both") => void;
  setFxConversionForm: SuppliersModel["setFxConversionForm"];
  setFxConversionOpen: (val: boolean) => void;
  openFxConversionDialog: (
    fromSupplierId: number,
    toSupplierId: number,
    currencyCode: string,
    netPayable: string,
    totalCommission?: string
  ) => void;
}

export function CurrencyPools({
  statementData,
  statementSupplierId,
  collapsedStmtSections,
  toggleStmtSection,
  today,
  formatKg,
  formatNum,
  setFxSourceType,
  setFxConversionForm,
  setFxConversionOpen,
  openFxConversionDialog,
}: CurrencyPoolsProps) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-3 border-b bg-muted/20">
        <span
          className="flex items-center gap-2 cursor-pointer hover-elevate rounded px-1 py-0.5 flex-1"
          onClick={() => toggleStmtSection("currencyPools")}
        >
          <span className="text-sm font-semibold">Currency Pools</span>
        </span>
        {statementData.currencyGroups.some(
          (g) => g.currencyCode !== "USD" && (parseFloat(g.netPayable) > 0 || parseFloat(g.totalCommission) > 0)
        ) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const firstNonUsd = statementData.currencyGroups.find(
                (g) => g.currencyCode !== "USD" && (parseFloat(g.netPayable) > 0 || parseFloat(g.totalCommission) > 0)
              );
              if (firstNonUsd && statementSupplierId) {
                const hasBalance = parseFloat(firstNonUsd.netPayable) > 0;
                setFxSourceType(hasBalance ? "supplier" : "commission");
                const toId = statementData.supplier.parentId || statementSupplierId;
                openFxConversionDialog(
                  statementSupplierId,
                  toId,
                  firstNonUsd.currencyCode,
                  hasBalance ? firstNonUsd.netPayable : "0",
                  firstNonUsd.totalCommission
                );
              }
            }}
            data-testid="button-fx-convert"
          >
            <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
            {statementData.supplier.parentId ? "Settle FX to Broker" : "Settle FX to EUR"}
          </Button>
        )}
      </div>
      {!collapsedStmtSections.has("currencyPools") && (
        <div>
          <div className="table-responsive">
            <Table>
              <TableHeader className="sticky top-0 z-30">
                <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Currency
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Containers
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Total Weight
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Gross Value
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Commission
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                    Net Payable
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statementData.currencyGroups.map((group) => {
                  const hasFreight = parseFloat(group.totalFreight || "0") > 0.005;
                  const hasCommission = parseFloat(group.totalCommission) > 0.005;
                  const noContainers = group.containers.length === 0;
                  const isCommissionOnly = noContainers && hasCommission && !hasFreight;
                  const isCrossFreightPool = noContainers && hasFreight;
                  const netPay = parseFloat(group.netPayable);
                  const isOverpaid = netPay < -0.005;
                  const ccPrefix = group.currencyCode !== "USD" ? `${group.currencyCode} ` : "$";
                  const autoSettledFreight = parseFloat(
                    (group as unknown as { autoSettledFreight: string }).autoSettledFreight || "0"
                  );
                  const isAutoSettled = autoSettledFreight > 0.005 && Math.abs(netPay) <= 0.005;
                  return (
                    <TableRow key={group.currencyCode}>
                      <TableCell className="font-semibold">
                        <Badge variant="outline">{group.currencyCode}</Badge>
                        {isCommissionOnly && <span className="ml-2 text-xs text-muted-foreground">Commission</span>}
                        {isCrossFreightPool && hasCommission && !isAutoSettled && (
                          <span className="ml-2 text-xs text-muted-foreground">Freight + Commission</span>
                        )}
                        {isAutoSettled && (
                          <span className="ml-2 text-xs text-muted-foreground">Freight · In broker pool</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {isCrossFreightPool ? "—" : group.containers.length}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {isCrossFreightPool ? "—" : formatKg(group.totalKg)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-medium">
                        {isCrossFreightPool
                          ? (() => {
                              const totalFreight = parseFloat(group.totalFreight || "0");
                              if (isAutoSettled) {
                                return (
                                  <span className="text-muted-foreground">
                                    {ccPrefix}
                                    {formatNum(String(totalFreight.toFixed(2)))}
                                  </span>
                                );
                              }
                              const remComm = parseFloat(group.remainingCommission || group.totalCommission || "0");
                              const remainingFreight = Math.max(0, netPay - remComm);
                              const freightSettled = remainingFreight < totalFreight - 0.005;
                              return (
                                <span className="text-orange-600 dark:text-orange-400">
                                  {freightSettled ? (
                                    <>
                                      {ccPrefix}
                                      {formatNum(String(remainingFreight.toFixed(2)))}
                                      <span className="text-xs text-muted-foreground ml-1 line-through">
                                        {formatNum(String(totalFreight.toFixed(2)))}
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      {ccPrefix}
                                      {formatNum(String(totalFreight.toFixed(2)))}
                                    </>
                                  )}
                                </span>
                              );
                            })()
                          : `${ccPrefix}${formatNum(group.totalValue)}`}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-destructive">
                        {parseFloat(group.totalCommission) > 0 ? (
                          <span>
                            {ccPrefix}
                            {formatNum(group.remainingCommission ?? group.totalCommission)}
                            {group.remainingCommission != null &&
                              parseFloat(group.remainingCommission) < parseFloat(group.totalCommission) && (
                                <span className="text-xs text-muted-foreground ml-1 line-through">
                                  {formatNum(group.totalCommission)}
                                </span>
                              )}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-bold">
                        {isAutoSettled ? (
                          <span className="text-muted-foreground text-sm font-normal">In broker pool</span>
                        ) : isOverpaid ? (
                          <span className="text-green-600 dark:text-green-400">
                            {ccPrefix}
                            {formatNum(String(Math.abs(netPay)))} CR
                          </span>
                        ) : (
                          <>
                            {ccPrefix}
                            {formatNum(group.netPayable)}
                          </>
                        )}
                        {!isAutoSettled &&
                          (group.currencyCode !== "USD" || isCommissionOnly || isCrossFreightPool) &&
                          (netPay > 0 || hasCommission) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-2 h-6 px-2 text-xs"
                              onClick={() => {
                                const hasBalance = netPay > 0;
                                const netPayStr = hasBalance ? group.netPayable : "0";
                                const toSupId = statementData.supplier.parentId || statementSupplierId!;
                                let form: FxConversionForm;
                                let sourceType: string;
                                if (isCrossFreightPool) {
                                  form = {
                                    fromSupplierId: statementSupplierId!,
                                    toSupplierId: toSupId,
                                    selectedCurrency: group.currencyCode,
                                    amount: netPayStr,
                                    availableBalance: netPayStr,
                                    supplierBalance: netPayStr,
                                    commissionBalance: group.totalCommission,
                                    fxRateToUsd: group.currencyCode === "USD" ? "1" : "",
                                    date: today,
                                    effectiveDate: "",
                                    notes: hasCommission ? "Freight + commission settlement" : "Freight settlement",
                                  };
                                  sourceType = hasCommission ? "both" : "supplier";
                                } else {
                                  form = {
                                    fromSupplierId: statementSupplierId!,
                                    toSupplierId: toSupId,
                                    selectedCurrency: group.currencyCode,
                                    amount: hasBalance ? group.netPayable : group.totalCommission,
                                    availableBalance: hasBalance ? group.netPayable : group.totalCommission,
                                    supplierBalance: hasBalance ? group.netPayable : "0",
                                    commissionBalance: group.totalCommission,
                                    fxRateToUsd: group.currencyCode === "USD" ? "1" : "",
                                    date: today,
                                    effectiveDate: "",
                                    notes: "",
                                  };
                                  sourceType = hasBalance ? "supplier" : "commission";
                                }
                                setFxConversionForm(form);
                                setFxSourceType(sourceType as "supplier" | "commission" | "both");
                                setFxConversionOpen(true);
                              }}
                              data-testid={`button-convert-${group.currencyCode}`}
                            >
                              <ArrowRightLeft className="h-3 w-3 mr-1" />
                              {group.currencyCode === "USD" ? "Transfer" : "Settle"}
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
  );
}
