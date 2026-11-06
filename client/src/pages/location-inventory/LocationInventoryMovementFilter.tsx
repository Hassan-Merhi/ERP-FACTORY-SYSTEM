import { ArrowUpDown, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InventoryLocation as Location } from "./locationInventoryTypes";

interface LocationInventoryMovementFilterProps {
  selectedLocationLocal: Location | null;
  viewAllItems: boolean;
  fromDate: string;
  setFromDate: (v: string) => void;
  asOfDate: string;
  setAsOfDate: (v: string) => void;
}

export function LocationInventoryMovementFilter({
  selectedLocationLocal,
  viewAllItems,
  fromDate,
  setFromDate,
  asOfDate,
  setAsOfDate,
}: LocationInventoryMovementFilterProps) {
  if (!selectedLocationLocal || viewAllItems) return null;

  return (
    // Phones: label row, then From | To side by side (the inline labels become field labels).
    <div className="mx-2 mt-2 grid shrink-0 grid-cols-2 items-center gap-2 rounded-2xl border border-violet-200/80 bg-gradient-to-r from-violet-50/80 to-background p-3 shadow-sm dark:border-violet-500/20 dark:from-[#10182f] dark:to-[#0d152b] sm:mx-6 sm:flex sm:flex-wrap sm:gap-3 sm:px-4 sm:py-3">
      <div className="col-span-2 flex shrink-0 items-center gap-2 sm:col-span-1 sm:mr-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300"><ArrowUpDown className="h-4 w-4" /></span>
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">MOVEMENT</span>
      </div>
      <span className="text-xs text-muted-foreground max-sm:hidden">From</span>
      <div className="relative">
        <Input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="h-9 w-full rounded-xl border-violet-200/80 bg-background/90 text-sm shadow-sm dark:border-violet-500/20 dark:bg-slate-950/40 sm:w-40"
          aria-label="Movement from"
          data-testid="input-from-date"
        />
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 max-sm:hidden" />
      <span className="text-xs text-muted-foreground max-sm:hidden">To</span>
      <div className="relative">
        <Input
          type="date"
          value={asOfDate}
          onChange={(e) => setAsOfDate(e.target.value)}
          className="h-9 w-full rounded-xl border-violet-200/80 bg-background/90 text-sm shadow-sm dark:border-violet-500/20 dark:bg-slate-950/40 sm:w-40"
          aria-label="Movement to"
          data-testid="input-to-date"
        />
      </div>
      {(fromDate || asOfDate) && (
        <Button
          variant="ghost"
          size="sm"
          className="col-span-2 h-9 gap-1 rounded-xl px-3 text-xs text-violet-700 hover:bg-violet-500/10 dark:text-violet-300 sm:col-span-1"
          onClick={() => {
            setFromDate("");
            setAsOfDate("");
          }}
        >
          <X className="h-3 w-3" /> Clear
        </Button>
      )}
    </div>
  );
}
