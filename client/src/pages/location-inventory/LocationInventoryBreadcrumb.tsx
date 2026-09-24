import { MapPin, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InventoryLocation as Location, StockGroupSummary } from "./locationInventoryTypes";

interface LocationInventoryBreadcrumbProps {
  /** ERP: drop the root-level hint on phones (POS keeps its established layout). */
  compactPhoneRoot?: boolean;
  selectedLocationLocal: Location | null;
  selectedGroup: StockGroupSummary | null;
  viewAllItems: boolean;
  goBackToLocations: () => void;
  onBackToLocation: () => void;
}

export function LocationInventoryBreadcrumb({
  compactPhoneRoot = false,
  selectedLocationLocal,
  selectedGroup,
  viewAllItems,
  goBackToLocations,
  onBackToLocation,
}: LocationInventoryBreadcrumbProps) {
  return (
    // Before a location is chosen the trail is only a hint that repeats the "Locations" heading
    // below it; ERP phones drop it to save a row.
    <div
      className={cn(
        "flex items-center gap-1.5 text-sm text-muted-foreground",
        compactPhoneRoot && !selectedLocationLocal && "max-sm:hidden"
      )}
    >
      <MapPin className="h-3.5 w-3.5 shrink-0" />
      {!selectedLocationLocal ? (
        <span>Select Location</span>
      ) : (
        <>
          <button className="hover:underline hover:text-foreground transition-colors" onClick={goBackToLocations}>
            Locations
          </button>
          <ChevronRight className="h-3.5 w-3.5" />
          {selectedGroup ? (
            <>
              <button className="hover:underline hover:text-foreground transition-colors" onClick={onBackToLocation}>
                {selectedLocationLocal.name}
              </button>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="text-foreground font-medium">{selectedGroup.groupName}</span>
            </>
          ) : viewAllItems ? (
            <>
              <button className="hover:underline hover:text-foreground transition-colors" onClick={onBackToLocation}>
                {selectedLocationLocal.name}
              </button>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="text-foreground font-medium">All Items</span>
            </>
          ) : (
            <span className="text-foreground font-medium">{selectedLocationLocal.name}</span>
          )}
        </>
      )}
    </div>
  );
}
