import { CalendarDays, Loader2, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Location } from "@shared/schema";
import type { CustomerOption, WorkerCategoryRow } from "./types";

interface StockEntrySidebarProps {
  selectedLocationId: string;
  onLocationChange: (val: string) => void;
  activeLocations: Location[];
  entryDate: string;
  onEntryDateChange: (val: string) => void;
  workerCategoryFilter: string;
  onWorkerCategoryFilterChange: (val: string) => void;
  workerCategoryGroups: WorkerCategoryRow[];
  selectedCustomerId: string;
  onCustomerIdChange: (val: string) => void;
  allCustomers: CustomerOption[];
  totalQty: number;
  totalKg: number;
  isPending: boolean;
  onConfirm: () => void;
}

export function StockEntrySidebar({
  selectedLocationId,
  onLocationChange,
  activeLocations,
  entryDate,
  onEntryDateChange,
  workerCategoryFilter,
  onWorkerCategoryFilterChange,
  workerCategoryGroups,
  selectedCustomerId,
  onCustomerIdChange,
  allCustomers,
  totalQty,
  totalKg,
  isPending,
  onConfirm,
}: StockEntrySidebarProps) {
  return (
    <aside className="min-w-0 xl:sticky xl:top-6" aria-label="Stock entry options and totals">
      <div className="min-w-0 space-y-5 rounded-2xl border bg-card p-3 shadow-sm sm:p-5">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Location & Date</p>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <Select value={selectedLocationId} onValueChange={onLocationChange}>
                <SelectTrigger className="min-h-11 w-full rounded-xl" data-testid="select-location">
                  <SelectValue placeholder="Select Warehouse..." />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations?.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative min-w-0">
                <CalendarDays className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="date"
                  value={entryDate}
                  onChange={(e) => onEntryDateChange(e.target.value)}
                  className="h-11 min-w-0 rounded-xl pl-9"
                  aria-label="Stock entry date"
                  data-testid="input-entry-date"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Filters & Options</p>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div className="min-w-0 space-y-1">
                <Label className="px-1 text-xs font-semibold text-muted-foreground">Worker Group</Label>
                <Select value={workerCategoryFilter} onValueChange={onWorkerCategoryFilterChange}>
                  <SelectTrigger className="min-h-11 w-full rounded-xl text-sm" data-testid="select-worker-group">
                    <SelectValue placeholder="Filter workers..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Workers</SelectItem>
                    {workerCategoryGroups.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1">
                <Label className="px-1 text-xs font-semibold text-muted-foreground">Customer Print Logo</Label>
                <Select value={selectedCustomerId} onValueChange={onCustomerIdChange}>
                  <SelectTrigger className="min-h-11 w-full rounded-xl text-sm" data-testid="select-customer-logo">
                    <SelectValue placeholder="Global customer logo..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Global Logo</SelectItem>
                    {allCustomers
                      .filter((c) => c.active)
                      .map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.legalName}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t pt-4">
          <div className="min-w-0 rounded-lg bg-muted/40 p-3">
            <span className="block text-xs font-medium text-muted-foreground">Total Bales</span>
            <span
              className="mt-1 block break-words text-xl font-black tabular-nums text-primary"
              data-testid="text-total-qty"
            >
              {totalQty}
            </span>
          </div>
          <div className="min-w-0 rounded-lg bg-muted/40 p-3">
            <span className="block text-xs font-medium text-muted-foreground">Total Weight</span>
            <span
              className="mt-1 block break-words text-xl font-black tabular-nums text-primary"
              data-testid="text-total-kg"
            >
              {totalKg.toFixed(1)}
              <span className="ml-1 text-xs font-bold text-muted-foreground">KG</span>
            </span>
          </div>
        </div>

        <FactoryMobileActionBar className="min-[360px]:grid-cols-1">
          <Button
            className="min-h-12 w-full gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-600 sm:min-h-11"
            disabled={totalQty === 0 || !selectedLocationId || isPending}
            onClick={onConfirm}
            data-testid="button-confirm-stock-entry"
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Processing…
              </>
            ) : (
              <>
                <CheckCircle className="h-4 w-4" /> Confirm & Print Labels{totalQty > 0 && ` (${totalQty})`}
              </>
            )}
          </Button>
        </FactoryMobileActionBar>
      </div>
    </aside>
  );
}
