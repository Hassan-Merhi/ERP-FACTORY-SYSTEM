import { CheckCircle2, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BaleStatusBadge } from "./components/BaleStatusBadge";
import type { ArticleLookupResult, SearchMode } from "./types";

interface BarcodeArticleResultsProps {
  articleResult: ArticleLookupResult;
  searchValue: string;
  setSearchMode: (mode: SearchMode) => void;
  setSearchValue: (value: string) => void;
  lookupReference: (referenceNumber: string) => void;
  smartNum: (value: string | number) => string;
}

export function BarcodeArticleResults({
  articleResult,
  searchValue,
  setSearchMode,
  setSearchValue,
  lookupReference,
  smartNum,
}: BarcodeArticleResultsProps) {
  if (!articleResult.product && articleResult.labelPrints.length === 0) {
    return (
      <div className="rounded-2xl border border-blue-200/70 bg-blue-50/60 p-8 text-center text-sm text-muted-foreground shadow-sm dark:border-blue-400/25 dark:bg-slate-900/65">
        No product or bales found for article code "<span className="font-mono">{searchValue}</span>"
      </div>
    );
  }

  const product = articleResult.product;

  return (
    <div className="overflow-hidden rounded-2xl border border-indigo-200/80 bg-white shadow-[0_12px_38px_-24px_rgba(30,64,175,0.35)] dark:border-indigo-400/25 dark:bg-[#111b31]">
      {product ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100 bg-linear-to-r from-indigo-50 via-blue-50/65 to-white px-4 py-4 dark:border-indigo-300/20 dark:from-[#202b52] dark:via-[#172447] dark:to-[#111b31] sm:px-5">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"><Package className="h-5 w-5" aria-hidden="true" /></span>
            <span className="font-bold text-base">{product.name}</span>
            <Badge variant={product.active ? "default" : "secondary"} className="text-xs">
              {product.active ? "Active" : "Inactive"}
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1.5">Article Code</span>
              <span className="font-mono font-semibold">{product.articleCode || product.code}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1.5">References</span>
              <span className="font-semibold font-mono">{articleResult.labelPrints.length.toLocaleString()}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100 bg-linear-to-r from-indigo-50 via-blue-50/65 to-white px-4 py-4 dark:border-indigo-300/20 dark:from-[#202b52] dark:via-[#172447] dark:to-[#111b31] sm:px-5">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"><Package className="h-5 w-5" aria-hidden="true" /></span>
            <span className="font-bold text-base font-mono">{searchValue}</span>
            <Badge variant="outline" className="text-xs">
              Unregistered Product
            </Badge>
          </div>
          <div className="text-sm">
            <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1.5">References</span>
            <span className="font-semibold font-mono">{articleResult.labelPrints.length.toLocaleString()}</span>
          </div>
        </div>
      )}

      {articleResult.labelPrints.length > 0 ? (
        <Table>
          <TableHeader className="sticky top-0 z-30 border-b-2 border-blue-200 bg-slate-50 dark:border-blue-500/20 dark:bg-slate-900">
            <TableRow>
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Reference No.
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Approx. Weight (KG)
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Printed At
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Status
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Scanned
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {articleResult.labelPrints.map((labelPrint) => {
              const baleStatus = labelPrint.baleStatus ?? null;
              const isDeleted = baleStatus === "DELETED" || baleStatus === "REMOVED";
              return (
                <TableRow
                  key={labelPrint.id}
                  className="cursor-pointer transition-colors hover:bg-blue-50/70 dark:hover:bg-blue-500/10"
                  data-testid={`row-label-${labelPrint.id}`}
                  onClick={() => {
                    setSearchMode("reference");
                    setSearchValue(labelPrint.referenceNumber);
                    lookupReference(labelPrint.referenceNumber);
                  }}
                >
                  <TableCell
                    className={`font-mono font-medium ${isDeleted ? "text-muted-foreground line-through" : ""}`}
                  >
                    {labelPrint.referenceNumber}
                  </TableCell>
                  <TableCell className="font-mono">{smartNum(labelPrint.approxWeightKg)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {labelPrint.printedAt
                      ? (labelPrint.printedAt instanceof Date
                          ? labelPrint.printedAt
                          : new Date(labelPrint.printedAt)
                        ).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {baleStatus ? (
                      <BaleStatusBadge status={baleStatus} />
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {labelPrint.scannedAt ? (
                      <Badge variant="default" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Scanned
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not Scanned</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No bale references found for this article code.
        </div>
      )}
    </div>
  );
}
