import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SlidersHorizontal, X } from "lucide-react";
import { MultiFilterSelect } from "./MultiFilterSelect";
import { EtaDateFilter } from "./EtaDateFilter";
import { cn } from "@/lib/utils";
import type { EtaFilterValue } from "./gitContainerTypes";

interface FilterBarProps {
  showFilters: boolean;
  /** "sheet" renders the same controls as a single phone column inside the ERP filter sheet. */
  variant?: "panel" | "sheet";
  companyFilter: string;
  setCompanyFilter: (v: string) => void;
  companies: string[];
  containerNumbers: string[];
  containerFilters: string[];
  setContainerFilters: (v: string[]) => void;
  suppliers: string[];
  supplierFilters: string[];
  setSupplierFilters: (v: string[]) => void;
  transporters: string[];
  transporterFilters: string[];
  setTransporterFilters: (v: string[]) => void;
  agents: string[];
  agentFilters: string[];
  setAgentFilters: (v: string[]) => void;
  trucks: string[];
  truckFilters: string[];
  setTruckFilters: (v: string[]) => void;
  locations: string[];
  locationFilters: string[];
  setLocationFilters: (v: string[]) => void;
  docsFilter: string;
  setDocsFilter: (v: string) => void;
  delayedFilter: string;
  setDelayedFilter: (v: string) => void;
  freightFilter: string;
  setFreightFilter: (v: string) => void;
  etaFilter: EtaFilterValue;
  setEtaFilter: (v: EtaFilterValue) => void;
  allEtaDates: string[];
  hasContainersWithNoEta: boolean;
  notesFilter: string;
  setNotesFilter: (v: string) => void;
  sortOrder: string;
  setSortOrder: (v: string) => void;
  clearFilters: () => void;
  onApply?: () => void;
}

/** True when the bar renders inside the phone filter sheet. */
function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1 leading-none">
      {children}
    </span>
  );
}

function Col({ label, children }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col min-w-0", "w-full")}>
      <Lbl>{label}</Lbl>
      {children}
    </div>
  );
}

export function countGitContainerFilters({
  companyFilter,
  containerFilters,
  supplierFilters,
  transporterFilters,
  agentFilters,
  truckFilters,
  locationFilters,
  docsFilter,
  delayedFilter,
  freightFilter,
  etaFilter,
  notesFilter,
  sortOrder,
}: Pick<
  FilterBarProps,
  | "companyFilter"
  | "containerFilters"
  | "supplierFilters"
  | "transporterFilters"
  | "agentFilters"
  | "truckFilters"
  | "locationFilters"
  | "docsFilter"
  | "delayedFilter"
  | "freightFilter"
  | "etaFilter"
  | "notesFilter"
  | "sortOrder"
>): number {
  return [
    companyFilter !== "ALL" ? 1 : 0,
    containerFilters.length,
    supplierFilters.length,
    transporterFilters.length,
    agentFilters.length,
    truckFilters.length,
    locationFilters.length,
    docsFilter !== "ALL" ? 1 : 0,
    delayedFilter !== "ALL" ? 1 : 0,
    freightFilter !== "ALL" ? 1 : 0,
    etaFilter !== "ALL" ? 1 : 0,
    notesFilter !== "ALL" ? 1 : 0,
    sortOrder !== "DEFAULT" ? 1 : 0,
  ].reduce((a, b) => a + b, 0);
}

export function FilterBar({
  showFilters,
  variant = "panel",
  companyFilter,
  setCompanyFilter,
  companies,
  containerNumbers,
  containerFilters,
  setContainerFilters,
  suppliers,
  supplierFilters,
  setSupplierFilters,
  transporters,
  transporterFilters,
  setTransporterFilters,
  agents,
  agentFilters,
  setAgentFilters,
  trucks,
  truckFilters,
  setTruckFilters,
  locations,
  locationFilters,
  setLocationFilters,
  docsFilter,
  setDocsFilter,
  delayedFilter,
  setDelayedFilter,
  freightFilter,
  setFreightFilter,
  etaFilter,
  setEtaFilter,
  allEtaDates,
  hasContainersWithNoEta,
  notesFilter,
  setNotesFilter,
  sortOrder,
  setSortOrder,
  clearFilters,
  onApply,
}: FilterBarProps) {

  const inSheet = variant === "sheet";
  if (!showFilters && !inSheet) return null;

  const activeCount = countGitContainerFilters({
    companyFilter, containerFilters, supplierFilters, transporterFilters,
    agentFilters, truckFilters, locationFilters, docsFilter, delayedFilter,
    freightFilter, etaFilter, notesFilter, sortOrder,
  });
  const sx = inSheet ? "h-11 text-sm w-full" : "h-9 text-sm w-full";

  return (
    <>
      <section
        aria-label="Advanced container filters"
        id="otw-filter-panel"
        data-testid="otw-advanced-filter-panel"
        className={cn(
          "min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-sm",
          "dark:border-violet-400/20 dark:bg-gradient-to-br dark:from-slate-900 dark:via-slate-950 dark:to-slate-900",
          inSheet && "border-0 shadow-none rounded-none bg-transparent dark:bg-none"
        )}
      >
        {!inSheet && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">Advanced Filters</h2>
                <p className="text-xs text-muted-foreground">All filters, organized in one place</p>
              </div>
            </div>
            <span className="rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-700 dark:text-violet-300">
              {activeCount} active
            </span>
          </div>
        )}
        <div className={cn("min-w-0", inSheet ? "py-1" : "p-4 sm:p-5")}>
          <div className={cn("grid min-w-0 gap-x-4 gap-y-4", inSheet ? "grid-cols-1 min-[420px]:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4")}>
                <Col label="Company" className="w-full">
            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger className={sx} data-testid="select-filter-company">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Companies</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Col>
<Col label="Container #" className="w-full">
            <MultiFilterSelect
              allLabel="All Containers"
              options={containerNumbers.map((n) => ({ label: n, value: n }))}
              selected={containerFilters}
              onChange={setContainerFilters}
              testId="multi-filter-container"
              searchable
            />
          </Col>
<Col label="Supplier" className="w-full">
            <MultiFilterSelect
              allLabel="All Suppliers"
              options={suppliers.map((s) => ({ label: s, value: s }))}
              selected={supplierFilters}
              onChange={setSupplierFilters}
              testId="multi-filter-supplier"
            />
          </Col>
                <Col label="Transporter" className="w-full">
            <MultiFilterSelect
              allLabel="All Transporters"
              options={[
                { label: "No Transporter", value: "NO_TRANSPORTER" },
                { label: "────────────────", value: "SEP", dividerBefore: true },
                ...transporters.map((t) => ({ label: t, value: t })),
              ]}
              selected={transporterFilters}
              onChange={setTransporterFilters}
              testId="multi-filter-transporter"
            />
          </Col>
<Col label="Agent" className="w-full">
            <MultiFilterSelect
              allLabel="All Agents"
              options={[
                { label: "No Agent", value: "NO_AGENT" },
                { label: "────────────────", value: "SEP", dividerBefore: true },
                ...agents.map((a) => ({ label: a, value: a })),
              ]}
              selected={agentFilters}
              onChange={setAgentFilters}
              testId="multi-filter-agent"
            />
          </Col>
<Col label="Truck" className="w-full">
            <MultiFilterSelect
              allLabel="All Trucks"
              options={[
                { label: "With Truck #", value: "HAS_TRUCK" },
                { label: "No Truck #", value: "NO_TRUCK" },
                { label: "────────────────", value: "SEP", dividerBefore: true },
                ...trucks.map((t) => ({ label: t, value: t })),
              ]}
              selected={truckFilters}
              onChange={setTruckFilters}
              testId="multi-filter-truck"
            />
          </Col>
<Col label="Location" className="w-full">
            <MultiFilterSelect
              allLabel="All Locations"
              options={[
                { label: "With Location", value: "HAS_LOCATION" },
                { label: "No Location", value: "NO_LOCATION" },
                { label: "────────────────", value: "SEP", dividerBefore: true },
                ...locations.map((l) => ({ label: l, value: l })),
              ]}
              selected={locationFilters}
              onChange={setLocationFilters}
              testId="multi-filter-location"
            />
          </Col>
                <Col label="Docs" className="w-full">
            <Select value={docsFilter} onValueChange={setDocsFilter}>
              <SelectTrigger className={sx} data-testid="select-filter-docs">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="MISSING">Missing</SelectItem>
                <SelectItem value="RECEIVED">Received</SelectItem>
              </SelectContent>
            </Select>
          </Col>
<Col label="Delayed" className="w-full">
            <Select value={delayedFilter} onValueChange={setDelayedFilter}>
              <SelectTrigger className={sx} data-testid="select-filter-delayed">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="YES">ETA Passed</SelectItem>
                <SelectItem value="OVERDUE">Offload Overdue</SelectItem>
                <SelectItem value="NO">Not Delayed</SelectItem>
              </SelectContent>
            </Select>
          </Col>
<Col label="Freight" className="w-full">
            <Select value={freightFilter} onValueChange={setFreightFilter}>
              <SelectTrigger className={sx} data-testid="select-filter-freight">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="HAS_FREIGHT">Paid</SelectItem>
                <SelectItem value="NO_FREIGHT">Unpaid</SelectItem>
              </SelectContent>
            </Select>
          </Col>
<Col label="ETA" className="w-full">
            <EtaDateFilter
              value={etaFilter}
              onChange={setEtaFilter}
              allEtaDates={allEtaDates}
              hasContainersWithNoEta={hasContainersWithNoEta}
              testId="select-filter-eta"
            />
          </Col>
                <Col label="Notes" className="w-full">
            <Select value={notesFilter} onValueChange={setNotesFilter}>
              <SelectTrigger className={sx} data-testid="select-filter-notes">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="WITH">With Notes</SelectItem>
                <SelectItem value="WITHOUT">No Notes</SelectItem>
              </SelectContent>
            </Select>
          </Col>
<Col label="Sort" className="w-full">
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className={sx} data-testid="select-filter-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEFAULT">Default (Company + Shop)</SelectItem>
                <SelectItem value="ETA_ASC">ETA — Earliest First</SelectItem>
                <SelectItem value="ETA_DESC">ETA — Latest First</SelectItem>
              </SelectContent>
            </Select>
          </Col>
            </div>
        </div>
        {!inSheet && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
            <span className="text-xs text-muted-foreground">Changes update the table automatically.</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={activeCount === 0 && sortOrder === "DEFAULT"} onClick={clearFilters} data-testid="button-reset-filters">
                <X className="mr-1 h-3.5 w-3.5" /> Clear all
              </Button>
              {onApply && <Button type="button" size="sm" className="bg-violet-600 text-white hover:bg-violet-700" onClick={onApply} data-testid="otw-filters-apply">Done</Button>}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
