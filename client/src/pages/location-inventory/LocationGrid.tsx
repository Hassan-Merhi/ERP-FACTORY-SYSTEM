import { Warehouse, Pencil, MessageCircle, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { InventoryLocation as Location } from "./locationInventoryTypes";
import type { AuthMe } from "@shared/apiTypes";

interface LocationGridProps {
  locations: Location[];
  locationsLoading: boolean;
  selectedLocationLocal: Location | null;
  setSelectedLocationLocal: (loc: Location | null) => void;
  locationSearchTerm: string;
  setLocationSearchTerm: (s: string) => void;
  posUser?: AuthMe;
  canManageWhatsapp?: boolean;
  openRenameDialog?: (loc: Location, e?: { stopPropagation: () => void }) => void;
  openWaGroupDialog?: (loc: Location, e?: { stopPropagation: () => void }) => void;
}

export function LocationGrid({
  locations,
  locationsLoading,
  selectedLocationLocal,
  setSelectedLocationLocal,
  locationSearchTerm,
  setLocationSearchTerm,
  posUser,
  canManageWhatsapp = false,
  openRenameDialog,
  openWaGroupDialog,
}: LocationGridProps) {
  const filteredLocations = locations.filter((loc) => {
    if (!locationSearchTerm) return true;
    const s = locationSearchTerm.toLowerCase();
    return loc.name.toLowerCase().includes(s) || (loc.code && loc.code.toLowerCase().includes(s));
  });

  if (selectedLocationLocal) return null;

  return (
    <div className="overflow-hidden rounded-2xl border bg-card/40 shadow-sm">
      <div className="flex flex-col gap-3 border-b bg-muted/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Warehouse className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">Your locations</p>
            <p className="text-xs text-muted-foreground">
              {filteredLocations.length} of {locations.length} location{locations.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 bg-background pl-9 text-sm"
            placeholder="Search locations..."
            value={locationSearchTerm}
            onChange={(e) => setLocationSearchTerm(e.target.value)}
            data-testid="input-location-search"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {locationsLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border bg-muted/30" />
          ))
        ) : filteredLocations.length === 0 ? (
          <div className="col-span-full rounded-xl border-2 border-dashed py-14 text-center text-sm text-muted-foreground">
            {locationSearchTerm ? "No locations match your search." : "No locations found."}
          </div>
        ) : (
          filteredLocations.map((loc) => (
            <div
              key={loc.id}
              onClick={() => setSelectedLocationLocal(loc)}
              className="group flex min-h-[124px] cursor-pointer flex-col justify-between rounded-xl border bg-background p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/[0.02] hover:shadow-md"
              data-testid={`card-location-${loc.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                    <Warehouse className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{loc.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Inventory location</p>
                  </div>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              </div>
              <div className="flex items-center justify-between gap-2 border-t pt-3">
                <span className="text-xs font-medium text-primary/80">Open inventory</span>
                <div className="flex items-center gap-1">
                  {!posUser && openRenameDialog && (
                    <button
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        openRenameDialog(loc, e);
                      }}
                      data-testid={`button-rename-${loc.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {!posUser && canManageWhatsapp && openWaGroupDialog && (
                    <button
                      className={`rounded-md p-1.5 hover:bg-muted ${
                        loc.whatsappGroupChatId && loc.whatsappStockReportsEnabled
                          ? "text-green-500 hover:text-green-600"
                          : loc.whatsappGroupChatId
                            ? "text-amber-500 hover:text-amber-600"
                            : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openWaGroupDialog(loc, e);
                      }}
                      title={
                        loc.whatsappGroupChatId && loc.whatsappStockReportsEnabled
                          ? `WhatsApp stock reports enabled${loc.whatsappGroupName ? `: ${loc.whatsappGroupName}` : ""}`
                          : loc.whatsappGroupChatId
                            ? `WhatsApp group linked but stock reports disabled${loc.whatsappGroupName ? `: ${loc.whatsappGroupName}` : ""}`
                            : "Link WhatsApp group for stock reports"
                      }
                      aria-label={`Configure WhatsApp stock reports for ${loc.name}`}
                      data-testid={`button-wa-${loc.id}`}
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
