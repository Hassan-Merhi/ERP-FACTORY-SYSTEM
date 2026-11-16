// Extracted from ./CountryActivityKPI.tsx to keep that module under the source-size cap.
import { useQuery } from "@tanstack/react-query";
import { Loader2, Receipt } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ContainerEntry {
  id: number;
  containerNumber: string;
  supplierCode: string | null;
  locationName: string | null;
}

export interface ImportedContainerEntry {
  id: number;
  containerNumber: string;
  supplierCode: string | null;
  shopName: string | null;
}

interface LocationCount {
  locationId: number;
  locationName: string;
  count: number;
}

export interface DayEntry {
  date: string;
  offloads: number;
  purchases: number;
  locations: LocationCount[];
  containers: ContainerEntry[];
  importedContainers: ImportedContainerEntry[];
}

export interface CompanyActivity {
  id: number;
  name: string;
  code: string;
  totalOffloads: number;
  totalPurchases: number;
  days: DayEntry[];
}

export interface ActivityResponse {
  companies: CompanyActivity[];
  days: number;
  startDate: string;
  endDate: string;
  dateSeries: string[];
}

export function toDateStr(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function formatRange(startStr: string, endStr: string) {
  if (startStr === endStr) {
    const d = new Date(startStr + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  const sameYear = start.getFullYear() === end.getFullYear();
  const fmtStart = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const fmtEnd = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fmtStart} – ${fmtEnd}`;
}

export function formatDayShort(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function isToday(dateStr: string) {
  return dateStr === new Date().toISOString().substring(0, 10);
}

// ── Offload charges dialog ─────────────────────────────────────────────────────
interface OffloadCharge {
  label: string;
  amount: number;
  accountName: string | null;
}

interface OffloadChargesData {
  containerNumber: string;
  offloadedAt: string;
  locationName: string | null;
  charges: OffloadCharge[];
  totalCharges: number;
}

export function ContainerChargesDialog({
  containerId,
  open,
  onClose,
}: {
  containerId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useQuery<OffloadChargesData>({
    queryKey: ["/api/containers", containerId, "offload-charges"],
    queryFn: async () => {
      const res = await fetch(`/api/containers/${containerId}/offload-charges`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: open && containerId !== null,
    staleTime: 60_000,
  });

  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4 text-primary shrink-0" />
            {data ? (
              <span>
                {data.containerNumber}
                {data.locationName && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">→ {data.locationName}</span>
                )}
              </span>
            ) : (
              "Offload Charges"
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive text-center py-4">Could not load offload charges.</p>
        ) : !data || data.charges.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No charges recorded for this offload.</p>
        ) : (
          <div className="space-y-1">
            {data.charges.map((c) => (
              <div key={c.label} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/40">
                <div>
                  <p className="text-sm font-medium">{c.label}</p>
                  {c.accountName && <p className="text-xs text-muted-foreground mt-0.5">{c.accountName}</p>}
                </div>
                <span className="text-sm font-semibold tabular-nums">${fmt(c.amount)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-2 px-3 border-t mt-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total</span>
              <span className="text-sm font-bold tabular-nums">${fmt(data.totalCharges)}</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
