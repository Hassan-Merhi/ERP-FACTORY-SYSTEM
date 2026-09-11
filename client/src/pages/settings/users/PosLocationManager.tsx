import { Label } from "@/components/ui/label";
import { MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import type { LedgerAccount, Location } from "@shared/schema";

interface PosLocationManagerProps {
  locations: Location[];
  selectedLocationIds: number[];
  setSelectedLocationIds: (v: number[] | ((prev: number[]) => number[])) => void;
  setAssignedLocationId: (v: number | undefined) => void;
  locationCashAccounts: Record<number, number | undefined>;
  setLocationCashAccounts: (
    v:
      | Record<number, number | undefined>
      | ((prev: Record<number, number | undefined>) => Record<number, number | undefined>)
  ) => void;
  posViewOnly: boolean;
  cashAccounts: LedgerAccount[];
}

export function PosLocationManager({
  locations,
  selectedLocationIds,
  setSelectedLocationIds,
  setAssignedLocationId,
  locationCashAccounts,
  setLocationCashAccounts,
  posViewOnly,
  cashAccounts,
}: PosLocationManagerProps) {
  const toggleLocation = (locId: number) => {
    setSelectedLocationIds((prev) => {
      const isRemoving = prev.includes(locId);
      const next = isRemoving ? prev.filter((id) => id !== locId) : [...prev, locId];
      if (next.length > 0) setAssignedLocationId(next[0]);
      if (isRemoving) {
        setLocationCashAccounts((c) => {
          const copy = { ...c };
          delete copy[locId];
          return copy;
        });
      }
      return next;
    });
  };

  const selectAllLocations = () => {
    const all = locations.map((l) => l.id);
    setSelectedLocationIds(all);
    if (all.length > 0) setAssignedLocationId(all[0]);
  };

  const clearLocations = () => {
    setSelectedLocationIds([]);
    setAssignedLocationId(undefined);
    setLocationCashAccounts({});
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          Assigned Locations
          {selectedLocationIds.length > 0 && (
            <Badge variant="secondary" className="text-xs ml-1">
              {selectedLocationIds.length} selected
            </Badge>
          )}
        </Label>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={selectAllLocations}>
            All
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={clearLocations}>
            Clear
          </Button>
        </div>
      </div>
      {locations.length === 0 ? (
        <p className="text-xs text-muted-foreground">No locations for this company.</p>
      ) : (
        <div className="space-y-1 max-h-56 overflow-y-auto rounded-md border p-2" data-testid="select-locations">
          {locations.map((loc) => {
            const checked = selectedLocationIds.includes(loc.id);
            return (
              <div key={loc.id} className="space-y-1">
                <label
                  className={`flex items-center gap-2 cursor-pointer text-xs rounded px-2 py-1 transition-colors ${checked ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50"}`}
                  data-testid={`checkbox-location-${loc.id}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleLocation(loc.id)}
                    className="rounded shrink-0"
                  />
                  <span className="truncate">{loc.name}</span>
                  <span className="text-muted-foreground shrink-0">({loc.code})</span>
                </label>
                {checked && (!posViewOnly || selectedLocationIds[0] === loc.id) && (
                  <div className="pl-6 pr-1 pb-1">
                    <Select
                      value={locationCashAccounts[loc.id]?.toString() || ""}
                      onValueChange={(v) => setLocationCashAccounts((prev) => ({ ...prev, [loc.id]: parseInt(v) }))}
                    >
                      <SelectTrigger className="h-7 text-xs" data-testid={`select-cash-account-loc-${loc.id}`}>
                        <SelectValue placeholder="Select cash account *" />
                      </SelectTrigger>
                      <SelectContent>
                        {cashAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id.toString()}>
                            {a.name} ({a.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!locationCashAccounts[loc.id] && (
                      <p className="text-xs text-destructive mt-0.5">Cash account required</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {selectedLocationIds.length === 0 && (
        <p className="text-xs text-destructive">At least one location required for POS roles.</p>
      )}
    </div>
  );
}
