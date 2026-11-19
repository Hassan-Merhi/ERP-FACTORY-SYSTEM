// Extracted from ./FilterBar.tsx
import { cn } from "@/lib/utils";
import type { EtaFilterValue } from "./gitContainerTypes";

export interface FilterBarProps {
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

export function Col({ label, children }: { label: string; children: React.ReactNode; className?: string }) {
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
