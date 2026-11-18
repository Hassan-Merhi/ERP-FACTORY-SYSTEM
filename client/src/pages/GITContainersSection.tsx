// Extracted from ./GITContainers.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock,
  DollarSign,
  Globe,
  Package,
  Ship,
  SlidersHorizontal,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OTW_COLS } from "./git-containers/gitContainerTypes";
import { SummaryCard } from "./git-containers/InlineCells";
import { useGITContainersState } from "./useGITContainersState";

export function GITContainersPopoverSection({
  colVis,
  otwHiddenCount,
  toggleOtwCol,
}: Pick<ReturnType<typeof useGITContainersState>, "colVis" | "otwHiddenCount" | "toggleOtwCol">) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="default" className="h-10 rounded-xl sm:h-11" data-testid="button-otw-columns">
          <SlidersHorizontal className="h-4 w-4 mr-1" />
          Columns
          {otwHiddenCount > 0 && (
            <span className="ml-1 text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 leading-none">
              {otwHiddenCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
          Show / Hide Columns
        </p>
        <div className="space-y-0.5">
          {OTW_COLS.map((col) => (
            <label
              key={col.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover-elevate cursor-pointer text-sm"
              data-testid={`col-toggle-otw-${col.id}`}
            >
              <Checkbox checked={colVis[col.id]} onCheckedChange={() => toggleOtwCol(col.id)} />
              {col.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function GITContainersSection({
  arrived,
  atPort,
  atSea,
  data,
  delayed,
  filteredContainers,
  inTransit,
  leftDar,
  offloadOverdue,
  totalCost,
  totalTransportDuty,
}: Pick<
  ReturnType<typeof useGITContainersState>,
  | "arrived"
  | "atPort"
  | "atSea"
  | "data"
  | "delayed"
  | "filteredContainers"
  | "inTransit"
  | "leftDar"
  | "offloadOverdue"
  | "totalCost"
  | "totalTransportDuty"
>) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-5">
      <SummaryCard
        label="Active"
        value={data?.summary?.total ?? data?.total ?? filteredContainers.length}
        icon={<Package className="h-4 w-4 text-primary" />}
        accent="bg-primary/10"
      />
      {atSea > 0 && (
        <SummaryCard
          label="At Sea / OTW"
          value={atSea}
          icon={<Ship className="h-4 w-4 text-blue-600" />}
          accent="bg-blue-100 dark:bg-blue-900/30"
        />
      )}
      {atPort > 0 && (
        <SummaryCard
          label="At Port"
          value={atPort}
          icon={<Package className="h-4 w-4 text-amber-600" />}
          accent="bg-amber-100 dark:bg-amber-900/30"
        />
      )}
      {leftDar > 0 && (
        <SummaryCard
          label="Left Dar"
          value={leftDar}
          icon={<Truck className="h-4 w-4 text-violet-600" />}
          accent="bg-violet-100 dark:bg-violet-900/30"
        />
      )}
      {inTransit > 0 && (
        <SummaryCard
          label="In Transit"
          value={inTransit}
          icon={<Truck className="h-4 w-4 text-indigo-600" />}
          accent="bg-indigo-100 dark:bg-indigo-900/30"
        />
      )}
      {arrived > 0 && (
        <SummaryCard
          label="Arrived"
          value={arrived}
          icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
          accent="bg-green-100 dark:bg-green-900/30"
        />
      )}
      {delayed > 0 && (
        <SummaryCard
          label="Delayed"
          value={delayed}
          icon={<Clock className="h-4 w-4 text-red-600" />}
          accent="bg-red-100 dark:bg-red-900/30"
        />
      )}
      {offloadOverdue > 0 && (
        <SummaryCard
          label="Offload Overdue"
          value={offloadOverdue}
          icon={<AlertTriangle className="h-4 w-4 text-red-600" />}
          accent="bg-red-100 dark:bg-red-900/30"
        />
      )}
      <SummaryCard
        label="Container Cost"
        value={totalCost}
        icon={<DollarSign className="h-4 w-4 text-green-600" />}
        accent="bg-green-100 dark:bg-green-900/30"
      />
      <SummaryCard
        label="Transport + Duty"
        value={totalTransportDuty}
        icon={<DollarSign className="h-4 w-4 text-muted-foreground" />}
      />
    </div>
  );
}

export function GITContainersSection2({
  allCompanies,
  data,
  restrictedToCurrentCompany,
  setAllCompanies,
  setCompanyFilter,
}: Pick<
  ReturnType<typeof useGITContainersState>,
  "allCompanies" | "data" | "restrictedToCurrentCompany" | "setAllCompanies" | "setCompanyFilter"
>) {
  return (
    <div className="flex shrink-0 items-center gap-2 flex-wrap max-sm:grid max-sm:grid-cols-2 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2">
      <button
        onClick={() => {
          setAllCompanies(false);
          setCompanyFilter("ALL");
        }}
        className={cn(
          "flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-sm transition-colors",
          !allCompanies
            ? "border-violet-600 bg-violet-600 text-white shadow-violet-500/15"
            : "border-border/80 bg-card/70 text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
        data-testid="button-my-company"
      >
        <Building2 className="h-3.5 w-3.5" />
        My Company
      </button>
      {!restrictedToCurrentCompany && (
        <button
          onClick={() => {
            setAllCompanies(true);
            setCompanyFilter("ALL");
          }}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-sm transition-colors",
            allCompanies
              ? "border-violet-600 bg-violet-600 text-white shadow-violet-500/15"
              : "border-border/80 bg-card/70 text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          data-testid="button-all-companies"
        >
          <Globe className="h-3.5 w-3.5" />
          All Accessible Companies
        </button>
      )}
      {data && (
        <span className="text-xs text-muted-foreground ml-1 max-sm:col-span-2 max-sm:ml-0">
          {data.total} active container{data.total !== 1 ? "s" : ""}
          {data.mode === "single" && data.companyName ? ` — ${data.companyName}` : ""}
        </span>
      )}
    </div>
  );
}
