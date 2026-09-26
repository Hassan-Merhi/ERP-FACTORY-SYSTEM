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
    <div className="flex flex-wrap items-center gap-3 py-2.5 border-b bg-muted/10 shrink-0 sm:px-6 max-sm:grid max-sm:grid-cols-2 max-sm:gap-2">
      <div className="flex items-center gap-1.5 shrink-0 max-sm:col-span-2">
        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">MOVEMENT</span>
      </div>
      <span className="text-xs text-muted-foreground max-sm:hidden">From</span>
      <div className="relative">
        <Input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="h-8 w-36 text-sm max-sm:w-full"
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
          className="h-8 w-36 text-sm max-sm:w-full"
          aria-label="Movement to"
          data-testid="input-to-date"
        />
      </div>
      {(fromDate || asOfDate) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs gap-1 max-sm:col-span-2"
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
