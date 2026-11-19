// Extracted from ./CountryActivityKPI.tsx
import { useState } from "react";
import { Container, ShoppingCart, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ContainerChargesDialog,
  formatDayShort,
  isToday,
  type ContainerEntry,
  type DayEntry,
  type ImportedContainerEntry,
} from "./CountryActivityKPIContainerChargesDialog";

export const WINDOW_DAYS = 1;

// ── Container tags shown inline under an offload cell ─────────────────────────
function ContainerTags({ containers }: { containers: ContainerEntry[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  if (!containers || containers.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-0.5 mt-1 items-center">
        {containers.map((c) => (
          <div key={c.id} className="flex flex-col items-center gap-0">
            <button
              className="inline-flex items-center gap-1 text-[11px] bg-primary/10 text-primary rounded-sm px-1.5 py-0.5 whitespace-nowrap hover:bg-primary/20 transition-colors cursor-pointer"
              data-testid={`tag-container-${c.id}`}
              onClick={() => setSelectedId(c.id)}
              title="Click to view offload charges"
            >
              <Container className="h-2.5 w-2.5 shrink-0" />
              <span className="font-mono font-medium">{c.containerNumber || "—"}</span>
              {c.supplierCode && (
                <>
                  <span className="text-primary/50">·</span>
                  <span className="truncate max-w-[100px]">{c.supplierCode}</span>
                </>
              )}
            </button>
            {c.locationName && (
              <span className="inline-flex items-center gap-0.5 text-[11px] bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 whitespace-nowrap mt-0.5">
                <MapPin className="h-2.5 w-2.5 shrink-0" />
                {c.locationName}
              </span>
            )}
          </div>
        ))}
      </div>

      <ContainerChargesDialog containerId={selectedId} open={selectedId !== null} onClose={() => setSelectedId(null)} />
    </>
  );
}

// ── Imported container tags shown under a POs Imported cell ───────────────────
function ImportedContainerTags({ containers }: { containers: ImportedContainerEntry[] }) {
  if (!containers || containers.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 mt-1 items-center">
      {containers.map((c) => (
        <div key={c.id} className="flex flex-col items-center gap-0">
          <span
            className="inline-flex items-center gap-1 text-[11px] bg-primary/10 text-primary rounded-sm px-1.5 py-0.5 whitespace-nowrap"
            data-testid={`tag-imported-${c.id}`}
          >
            <Container className="h-2.5 w-2.5 shrink-0" />
            <span className="font-mono font-medium">{c.containerNumber || "—"}</span>
            {c.supplierCode && (
              <>
                <span className="text-primary/50">·</span>
                <span className="truncate max-w-[100px]">{c.supplierCode}</span>
              </>
            )}
          </span>
          {c.shopName && (
            <span className="inline-flex items-center gap-0.5 text-[11px] bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 whitespace-nowrap mt-0.5">
              <MapPin className="h-2.5 w-2.5 shrink-0" />
              {c.shopName}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Day grid for one company ──────────────────────────────────────────────────
export function CompanyDayGrid({ days }: { days: DayEntry[] }) {
  const active = days.filter((d) => d.offloads > 0 || d.purchases > 0);

  if (active.length === 0) {
    return <p className="text-xs text-muted-foreground py-2 pl-1">No activity in this period.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs min-w-[360px]">
        <thead>
          <tr className="text-muted-foreground border-b">
            <th className="text-left font-medium py-1.5 pr-4 w-28">Date</th>
            <th className="text-center font-medium py-1.5 px-3">
              <span className="flex items-center justify-center gap-1">
                <Container className="h-3 w-3" /> Offloaded
              </span>
            </th>
            <th className="text-center font-medium py-1.5 px-3">
              <span className="flex items-center justify-center gap-1">
                <ShoppingCart className="h-3 w-3" /> POs Imported
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {active.map((d) => (
            <tr
              key={d.date}
              className={cn("border-b last:border-0", isToday(d.date) && "bg-primary/5")}
              data-testid={`row-activity-day-${d.date}`}
            >
              <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap align-top">
                {formatDayShort(d.date)}
                {isToday(d.date) && <span className="ml-1 text-primary font-semibold">·</span>}
              </td>
              <td className="py-2 px-3 text-center align-top">
                {d.offloads > 0 ? (
                  <div>
                    <span className="font-semibold text-foreground">{d.offloads}</span>
                    <ContainerTags containers={d.containers ?? []} />
                  </div>
                ) : (
                  <span className="text-muted-foreground/50">—</span>
                )}
              </td>
              <td className="py-2 px-3 text-center align-top">
                {d.purchases > 0 ? (
                  <div>
                    <span className="font-semibold text-foreground">{d.purchases}</span>
                    <ImportedContainerTags containers={d.importedContainers ?? []} />
                  </div>
                ) : (
                  <span className="text-muted-foreground/50">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
