// Extracted from ./FactoryInvoiceDetail.tsx
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pencil } from "lucide-react";
import type { FactoryInvoiceDetailPageModel, FactoryInvoiceView } from "./FactoryInvoiceDetailPageModel";

export function FactoryInvoiceLinesTable({
  m,
  v,
  order,
}: {
  m: FactoryInvoiceDetailPageModel;
  v: FactoryInvoiceView;
  order: NonNullable<FactoryInvoiceDetailPageModel["order"]>;
}) {
  return (
    <Card className="mb-6">
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow>
            <TableHead className="w-[50px]">#</TableHead>
            <TableHead>Article Code</TableHead>
            <TableHead>Bale Name</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Weight/Bale</TableHead>
            <TableHead className="text-right">Total Weight</TableHead>
            {m.isAdmin &&
              (() => {
                const anyPerKg = v.sortedLines.some((l) => l.pricingMode === "per_kg");
                return (
                  <TableHead className={`text-right${m.hideExportSelling ? " print:hidden" : ""}`}>
                    {anyPerKg ? "Price/KG" : "Price/Bale"}
                    {(v.isVerifiedStatus || order.status === "FINALIZED") && (
                      <Pencil className="inline ml-1 h-3 w-3 text-muted-foreground" />
                    )}
                  </TableHead>
                );
              })()}
            {m.isAdmin && (
              <TableHead className={`text-right${m.hideExportSelling ? " print:hidden" : ""}`}>Total Price</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {v.sortedLines.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={m.isAdmin ? 8 : 6}
                className="text-center text-muted-foreground py-6"
                data-testid="text-no-lines"
              >
                No order lines
              </TableCell>
            </TableRow>
          ) : (
            v.sortedLines.map((line, idx) => (
              <TableRow key={`${line.articleCode ?? ""}-${idx}`} data-testid={`row-line-${idx}`}>
                <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                <TableCell className="font-mono text-sm" data-testid={`text-article-code-${idx}`}>
                  {line.articleCode}
                </TableCell>
                <TableCell data-testid={`text-bale-name-${idx}`}>
                  <button
                    className="text-left hover-elevate rounded-md px-1 -mx-1 py-0.5 font-medium underline-offset-2 hover:underline"
                    onClick={() => m.setBaleRefArticle({ code: line.articleCode, name: line.baleName })}
                    data-testid={`button-bale-refs-${idx}`}
                    title="Click to see all reference numbers"
                  >
                    {line.baleName}
                  </button>
                </TableCell>
                <TableCell className="text-right font-mono" data-testid={`text-qty-${idx}`}>
                  {line.qty}
                </TableCell>
                <TableCell className="text-right font-mono" data-testid={`text-weight-per-bale-${idx}`}>
                  {Number(line.weightPerBale || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </TableCell>
                <TableCell className="text-right font-mono" data-testid={`text-total-weight-${idx}`}>
                  {Number(line.totalWeight || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </TableCell>
                {m.isAdmin &&
                  (() => {
                    const isPerKg = line.pricingMode === "per_kg";
                    const pkgRateInv = line.pricePerKg || 0;
                    const displayRate = isPerKg
                      ? Number(line.totalPrice) > 0 && Number(line.totalWeight) > 0
                        ? Number(line.totalPrice) / Number(line.totalWeight)
                        : pkgRateInv
                      : Number(line.pricePerBale || 0);
                    return (
                      <TableCell
                        className={`text-right font-mono${m.hideExportSelling ? " print:hidden" : ""}`}
                        data-testid={`text-price-per-bale-${idx}`}
                      >
                        {(v.isVerifiedStatus || order.status === "FINALIZED") && !isPerKg ? (
                          m.editingArticleCode === line.articleCode ? (
                            <Input
                              ref={m.inputRef}
                              type="number"
                              min="0"
                              step="any"
                              value={m.editValue}
                              onChange={(e) => m.setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") m.commitEdit(line.articleCode);
                                if (e.key === "Escape") m.cancelEdit();
                              }}
                              onBlur={() => m.commitEdit(line.articleCode)}
                              className="h-7 w-28 text-right font-mono p-1 ml-auto"
                              disabled={m.repriceArticleMutation.isPending}
                              data-testid={`input-price-${idx}`}
                            />
                          ) : (
                            <button
                              onClick={() => m.startEdit(line.articleCode, line.pricePerBale)}
                              disabled={!m.canChange}
                              className="group flex items-center justify-end gap-1 w-full hover-elevate rounded-md px-1 py-0.5"
                              data-testid={`button-edit-price-${idx}`}
                              title={m.recordChanges.reason ?? "Click to edit price"}
                            >
                              <span>
                                {displayRate.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 4,
                                })}
                              </span>
                              <Pencil className="h-3 w-3 text-muted-foreground invisible group-hover:visible touch:visible" />
                            </button>
                          )
                        ) : (
                          displayRate.toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 4,
                          })
                        )}
                      </TableCell>
                    );
                  })()}
                {m.isAdmin && (
                  <TableCell
                    className={`text-right font-mono font-semibold${m.hideExportSelling ? " print:hidden" : ""}`}
                    data-testid={`text-total-price-${idx}`}
                  >
                    {Number(line.totalPrice || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
