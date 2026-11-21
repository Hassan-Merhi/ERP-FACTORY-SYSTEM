// Extracted from ./TabDetail.tsx
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { Button } from "@/components/ui/button";
import { Building2, Boxes, Truck, Anchor, FileCheck2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { gitContainersUrl, parseNum } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function useTabDetailState() {
  const { data: viewer } = useQuery(authenticatedUserQueryOptions());
  const role = viewer?.currentRole ?? viewer?.role;
  const isTester = role === "ERP Tester";
  const isViewer = isExistingRecordReadOnlyRole(role);
  const restrictedViewer = isTester || isViewer;
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [view, setView] = useState<"workbook" | "flat">("workbook");
  const [search, setSearch] = useState("");

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all" });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = useMemo(() => data?.containers ?? [], [data?.containers]);

  const filtered = useMemo(() => {
    if (!search) return allContainers;
    return allContainers.filter((r) =>
      searchAny(search, r.containerNumber, r.companyName, r.transporter, r.agent, r.numberPlate, r.trackingLocation)
    );
  }, [allContainers, search]);

  const totals = useMemo(
    () => ({
      amount: filtered.reduce((s, r) => s + parseNum(r.grandTotal), 0),
      fee: filtered.reduce((s, r) => s + parseNum(r.transportFee), 0),
      duty: filtered.reduce((s, r) => s + parseNum(r.dutyFee), 0),
    }),
    [filtered]
  );

  const companies = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; rows: EnrichedContainerApi[] }>();
    for (const r of filtered) {
      if (!seen.has(r.companyId)) seen.set(r.companyId, { id: r.companyId, name: r.companyName, rows: [] });
      seen.get(r.companyId)!.rows.push(r);
    }
    return [...seen.values()];
  }, [filtered]);

  // Derive the overview from the exact same filtered, company-scoped rows as the workbook.
  // Never show illustrative counts from the design mockup in production.
  const statusSummary = useMemo(
    () => ({
      inTransit: filtered.filter((r) => ["OTW", "Sea", "Left Dar", "At Border", "In Transit"].includes(r.status))
        .length,
      portDocsPending: filtered.filter((r) => r.status === "At Port" && !r.docReceived).length,
      docsReceived: filtered.filter((r) => !!r.docReceived).length,
    }),
    [filtered]
  );

  const summaryCards = [
    {
      label: "Total Containers",
      value: filtered.length,
      icon: Boxes,
      style:
        "border-violet-300/50 bg-gradient-to-br from-violet-100 to-violet-50 dark:border-violet-500/40 dark:from-violet-500/25 dark:to-violet-950/20",
      iconStyle: "bg-violet-500/15 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200",
    },
    {
      label: "In Transit",
      value: statusSummary.inTransit,
      icon: Truck,
      style:
        "border-emerald-300/60 bg-gradient-to-br from-emerald-50 to-teal-50 dark:border-emerald-500/35 dark:from-emerald-500/20 dark:to-teal-950/20",
      iconStyle: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    },
    {
      label: "At Port / Docs Missing",
      value: statusSummary.portDocsPending,
      icon: Anchor,
      style:
        "border-amber-300/60 bg-gradient-to-br from-amber-50 to-orange-50 dark:border-amber-500/35 dark:from-amber-500/20 dark:to-orange-950/20",
      iconStyle: "bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    },
    {
      label: "Docs Received",
      value: statusSummary.docsReceived,
      icon: FileCheck2,
      style:
        "border-sky-300/60 bg-gradient-to-br from-blue-50 to-sky-50 dark:border-blue-500/35 dark:from-blue-500/20 dark:to-sky-950/20",
      iconStyle: "bg-sky-500/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    },
  ];

  const modeSelector = (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/80 p-2 shadow-sm max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:min-w-0 max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-2"
      data-testid="detail-mode-selector"
    >
      <Building2 className="max-sm:hidden h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="max-sm:hidden text-xs text-muted-foreground">View:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className={cn(
          "gap-1.5 rounded-lg text-xs font-semibold",
          companyMode === "session" &&
            "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
        )}
        onClick={() => setCompanyMode("session")}
        data-testid="button-detail-my-company"
      >
        My Company
      </Button>
      {!restrictedViewer && (
        <Button
          size="sm"
          variant={companyMode === "all" ? "default" : "outline"}
          className={cn(
            "gap-1.5 rounded-lg text-xs font-semibold",
            companyMode === "all" &&
              "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
          )}
          onClick={() => setCompanyMode("all")}
          data-testid="button-detail-all-companies"
        >
          All Accessible Companies
        </Button>
      )}
    </div>
  );
  return {
    view,
    setView,
    search,
    setSearch,
    isLoading,
    isError,
    error,
    allContainers,
    filtered,
    totals,
    companies,
    summaryCards,
    modeSelector,
  };
}
