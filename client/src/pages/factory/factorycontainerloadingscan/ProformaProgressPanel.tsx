/**
 * Right-hand comparison panel of the container loading scan page. A linked
 * proforma stays reusable and non-blocking, while the table still compares the
 * current loading against the proforma quantities for operational visibility.
 */
import { CheckCircle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProformaLineStatus, ProformaProgressLine } from "@/lib/proformaCapacity";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

const STATUS_ORDER: Record<ProformaLineStatus, number> = {
  overloaded: 0,
  short: 1,
  none: 2,
  fulfilled: 3,
  reference: 4,
};

const BADGE_BASE = "text-[10px] no-default-hover-elevate no-default-active-elevate";

function StatusBadge({ status }: { status: ProformaLineStatus }) {
  if (status === "fulfilled") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800`}
      >
        <CheckCircle className="h-3 w-3 mr-1" />
        Loaded
      </Badge>
    );
  }

  if (status === "overloaded") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} bg-orange-50 dark:bg-orange-950 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800`}
      >
        Overloaded
      </Badge>
    );
  }

  if (status === "short") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800`}
      >
        Less Loaded
      </Badge>
    );
  }

  if (status === "none") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800`}
      >
        Missing
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={`${BADGE_BASE} text-muted-foreground`}>
      <Info className="h-3 w-3 mr-1" />
      On Proforma
    </Badge>
  );
}

function progressRowClass(status: ProformaLineStatus) {
  if (status === "fulfilled") return "bg-green-50 dark:bg-green-950/40";
  if (status === "overloaded") return "bg-orange-50 dark:bg-orange-950/30";
  if (status === "short") return "bg-yellow-50 dark:bg-yellow-950/30";
  if (status === "none") return "bg-red-50 dark:bg-red-950/30";
  return "";
}

function remainingTextClass(status: ProformaLineStatus) {
  if (status === "none") return "text-red-600 dark:text-red-400 font-semibold";
  if (status === "short") return "text-yellow-700 dark:text-yellow-300 font-semibold";
  return "text-muted-foreground";
}

function StockCell({ model, line }: { model: FactoryContainerLoadingScanModel; line: ProformaProgressLine }) {
  const inStock = model.stockCounts[line.articleCode] ?? null;
  if (inStock === null) return <span className="text-muted-foreground">—</span>;

  const needsMore = line.status === "short" || line.status === "none";
  const shortage = needsMore && inStock < line.remaining;
  const listParams = new URLSearchParams({
    articleCode: line.articleCode,
    productName: line.productName,
    back: window.location.pathname + window.location.search,
  });

  if (model.stockLocationId) listParams.set("locationId", String(model.stockLocationId));

  return (
    <button
      className={`underline underline-offset-2 cursor-pointer hover-elevate rounded px-0.5 ${shortage ? "text-amber-600 dark:text-amber-400 font-semibold" : "text-muted-foreground"}`}
      onClick={() => model.navigate(`/factory/stock-bale-list?${listParams}`)}
      data-testid={`button-stock-detail-${line.articleCode}`}
    >
      {inStock}
    </button>
  );
}

function ComparisonTable({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { extraArticles, loadedByArticle, groupedBalesMap, proformaProgress } = model;

  return (
    <div className="overflow-y-auto max-h-[340px]">
      <Table>
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow>
            <TableHead className="text-xs">Article</TableHead>
            <TableHead className="text-xs">Product</TableHead>
            <TableHead className="text-xs text-right">Proforma Qty</TableHead>
            <TableHead className="text-xs text-right">Loaded Here</TableHead>
            <TableHead className="text-xs text-right">Remaining</TableHead>
            <TableHead className="text-xs">Status</TableHead>
            <TableHead className="text-xs text-right">Stock</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {extraArticles.map((code) => (
            <TableRow key={code} className="bg-muted/20" data-testid={`row-extra-${code}`}>
              <TableCell className="text-xs font-mono py-1.5">{code}</TableCell>
              <TableCell className="text-xs py-1.5 text-muted-foreground">
                {groupedBalesMap[code]?.baleName || "—"}
              </TableCell>
              <TableCell className="text-xs text-right font-mono py-1.5 text-muted-foreground">—</TableCell>
              <TableCell className="text-xs text-right font-mono py-1.5">{loadedByArticle[code]}</TableCell>
              <TableCell className="text-xs text-right font-mono py-1.5 text-muted-foreground">—</TableCell>
              <TableCell className="py-1.5">
                <Badge variant="outline" className={`${BADGE_BASE} text-muted-foreground`}>
                  Not on Proforma — Allowed
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-right font-mono py-1.5 text-muted-foreground">—</TableCell>
            </TableRow>
          ))}
          {[...proformaProgress]
            .sort((a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4))
            .map((line) => (
              <TableRow
                key={line.id}
                className={progressRowClass(line.status)}
                data-testid={`row-progress-${line.articleCode}`}
              >
                <TableCell className="text-xs font-mono py-1.5">{line.articleCode}</TableCell>
                <TableCell className="text-xs py-1.5">{line.productName}</TableCell>
                <TableCell className="text-xs text-right font-mono py-1.5">{line.quantity}</TableCell>
                <TableCell className="text-xs text-right font-mono py-1.5">{line.totalLoaded}</TableCell>
                <TableCell
                  className={`text-xs text-right font-mono py-1.5 ${remainingTextClass(line.status)}`}
                >
                  {line.remaining}
                </TableCell>
                <TableCell className="py-1.5">
                  <StatusBadge status={line.status} />
                </TableCell>
                <TableCell
                  className="text-xs text-right font-mono py-1.5"
                  data-testid={`text-stock-${line.articleCode}`}
                >
                  <StockCell model={model} line={line} />
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LoadedBalesSummary({ model }: { model: FactoryContainerLoadingScanModel }) {
  if (model.orderedGroups.length === 0) return null;

  return (
    <div className="border-t pt-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">Loaded Bales</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs py-1.5">Article</TableHead>
            <TableHead className="text-xs py-1.5">Product</TableHead>
            <TableHead className="text-xs text-right py-1.5">Qty</TableHead>
            <TableHead className="text-xs text-right py-1.5">Weight (kg)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.orderedGroups.map((group) => (
            <TableRow key={group.articleCode} data-testid={`row-loaded-summary-${group.articleCode}`}>
              <TableCell className="text-xs font-mono py-1.5">{group.articleCode}</TableCell>
              <TableCell className="text-xs py-1.5">{group.baleName}</TableCell>
              <TableCell className="text-xs text-right font-mono py-1.5">{group.bales.length}</TableCell>
              <TableCell className="text-xs text-right font-mono py-1.5">{group.totalWeight.toFixed(1)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function OrderSummaryCard({ model }: { model: FactoryContainerLoadingScanModel }) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <span className="text-sm font-semibold">Order Summary</span>
      </div>
      <div className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Total Bales</span>
          <span className="font-mono" data-testid="text-total-bales">
            {model.bales.length}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Total Weight</span>
          <span className="font-mono" data-testid="text-total-weight">
            {model.totalWeight.toFixed(2)} kg
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Article Groups</span>
          <span className="font-mono" data-testid="text-article-groups">
            {Object.keys(model.groupedBalesMap).length}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ProformaProgressPanel({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { orderId, linkedProforma, proformaProgress, bales, totalWeight } = model;
  if (!orderId) return null;
  if (!linkedProforma) return <OrderSummaryCard model={model} />;

  return (
    <div className="rounded-xl border overflow-hidden flex flex-col" data-testid="card-proforma-progress">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 flex-wrap">
        <div>
          <h3 className="font-semibold text-sm">{linkedProforma.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Reusable proforma — statuses compare this loading only
          </p>
        </div>
        <Badge variant="secondary" data-testid="badge-proforma-progress">
          Reusable
        </Badge>
      </div>

      <ComparisonTable model={model} />
      <LoadedBalesSummary model={model} />

      <div className="border-t pt-2 text-xs text-muted-foreground flex items-center justify-between gap-2">
        <span>
          {bales.length} bales scanned · {totalWeight.toFixed(1)} kg · {proformaProgress.length} proforma lines
        </span>
      </div>
    </div>
  );
}
