// Extracted from ./FactoryInvoiceCreate.tsx
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Trash2, ScanLine } from "lucide-react";
import { EmptyState } from "@/components/ui/page-state";
import { useFactoryInvoiceCreateState } from "./useFactoryInvoiceCreateState";

export function FactoryInvoiceCreateContent({
  activeProforma,
  bales,
  groupedBales,
  removeBaleMutation,
  subtotal,
}: Pick<
  ReturnType<typeof useFactoryInvoiceCreateState>,
  "activeProforma" | "bales" | "groupedBales" | "removeBaleMutation" | "subtotal"
>) {
  return (
    <div className="lg:w-[60%] flex flex-col min-h-0">
      <Card className="flex-1 flex flex-col min-h-0 p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="font-semibold text-lg" data-testid="text-bales-header">
            Scanned Bales
          </h2>
          <Badge variant="secondary" data-testid="badge-bale-count">
            {bales.length} bales
          </Badge>
        </div>

        <div className="flex-1 overflow-y-auto">
          {Object.keys(groupedBales).length === 0 ? (
            <EmptyState
              icon={ScanLine}
              title="No bales scanned yet"
              description="Select a customer and location, then scan bales"
              className="border-0"
              data-testid="text-no-bales"
            />
          ) : (
            <div className="space-y-4">
              {Object.values(groupedBales).map((group) => (
                <div key={group.articleCode} data-testid={`group-article-${group.articleCode}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" data-testid={`badge-article-${group.articleCode}`}>
                        {group.articleCode}
                      </Badge>
                      <span className="text-sm font-medium">{group.productName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span>Qty: {group.bales.length}</span>
                      <span>
                        Wt:{" "}
                        {group.totalWeight.toLocaleString(undefined, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      {(() => {
                        const pfl = activeProforma?.lines.find((l) => l.articleCode === group.articleCode);
                        const isPerKg = pfl?.pricingMode === "per_kg";
                        return isPerKg ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            @
                            {parseFloat(pfl?.pricePerKg || "0").toLocaleString(undefined, {
                              minimumFractionDigits: 3,
                              maximumFractionDigits: 3,
                            })}
                            /kg
                          </span>
                        ) : (
                          <span className="font-mono">
                            @
                            {group.pricePerBale.toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                        );
                      })()}
                      <span className="font-mono font-semibold text-foreground">
                        {group.totalPrice.toLocaleString(undefined, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  </div>
                  {/* No header row: phone cards take their labels from the cells themselves. */}
                  <Table mobileLayout="cards">
                    <TableBody>
                      {group.bales.map((bale) => (
                        <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                          <TableCell
                            className="font-mono text-sm"
                            data-label="Reference"
                            data-testid={`text-bale-ref-${bale.id}`}
                          >
                            {bale.referenceNumber}
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground" data-label="Weight">
                            {parseFloat(bale.weight || "0").toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}{" "}
                            kg
                          </TableCell>
                          <TableCell
                            className="text-right font-mono text-sm"
                            data-label="Price"
                            data-testid={`text-bale-price-${bale.id}`}
                          >
                            {parseFloat(bale.totalPrice || "0").toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </TableCell>
                          <TableCell className="w-[40px]">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeBaleMutation.mutate(bale.id)}
                              disabled={removeBaleMutation.isPending}
                              aria-label={`Remove bale ${bale.referenceNumber}`}
                              data-testid={`button-remove-bale-${bale.id}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </div>

        {bales.length > 0 && (
          <div className="border-t pt-3 mt-3 flex items-center justify-between gap-2">
            <span className="font-medium">Subtotal</span>
            <span className="font-mono font-semibold text-lg" data-testid="text-subtotal">
              {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
