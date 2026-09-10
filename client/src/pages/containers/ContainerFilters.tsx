import { Search, Filter, X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Supplier } from "@shared/schema";

interface ContainerFiltersProps {
  searchTerm: string;
  onSearchChange: (v: string) => void;
  statusFilter: string;
  onStatusChange: (v: string) => void;
  supplierFilter: string[];
  onSupplierFilterChange: (v: string[]) => void;
  suppliers: Supplier[];
  getSupplierName: (id: number) => string;
  onClearFilters: () => void;
}

export function ContainerFilters({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusChange,
  supplierFilter,
  onSupplierFilterChange,
  suppliers,
  getSupplierName,
  onClearFilters,
}: ContainerFiltersProps) {
  return (
    /* Inline filter row */
    <div className="flex flex-wrap gap-2 items-center">
      <div className="relative w-full min-w-0 sm:flex-1 sm:min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by container number..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10"
          data-testid="input-search-container"
        />
      </div>
      <div className="flex w-full gap-1 overflow-x-auto pb-1 sm:w-auto sm:flex-wrap sm:overflow-visible sm:pb-0">
        {(["ALL", "OTW", "OFFLOADED"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={statusFilter === s ? "default" : "outline"}
            onClick={() => onStatusChange(s)}
            className="shrink-0"
            data-testid={`button-status-${s.toLowerCase()}`}
          >
            {s === "ALL" ? "All" : s === "OTW" ? "OTW" : "Offloaded"}
          </Button>
        ))}
      </div>
      {suppliers.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 max-w-full sm:max-w-xs"
              data-testid="select-supplier-filter"
            >
              <Filter className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {supplierFilter.length === 0
                  ? "All Suppliers"
                  : supplierFilter.length === 1
                    ? getSupplierName(Number(supplierFilter[0]))
                    : `${supplierFilter.length} Suppliers`}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(20rem,calc(100vw-1rem))]">
            {suppliers.map((supplier) => {
              const val = supplier.id.toString();
              const checked = supplierFilter.includes(val);
              return (
                <DropdownMenuItem
                  key={supplier.id}
                  className="flex items-center gap-2 cursor-pointer"
                  onSelect={(e) => {
                    e.preventDefault();
                    onSupplierFilterChange(
                      checked ? supplierFilter.filter((v) => v !== val) : [...supplierFilter, val]
                    );
                  }}
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="truncate">{supplier.legalName}</span>
                </DropdownMenuItem>
              );
            })}
            {supplierFilter.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-muted-foreground text-xs cursor-pointer justify-center"
                  onSelect={(e) => {
                    e.preventDefault();
                    onSupplierFilterChange([]);
                  }}
                >
                  Clear selection
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {(statusFilter !== "ALL" || supplierFilter.length > 0 || searchTerm) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onClearFilters();
            onSearchChange("");
            onSupplierFilterChange([]);
          }}
          data-testid="button-clear-filters"
        >
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
