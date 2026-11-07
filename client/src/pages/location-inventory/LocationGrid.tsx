import { useState } from "react";
import { searchAny } from "@shared/searchNormalization";
import { Warehouse, Pencil, MessageCircle, ChevronRight, Search, ArrowUpRight, LayoutGrid, List } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { WarehouseScene } from "./WarehouseScene";
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
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const filteredLocations = locations.filter((loc) => {
    if (!locationSearchTerm) return true;
    return searchAny(locationSearchTerm, loc.name, loc.code);
  });

  if (selectedLocationLocal) return null;

  return (
    <section className="overflow-hidden rounded-[24px] border border-violet-200/65 bg-white/95 shadow-[0_12px_38px_-24px_rgba(63,34,127,.24)] dark:border-violet-400/20 dark:bg-[#101329]/95 dark:shadow-[0_25px_70px_-40px_rgba(138,73,255,.45)]">
      <div className="relative flex flex-col gap-4 overflow-hidden border-b border-violet-200/60 bg-gradient-to-r from-violet-50 via-white to-indigo-50/70 px-4 py-4 dark:border-violet-400/15 dark:from-[#27204b] dark:via-[#191b3a] dark:to-[#10162e] sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="pointer-events-none absolute -left-8 -top-12 h-32 w-44 rounded-full bg-fuchsia-300/15 blur-3xl dark:bg-fuchsia-500/25" aria-hidden="true" />
        <div className="relative flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-200/80 bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700 shadow-sm dark:border-violet-300/20 dark:from-violet-600 dark:to-fuchsia-700 dark:text-white dark:shadow-[0_3px_16px_rgba(147,51,234,.3)]">
            <Warehouse className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-tight sm:text-base">Your locations</h3>
            <p className="text-xs text-muted-foreground">
              {locationsLoading ? "Loading locations..." : `${filteredLocations.length} of ${locations.length} location${locations.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
        <div className="relative flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-72 lg:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-500 dark:text-violet-300" />
            <Input
              className="h-10 rounded-xl border-violet-200/90 bg-white/90 pl-9 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:ring-violet-500 dark:border-violet-300/25 dark:bg-[#11152b]/80"
              placeholder="Search locations..."
              aria-label="Search inventory locations"
              value={locationSearchTerm}
              onChange={(e) => setLocationSearchTerm(e.target.value)}
              data-testid="input-location-search"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-xl border border-violet-200/80 bg-white/80 p-1 shadow-sm dark:border-violet-300/20 dark:bg-[#14152e]">
            <button
              type="button"
              onClick={() => setLayout("grid")}
              title="Grid view"
              aria-label="Grid view"
              aria-pressed={layout === "grid"}
              className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-violet-500", layout === "grid" ? "bg-violet-600 text-white shadow-md dark:bg-gradient-to-br dark:from-violet-600 dark:to-fuchsia-600" : "text-muted-foreground hover:bg-violet-100 dark:hover:bg-violet-500/20")}
              data-testid="button-locations-grid-view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setLayout("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={layout === "list"}
              className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-violet-500", layout === "list" ? "bg-violet-600 text-white shadow-md dark:bg-gradient-to-br dark:from-violet-600 dark:to-fuchsia-600" : "text-muted-foreground hover:bg-violet-100 dark:hover:bg-violet-500/20")}
              data-testid="button-locations-list-view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className={cn("grid gap-3 p-3 sm:gap-4 sm:p-4", layout === "grid" ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1")}>
        {locationsLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[124px] animate-pulse rounded-2xl border border-violet-200/60 bg-violet-50/70 dark:border-violet-400/15 dark:bg-violet-300/5" />
          ))
        ) : filteredLocations.length === 0 ? (
          <div className="col-span-full rounded-2xl border-2 border-dashed border-violet-200/90 bg-violet-50/35 py-14 text-center text-sm text-muted-foreground dark:border-violet-400/15 dark:bg-violet-400/5">
            {locationSearchTerm ? "No locations match your search." : "No locations found."}
          </div>
        ) : (
          filteredLocations.map((loc) => (
            <div
              key={loc.id}
              role="button"
              tabIndex={0}
              aria-label={`Open inventory for ${loc.name}`}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  setSelectedLocationLocal(loc);
                }
              }}
              onClick={() => setSelectedLocationLocal(loc)}
              className={cn(
                "group relative isolate flex min-h-[122px] cursor-pointer flex-col justify-between overflow-hidden rounded-[18px] border border-violet-200/90 bg-gradient-to-br from-white via-violet-50/55 to-indigo-100/60 p-4 shadow-[0_7px_18px_-15px_rgba(81,45,153,.7)] transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-400/65 hover:shadow-[0_14px_30px_-16px_rgba(112,66,206,.4)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 dark:border-violet-300/20 dark:from-[#212445] dark:via-[#191d38] dark:to-[#14152b] dark:shadow-[0_10px_25px_-19px_rgba(161,103,255,.4)] dark:hover:border-violet-400/65 dark:hover:shadow-[0_14px_30px_-15px_rgba(147,51,234,.5)]",
                layout === "list" && "sm:min-h-[98px]"
              )}
              data-testid={`card-location-${loc.id}`}
            >
              <div className="pointer-events-none absolute inset-y-0 right-0 w-[66%] opacity-[.12] transition-opacity group-hover:opacity-[.2] dark:opacity-[.42] dark:group-hover:opacity-[.6]" aria-hidden="true">
                <WarehouseScene compact />
              </div>
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/90 via-white/40 to-transparent dark:from-[#181a34]/90 dark:via-[#181a34]/30 dark:to-transparent" aria-hidden="true" />
              <div className="relative flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] border border-violet-200/75 bg-gradient-to-br from-violet-100 via-purple-100 to-fuchsia-100 text-violet-700 shadow-sm dark:border-violet-300/25 dark:from-violet-500/80 dark:via-violet-700 dark:to-fuchsia-800 dark:text-violet-50 dark:shadow-[0_3px_17px_rgba(136,65,241,.24)]">
                    <Warehouse className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold tracking-tight sm:text-base">{loc.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Inventory location</p>
                  </div>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-violet-600 transition-transform group-hover:translate-x-1 dark:text-violet-200" />
              </div>
              <div className="relative mt-3 flex items-center justify-between gap-2 border-t border-violet-200/80 pt-2.5 dark:border-violet-300/15">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200/70 bg-violet-100/95 px-3 py-1 text-xs font-semibold text-violet-800 transition-colors group-hover:bg-violet-200 dark:border-violet-400/20 dark:bg-violet-600/35 dark:text-violet-100 dark:group-hover:bg-violet-600/55">
                  Open Inventory <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
                <div className="flex items-center gap-1">
                  {!posUser && openRenameDialog && (
                    <button
                      type="button"
                      className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-violet-200/70 hover:text-violet-700 focus-visible:outline-2 focus-visible:outline-violet-500 dark:hover:bg-violet-500/20 dark:hover:text-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        openRenameDialog(loc, e);
                      }}
                      title={`Edit ${loc.name}`}
                      aria-label={`Edit ${loc.name}`}
                      data-testid={`button-rename-${loc.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  {!posUser && canManageWhatsapp && openWaGroupDialog && (
                    <button
                      type="button"
                      className={cn(
                        "rounded-lg p-2 transition-colors focus-visible:outline-2 focus-visible:outline-violet-500 hover:bg-violet-200/70 dark:hover:bg-violet-500/20",
                        loc.whatsappGroupChatId && loc.whatsappStockReportsEnabled
                          ? "text-emerald-600 dark:text-emerald-400"
                          : loc.whatsappGroupChatId
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground"
                      )}
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
                      <MessageCircle className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
