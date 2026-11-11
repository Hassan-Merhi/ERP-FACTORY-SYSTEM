/**
 * Types, formatters and presentational pieces for the Loading Dispatch
 * comparison page (FactoryLoadingDispatchCompare). Split out so the page file
 * stays within the repository's file-size boundary; no behaviour lives here
 * that was not in the page before.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, AlertTriangle, FileSearch, Package, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface TripSummary {
  id: string;
  dispatchNumber: number;
  status: string;
  truckPlate: string | null;
  scannedBales: number;
  scannedWeightKg: number;
}
export type ArticleStatus = "MATCH" | "MISSING" | "EXTRA" | "BOTH" | "UNPLANNED";
export interface ArticleComparison {
  articleCode: string;
  productName: string;
  expectedQty: number | null;
  scannedQty: number;
  matchedQty: number;
  missingQty: number | null;
  extraQty: number;
  expectedWeightKg: number | null;
  scannedWeightKg: number;
  priorityRank: number | null;
  status: ArticleStatus;
}
export interface BaleFinding {
  orderBaleId?: number;
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: number;
  reason: string;
  dispatchId?: string;
  dispatchNumber?: number;
  expectedDispatchNumber?: number;
  scannedBy?: string;
  scannedAt?: string;
}
export interface Summary {
  loadedBales: number;
  loadedWeightKg: number;
  expectedBales: number | null;
  expectedWeightKg: number | null;
  weightDifferenceKg: number | null;
  verifiedBales: number;
  verifiedWeightKg: number;
  matchedBales: number;
  missingBales: number | null;
  unexpectedBales: number;
  exactMissingBales: number;
  crossTripMisplacedBales: number;
  duplicateBales: number;
  progressPercent: number | null;
}
export interface Comparison {
  scope: "overall" | "trip";
  orderId: number;
  containerNumber: string | null;
  loadingStatus: string;
  generatedAt: string;
  dispatch: TripSummary | null;
  planSource: "none" | "article" | "bale" | "mixed" | "loading";
  hasTripPlan: boolean;
  summary: Summary;
  articles: ArticleComparison[];
  missingBales: BaleFinding[];
  unexpectedBales: BaleFinding[];
  crossTripBales: BaleFinding[];
  duplicateBales: BaleFinding[];
  trips: TripSummary[];
}

export type Filter = "all" | "missing" | "extra" | "match" | "unplanned";
export type FindingsKind = "missing" | "unexpected" | "cross" | "duplicate";
export const PAGE_SIZE = 80;

export function printNumber(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
export function tripLabel(n: number): string {
  return "Dispatch #" + String(n).padStart(3, "0");
}
export function dispatchBase(orderId: number): string {
  return "/factory/sales/loading/dispatch/" + orderId;
}
export function comparePath(orderId: number, dispatchId?: string): string {
  return dispatchBase(orderId) + (dispatchId ? "/" + dispatchId : "") + "/compare";
}

export async function getComparison(url: string): Promise<Comparison> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || "Unable to calculate truck comparison");
  }
  return response.json() as Promise<Comparison>;
}

export function StatusBadge({ value }: { value: ArticleStatus }) {
  const style =
    value === "MATCH"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
      : value === "MISSING"
        ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
        : value === "EXTRA" || value === "BOTH"
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200"
          : "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
  const label = { MATCH: "Match", MISSING: "Missing", EXTRA: "Extra", BOTH: "Difference", UNPLANNED: "Scanned" }[value];
  return (
    <Badge variant="outline" className={style}>
      {label}
    </Badge>
  );
}

export function Metric({
  label,
  value,
  icon: Icon,
  unit,
  emphasis = "default",
}: {
  label: string;
  value: string;
  icon: typeof Package;
  unit?: string;
  emphasis?: "default" | "good" | "warning";
}) {
  return (
    <Card className="border-slate-200 bg-white/95 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
      <CardContent className="flex items-center justify-between gap-2 p-3 sm:p-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p
            className={
              "mt-1 font-mono text-xl font-bold sm:text-2xl " +
              (emphasis === "warning"
                ? "text-amber-600 dark:text-amber-300"
                : emphasis === "good"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "")
            }
            data-testid={"compare-" + label.toLowerCase().replace(/\s+/g, "-")}
          >
            {value} {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
          </p>
        </div>
        <span className="rounded-xl bg-blue-50 p-2 text-blue-600 dark:bg-blue-500/10 dark:text-sky-300">
          <Icon className="h-5 w-5" />
        </span>
      </CardContent>
    </Card>
  );
}

export function explainReason(reason: string): string {
  return (
    (
      {
        NOT_VERIFIED_ON_ANY_TRIP: "In main loading, not verified on any truck",
        EXPECTED_NOT_SCANNED: "Assigned to this trip but not scanned",
        PLAN_BALE_NO_LONGER_LOADED: "Assigned bale was removed from main loading",
        NO_LONGER_IN_LOADING: "Verified on a truck, but no longer in main loading",
        ASSIGNED_TO_ANOTHER_TRIP: "Verified here, allocated to a different trip",
        SCANNED_DIFFERENT_TRIP: "Bale was assigned to one truck but scanned on another",
        NOT_IN_TRIP_PLAN: "Verified here, but not assigned to this trip\u0027s article or bale plan",
        NOT_IN_EXACT_TRIP_PLAN: "Verified here, but not assigned in this trip's exact-bale plan",
        PLANNED_HERE_SCANNED_ELSEWHERE: "Assigned to this trip, verified on a different one",
        DUPLICATE_ACTIVE_VERIFICATION: "Unexpected duplicate active verification",
      } as Record<string, string>
    )[reason] || reason.replace(/_/g, " ").toLowerCase()
  );
}

export function Findings({
  title,
  subtitle,
  items,
  kind,
  orderId,
}: {
  title: string;
  subtitle: string;
  items: BaleFinding[];
  kind: FindingsKind;
  orderId: number;
}) {
  const [, navigate] = useLocation();
  const [visibleCount, setVisibleCount] = useState(30);
  const visible = items.slice(0, visibleCount);
  const icon =
    kind === "missing" ? (
      <FileSearch className="h-4 w-4 text-amber-600" />
    ) : kind === "unexpected" ? (
      <AlertCircle className="h-4 w-4 text-red-600" />
    ) : kind === "cross" ? (
      <Truck className="h-4 w-4 text-blue-500" />
    ) : (
      <AlertTriangle className="h-4 w-4 text-red-600" />
    );

  return (
    <Card className="min-w-0 border-slate-200 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5">{icon}</span>
            <div>
              <h3 className="text-sm font-bold">{title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <Badge variant="secondary">{printNumber(items.length)}</Badge>
        </div>
        {items.length === 0 ? (
          <div className="rounded-lg bg-slate-50 p-4 text-sm text-muted-foreground dark:bg-[hsl(var(--factory-hue)_58%_10%)]">
            No{" "}
            {kind === "missing"
              ? "missing references"
              : kind === "unexpected"
                ? "unexpected verifications"
                : kind === "cross"
                  ? "cross-trip allocation mismatches"
                  : "duplicate records"}{" "}
            detected.
          </div>
        ) : (
          <>
            <div className="max-h-[420px] overflow-x-auto overflow-y-auto rounded-lg border dark:border-slate-700">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-muted-foreground dark:bg-[hsl(var(--factory-hue)_58%_10%)]">
                  <tr>
                    <th className="px-3 py-2">Bale reference</th>
                    <th className="px-3 py-2">Difference</th>
                    <th className="px-3 py-2 text-right">Kg</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((finding, i) => (
                    <tr
                      key={finding.baleId + ":" + finding.reason + ":" + i}
                      className="border-t dark:border-slate-700"
                    >
                      <td className="px-3 py-2 align-top">
                        <p className="font-mono font-semibold">{finding.baleReference || "Bale #" + finding.baleId}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {finding.articleCode || "No article"} · {finding.productName || "Bale"}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p>{explainReason(finding.reason)}</p>
                        {finding.expectedDispatchNumber && (
                          <p className="text-[11px] text-blue-600 dark:text-sky-300">
                            Expected on {tripLabel(finding.expectedDispatchNumber)}
                          </p>
                        )}
                        {finding.dispatchNumber && (
                          <button
                            type="button"
                            className="mt-1 text-[11px] text-blue-600 underline-offset-2 hover:underline dark:text-sky-300"
                            onClick={() => navigate(dispatchBase(orderId) + "/" + finding.dispatchId)}
                          >
                            Scanned on {tripLabel(finding.dispatchNumber)}
                            {finding.scannedBy ? " by " + finding.scannedBy : ""}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right align-top font-mono">{printNumber(finding.weightKg, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {items.length > visibleCount && (
                <Button size="sm" variant="outline" onClick={() => setVisibleCount((count) => count + 100)}>
                  Show next {printNumber(Math.min(100, items.length - visibleCount))} references
                </Button>
              )}
              {visibleCount > 30 && (
                <Button size="sm" variant="ghost" onClick={() => setVisibleCount(30)}>
                  Show fewer
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
