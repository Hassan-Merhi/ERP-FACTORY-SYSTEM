import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin, Search, FileSpreadsheet, Pencil, ChevronRight } from "lucide-react";
import { RenameLocationDialog } from "./factory-location-inventory/dialogs/RenameLocationDialog";
import type { useFactoryLocationInventory } from "./FactoryLocationInventoryModel";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

export function FactoryLocationInventoryLocationView({ inventory }: { inventory: FactoryLocationInventoryModel }) {
  const {
    filteredLocations,
    handleLocationClick,
    hideAvgCost,
    hideSellingPrice,
    locationSearch,
    locations,
    locationsLoading,
    openRenameDialog,
    renameDialogOpen,
    renameInput,
    renameLocationMutation,
    renamingLocation,
    setLocationSearch,
    setRenameDialogOpen,
    setRenameInput,
  } = inventory;
  return (
    <div className="p-4 md:p-6 w-full space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Location Inventory</h1>
          <p className="text-sm text-muted-foreground mt-1">Physical bales on ground by location</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const p = new URLSearchParams();
              if (hideAvgCost) p.set("includeCost", "0");
              if (hideSellingPrice) p.set("includeSellPrice", "0");
              const qs = p.toString();
              window.open(`/api/factory/location-inventory/export/all${qs ? "?" + qs : ""}`, "_blank");
            }}
            data-testid="button-export-all-locations"
          >
            <FileSpreadsheet className="h-4 w-4 mr-1.5" /> Export All (Excel)
          </Button>
        </div>
      </div>

      {/* Location selector */}
      <div className="rounded-2xl border bg-card/30 overflow-hidden">
        <div className="border-b px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            Select Location
          </div>
        </div>
        <div className="border-b px-4 py-4 sm:px-5">
          <div>
            <div className="text-lg font-semibold tracking-tight">Location Inventory</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {locations.length} location{locations.length !== 1 ? "s" : ""} available
            </p>
          </div>
          <div className="relative mt-4 w-full sm:max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search locations..."
              value={locationSearch}
              onChange={(e) => setLocationSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
              data-testid="input-search-locations"
            />
          </div>
        </div>
        <div className="p-4 sm:p-5">
          {locationsLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : locations.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
              No locations found.
            </div>
          ) : filteredLocations.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm">No locations match your search.</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredLocations.map((location) => (
                <div
                  key={location.id}
                  className="group relative flex min-h-[82px] cursor-pointer items-center gap-3 rounded-xl border bg-background px-3.5 py-3 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/2 hover:shadow-md"
                  onClick={() => handleLocationClick(location)}
                  data-testid={`row-location-${location.id}`}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <MapPin className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold leading-snug">{location.name}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Tap to view inventory</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground opacity-70 hover:text-foreground"
                    onClick={(e) => openRenameDialog(location, e)}
                    data-testid={`button-rename-location-${location.id}`}
                    title="Rename location"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </div>
              ))}
            </div>
          )}

          {!locationsLoading && filteredLocations.length > 0 && (
            <div className="mt-3 text-xs text-muted-foreground">
              {filteredLocations.length} of {locations.length} location{locations.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      <RenameLocationDialog
        renameDialogOpen={renameDialogOpen}
        renameInput={renameInput}
        renameLocationMutation={renameLocationMutation}
        renamingLocation={renamingLocation}
        setRenameDialogOpen={setRenameDialogOpen}
        setRenameInput={setRenameInput}
      />
    </div>
  );
}
