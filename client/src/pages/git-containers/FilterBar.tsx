import { createContext, useContext } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
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
}

/** True when the bar renders inside the phone filter sheet. */
const SheetLayoutContext = createContext(false);

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1 leading-none">
      {children}
    </span>
  );
}

function Col({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  const inSheet = useContext(SheetLayoutContext);
  return (
    <div className={cn("flex flex-col min-w-0", inSheet ? "w-full" : className)}>
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
}: FilterBarProps) {
  const inSheet = variant === "sheet";
  if (!showFilters && !inSheet) return null;

  const activeCount = countGitContainerFilters({
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
  });

  const sx = inSheet ? "h-11 text-sm" : "h-7 text-xs";
  const rowClass = inSheet ? "grid grid-cols-1 gap-3 min-[400px]:grid-cols-2" : "flex flex-wrap gap-2";

  return (
    <SheetLayoutContext.Provider value={inSheet}>
      <div
        className={
          inSheet
            ? "space-y-3"
            : "rounded-lg border border-border/50 bg-card/60 backdrop-blur-sm p-3 space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-150"
        }
      >
        {/* ── Row 1: entity filters ─────────────────────────────────── */}
        <div className={rowClass}>
          <Col label="Company" className="w-32">
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

          <Col label="Container #" className="w-36">
            <MultiFilterSelect
              allLabel="All Containers"
              options={containerNumbers.map((n) => ({ label: n, value: n }))}
              selected={containerFilters}
              onChange={setContainerFilters}
              testId="multi-filter-container"
              searchable
            />
          </Col>

          <Col label="Supplier" className="w-28">
            <MultiFilterSelect
              allLabel="All Suppliers"
              options={suppliers.map((s) => ({ label: s, value: s }))}
              selected={supplierFilters}
              onChange={setSupplierFilters}
              testId="multi-filter-supplier"
            />
          </Col>

          {/* thin vertical rule */}
          <div className={cn("hidden self-stretch w-px bg-border/50 mx-0.5", !inSheet && "sm:block")} />

          <Col label="Transporter" className="w-32">
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

          <Col label="Agent" className="w-28">
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

          <Col label="Truck" className="w-28">
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

          <Col label="Location" className="w-28">
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
        </div>

        {/* thin horizontal rule */}
        <div className="border-t border-border/40" />

        {/* ── Row 2: attribute filters + sort + reset ───────────────── */}
        <div className={cn(rowClass, !inSheet && "items-end")}>
          <Col label="Docs" className="w-28">
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

          <Col label="Delayed" className="w-32">
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

          <Col label="Freight" className="w-28">
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

          <Col label="ETA" className="w-40">
            <EtaDateFilter
              value={etaFilter}
              onChange={setEtaFilter}
              allEtaDates={allEtaDates}
              hasContainersWithNoEta={hasContainersWithNoEta}
              testId="select-filter-eta"
            />
          </Col>

          <Col label="Notes" className="w-28">
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

          {/* thin vertical rule */}
          <div className={cn("hidden self-stretch w-px bg-border/50 mx-0.5", !inSheet && "sm:block")} />

          <Col label="Sort" className="flex-1 min-w-40">
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

          <div className={cn("ml-auto self-end", inSheet && "hidden")}>
            <Button
              variant={activeCount > 0 ? "secondary" : "ghost"}
              size="sm"
              className={cn("h-7 text-xs gap-1.5", activeCount > 0 ? "text-foreground" : "text-muted-foreground")}
              onClick={clearFilters}
              data-testid="button-reset-filters"
              disabled={activeCount === 0}
            >
              <X className="h-3 w-3" />
              Clear{activeCount > 0 ? ` (${activeCount})` : ""}
            </Button>
          </div>
        </div>
      </div>
    </SheetLayoutContext.Provider>
  );
}
