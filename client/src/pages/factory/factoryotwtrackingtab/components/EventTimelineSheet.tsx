/**
 * EventTimelineSheet — extracted sub-component.
 *
 * Extracted from FactoryOtwTrackingTab.tsx during the Phase 4 god-file split.
 */
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MapPin, Activity } from "lucide-react";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { TrackingEvent } from "../types";

export function EventTimelineSheet({
  containerId,
  containerNumber,
  open,
  onClose,
}: {
  containerId: number | null;
  containerNumber: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data: events = [], isLoading } = useQuery<TrackingEvent[]>({
    queryKey: ["/api/factory/container-tracking", containerId, "events"],
    queryFn: async () => {
      if (!containerId) return [];
      const res = await factoryApiRequest("GET", `/api/factory/container-tracking/${containerId}/events`);
      return res.ok ? (res.json() as Promise<TrackingEvent[]>) : [];
    },
    enabled: open && !!containerId,
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b shrink-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Event History
            <span className="font-mono text-muted-foreground font-normal text-sm">{containerNumber}</span>
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="px-6 py-4">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex gap-3 items-start">
                    <div className="h-4 w-4 rounded-full bg-muted animate-pulse shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 bg-muted rounded-sm w-3/4 animate-pulse" />
                      <div className="h-3 bg-muted rounded-sm w-1/2 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            ) : events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <Activity className="h-10 w-10 opacity-20" />
                <p className="text-sm">No tracking events yet.</p>
                <p className="text-xs">Click the refresh icon on the row to fetch live data.</p>
              </div>
            ) : (
              <ol className="relative border-l border-border ml-2 space-y-0">
                {events.map((ev, idx) => {
                  const dt = ev.eventTime ? new Date(ev.eventTime) : null;
                  return (
                    <li key={ev.id} className="ml-4 pb-6 last:pb-0">
                      <span className="absolute -left-1.5 flex h-3 w-3 items-center justify-center rounded-full border bg-background ring-2 ring-background">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${idx === 0 ? "bg-blue-500" : "bg-muted-foreground/40"}`}
                        />
                      </span>
                      <div className="flex flex-col gap-0.5">
                        <p className="text-sm font-medium leading-snug">{ev.description ?? ev.status ?? "—"}</p>
                        {ev.location && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3 shrink-0" />
                            {ev.location}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground/70 mt-0.5">
                          {dt
                            ? `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                            : "—"}
                          {ev.provider && <span className="ml-2 opacity-60">via {ev.provider}</span>}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ── Tracking Settings Sheet ──────────────────────────────────────────────────
