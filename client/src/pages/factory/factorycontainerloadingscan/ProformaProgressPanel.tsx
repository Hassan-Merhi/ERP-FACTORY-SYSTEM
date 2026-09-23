/**
 * Right-hand comparison panel of the container loading scan page. A linked
 * proforma stays reusable and non-blocking, while the table still compares the
 * current loading against the proforma quantities for operational visibility.
 */
import { CheckCircle, Info, Layers3, PackageCheck, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "../customerLoadingFormat";
import type { ProformaLineStatus, ProformaProgressLine } from "@/lib/proformaCapacity";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

const STATUS_ORDER: Record<ProformaLineStatus, number> = {
  overloaded: 0,
  short: 1,
  none: 2,
  fulfilled: 3,
  reference: 4,
};

const BADGE_BASE = "rounded-md text-[10px] no-default-hover-elevate no-default-active-elevate";

function StatusBadge({ status, model }: { status: ProformaLineStatus; model: FactoryContainerLoadingScanModel }) {
  if (status === "fulfilled") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300`}
      >
        <CheckCircle className="mr-1 h-3 w-3" />
        {model.tr("loaded")}
      </Badge>
    );
  }

  if (status === "overloaded") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300`}
      >
        {model.tr("overloaded")}
      </Badge>
    );
  }

  if (status === "short") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300`}
      >
        {model.tr("lessLoaded")}
      </Badge>
    );
  }

  if (status === "none") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300`}
      >
        {model.tr("missing")}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={`${BADGE_BASE} text-muted-foreground`}>
      <Info className="mr-1 h-3 w-3" />
      {model.tr("onProforma")}
    </Badge>
  );
}

function progressRowClass(status: ProformaLineStatus) {
  if (status === "fulfilled") return "bg-green-50/70 dark:bg-green-950/25";
  if (status === "overloaded") return "bg-orange-50/70 dark:bg-orange-950/20";
  if (status === "short") return "bg-yellow-50/70 dark:bg-yellow-950/20";
  if (status === "none") return "bg-red-50/70 dark:bg-red-950/20";
  return "";
}

function remainingTextClass(status: ProformaLineStatus) {
  if (status === "none") return "font-semibold text-red-600 dark:text-red-400";
  if (status === "short") return "font-semibold text-yellow-700 dark:text-yellow-300";
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
      className={`cursor-pointer rounded px-0.5 underline underline-offset-2 hover-elevate ${
        shortage ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      }`}
      onClick={() => model.navigate(`/factory/stock-bale-list?${listParams}`)}
      data-testid={`button-stock-detail-${line.articleCode}`}
    >
      {formatNumber(inStock)}
    </button>
  );
}

function ComparisonTable({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { extraArticles, loadedByArticle, groupedBalesMap, proformaProgress } = model;
  const sortedProgress = [...proformaProgress].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4)
  );

  return (
    <div className="max-h-[360px] overflow-auto border-t">
      <Table>
        <TableHeader className="sticky top-0 z-30 bg-background/95 backdrop-blur">
          <TableRow>
            <TableHead className="text-xs">{model.tr("article")}</TableHead>
            <TableHead className="text-xs">{model.tr("product")}</TableHead>
            <TableHead className="text-right text-xs">{model.tr("proforma")}</TableHead>
            <TableHead className="text-right text-xs">{model.tr("loadedKpi")}</TableHead>
            <TableHead className="text-right text-xs">{model.tr("remaining")}</TableHead>
            <TableHead className="text-xs">{model.tr("status")}</TableHead>
            <TableHead className="text-right text-xs">{model.tr("stock")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedProgress.map((line) => (
            <TableRow
              key={line.id}
              className={`${progressRowClass(line.status)} border-border/60`}
              data-testid={`row-progress-${line.articleCode}`}
            >
              <TableCell className="py-2 font-mono text-xs font-medium">{line.articleCode}</TableCell>
              <TableCell className="max-w-[150px] truncate py-2 text-xs" title={line.productName}>
                {line.productName}
              </TableCell>
              <TableCell className="py-2 text-right font-mono text-xs">{formatNumber(line.quantity)}</TableCell>
              <TableCell className="py-2 text-right font-mono text-xs">{formatNumber(line.totalLoaded)}</TableCell>
              <TableCell className={`py-2 text-right font-mono text-xs ${remainingTextClass(line.status)}`}>
                {formatNumber(line.remaining)}
              </TableCell>
              <TableCell className="py-2">
                <StatusBadge status={line.status} model={model} />
              </TableCell>
              <TableCell className="py-2 text-right font-mono text-xs" data-testid={`text-stock-${line.articleCode}`}>
                <StockCell model={model} line={line} />
              </TableCell>
            </TableRow>
          ))}

          {extraArticles.length > 0 && (
            <TableRow className="bg-muted/40" data-testid="row-extra-articles-heading">
              <TableCell colSpan={7} className="py-2 text-xs font-semibold text-muted-foreground">
                {model.tr("notOnProformaAllowed")}
              </TableCell>
            </TableRow>
          )}

          {extraArticles.map((code) => (
            <TableRow key={code} className="bg-muted/15" data-testid={`row-extra-${code}`}>
              <TableCell className="py-2 font-mono text-xs">{code}</TableCell>
              <TableCell className="py-2 text-xs text-muted-foreground">
                {groupedBalesMap[code]?.baleName || "—"}
              </TableCell>
              <TableCell className="py-2 text-right font-mono text-xs text-muted-foreground">—</TableCell>
              <TableCell className="py-2 text-right font-mono text-xs">{formatNumber(loadedByArticle[code])}</TableCell>
              <TableCell className="py-2 text-right font-mono text-xs text-muted-foreground">—</TableCell>
              <TableCell className="py-2">
                <Badge variant="outline" className={`${BADGE_BASE} text-muted-foreground`}>
                  {model.tr("notOnProforma")}
                </Badge>
              </TableCell>
              <TableCell className="py-2 text-right font-mono text-xs text-muted-foreground">—</TableCell>
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
    <div className="border-t px-4 py-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{model.tr("loadedByArticle")}</p>
      <div className="max-h-[190px] overflow-auto rounded-xl border">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead className="py-1.5 text-xs">{model.tr("article")}</TableHead>
              <TableHead className="py-1.5 text-xs">{model.tr("product")}</TableHead>
              <TableHead className="py-1.5 text-right text-xs">{model.tr("qty")}</TableHead>
              <TableHead className="py-1.5 text-right text-xs">{model.tr("weight")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.orderedGroups.map((group) => (
              <TableRow key={group.articleCode} data-testid={`row-loaded-summary-${group.articleCode}`}>
                <TableCell className="py-1.5 font-mono text-xs">{group.articleCode}</TableCell>
                <TableCell className="max-w-[150px] truncate py-1.5 text-xs">{group.baleName}</TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">{group.bales.length}</TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">
                  {formatNumber(group.totalWeight, 2)} kg
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function OrderSummaryCard({ model }: { model: FactoryContainerLoadingScanModel }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-background/90 shadow-sm">
      <div className="border-b px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold sm:text-base">{model.tr("orderSummary")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{model.tr("notLinkedProforma")}</p>
      </div>

      <div className="grid grid-cols-3 gap-2 p-4">
        <div className="rounded-xl border bg-muted/20 p-3 text-center">
          <PackageCheck className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground" />
          <div className="font-mono text-base font-semibold" data-testid="text-total-bales">
            {model.bales.length}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{model.tr("bales")}</div>
        </div>
        <div className="rounded-xl border bg-muted/20 p-3 text-center">
          <Scale className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground" />
          <div className="font-mono text-base font-semibold" data-testid="text-total-weight">
            {formatNumber(model.totalWeight, 2)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">KG</div>
        </div>
        <div className="rounded-xl border bg-muted/20 p-3 text-center">
          <Layers3 className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground" />
          <div className="font-mono text-base font-semibold" data-testid="text-article-groups">
            {Object.keys(model.groupedBalesMap).length}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{model.tr("articles")}</div>
        </div>
      </div>
    </div>
  );
}

export function ProformaProgressPanel({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { orderId, linkedProforma, proformaProgress, bales, totalWeight } = model;
  if (!orderId) return null;
  if (!linkedProforma) return <OrderSummaryCard model={model} />;

  const requestedQty = proformaProgress.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const loadedTowardTarget = proformaProgress.reduce(
    (sum, line) => sum + Math.min(Number(line.totalLoaded || 0), Number(line.quantity || 0)),
    0
  );
  const progressPercent = requestedQty > 0 ? Math.min(100, Math.round((loadedTowardTarget / requestedQty) * 100)) : 0;

  return (
    <div
      className="overflow-hidden rounded-2xl border bg-background/90 shadow-sm"
      data-testid="card-proforma-progress"
    >
      <div className="px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold sm:text-base">{linkedProforma.name}</h3>
              <Badge variant="secondary" className="shrink-0 rounded-md" data-testid="badge-proforma-progress">
                {model.tr("reusable")}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{model.tr("currentLoadingProgress")}</p>
          </div>
          <div className="font-mono text-lg font-semibold">{progressPercent}%</div>
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progressPercent}%` }}
            aria-label={`${model.tr("proforma")} ${progressPercent}%`}
          />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-xl border bg-muted/15 px-2 py-2 text-center">
            <div className="font-mono text-sm font-semibold">{bales.length}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{model.tr("loadedKpi")}</div>
          </div>
          <div className="rounded-xl border bg-muted/15 px-2 py-2 text-center">
            <div className="font-mono text-sm font-semibold">{formatNumber(model.remainingProformaBales)}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{model.tr("remainingKpi")}</div>
          </div>
          <div className="rounded-xl border bg-muted/15 px-2 py-2 text-center">
            <div className="font-mono text-sm font-semibold">
              {model.fulfilledCount}/{model.totalLines}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{model.tr("linesDone")}</div>
          </div>
        </div>
      </div>

      <ComparisonTable model={model} />
      <LoadedBalesSummary model={model} />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span>{model.tr("proformaLines", { count: proformaProgress.length })}</span>
        <span className="font-mono">
          {bales.length} {model.tr("balesLower")} · {formatNumber(totalWeight, 2)} kg
        </span>
      </div>
    </div>
  );
}
