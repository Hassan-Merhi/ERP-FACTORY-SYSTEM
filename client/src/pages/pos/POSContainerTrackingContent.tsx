// Extracted from ./POSContainerTracking.tsx
import { Columns3, FilterX, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COLUMN_DEFS } from "./usePOSContainerTrackingState";
import { usePOSContainerTrackingState2 } from "./usePOSContainerTrackingState2";

export function POSContainerTrackingContent({
  agentFilter,
  agentOptions,
  clearFilters,
  docsFilter,
  hasActiveFilters,
  isColumnVisible,
  search,
  setAgentFilter,
  setDocsFilter,
  setSearch,
  setStatusFilter,
  setSupplierFilter,
  setTransporterFilter,
  statusFilter,
  statusOptions,
  supplierFilter,
  supplierOptions,
  toggleColumn,
  transporterFilter,
  transporterOptions,
}: Pick<
  ReturnType<typeof usePOSContainerTrackingState2>,
  | "agentFilter"
  | "agentOptions"
  | "clearFilters"
  | "docsFilter"
  | "hasActiveFilters"
  | "isColumnVisible"
  | "search"
  | "setAgentFilter"
  | "setDocsFilter"
  | "setSearch"
  | "setStatusFilter"
  | "setSupplierFilter"
  | "setTransporterFilter"
  | "statusFilter"
  | "statusOptions"
  | "supplierFilter"
  | "supplierOptions"
  | "toggleColumn"
  | "transporterFilter"
  | "transporterOptions"
>) {
  return (
    <div className="pos-container-filters shrink-0">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search container, supplier, truck, location, agent, transporter..."
            className="h-9 pl-9"
            data-testid="input-pos-container-search"
          />
        </div>

        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-2" onClick={clearFilters}>
            <FilterX className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Select value={supplierFilter} onValueChange={setSupplierFilter}>
          <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-supplier">
            <SelectValue placeholder="Supplier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All suppliers</SelectItem>
            {supplierOptions.map((supplier) => (
              <SelectItem key={supplier} value={supplier}>
                {supplier}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statusOptions.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={docsFilter} onValueChange={setDocsFilter}>
          <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-docs">
            <SelectValue placeholder="Docs" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All docs</SelectItem>
            <SelectItem value="received">Docs received</SelectItem>
            <SelectItem value="missing">Docs not received</SelectItem>
            <SelectItem value="sent">Docs sent</SelectItem>
            <SelectItem value="ready-not-sent">Received, not sent</SelectItem>
          </SelectContent>
        </Select>

        <Select value={transporterFilter} onValueChange={setTransporterFilter}>
          <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-transporter">
            <SelectValue placeholder="Transporter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All transporters</SelectItem>
            {transporterOptions.map((transporter) => (
              <SelectItem key={transporter} value={transporter}>
                {transporter}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-agent">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agentOptions.map((agent) => (
              <SelectItem key={agent} value={agent}>
                {agent}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-9 w-full gap-2" data-testid="button-pos-container-columns">
              <Columns3 className="h-4 w-4" aria-hidden="true" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {COLUMN_DEFS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column.key}
                checked={isColumnVisible(column.key)}
                disabled={column.key === "container"}
                onCheckedChange={() => toggleColumn(column.key)}
                onSelect={(event) => event.preventDefault()}
              >
                {column.label}
                {column.key === "container" ? " (fixed)" : ""}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
