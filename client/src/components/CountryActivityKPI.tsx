import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Container,
  ShoppingCart,
  Globe,
  Loader2,
  MapPin,
  Receipt,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const WINDOW_DAYS = 1;

interface ContainerEntry {
  id: number;
  containerNumber: string;
  supplierCode: string | null;
  locationName: string | null;
}

interface ImportedContainerEntry {
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

interface DayEntry {
  date: string;
  offloads: number;
  purchases: number;
  locations: LocationCount[];
  containers: ContainerEntry[];
  importedContainers: ImportedContainerEntry[];
}

interface CompanyActivity {
  id: number;
  name: string;
  code: string;
  totalOffloads: number;
  totalPurchases: number;
  days: DayEntry[];
}

interface ActivityResponse {
  companies: CompanyActivity[];
  days: number;
  startDate: string;
  endDate: string;
  dateSeries: string[];
}

function toDateStr(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatRange(startStr: string, endStr: string) {
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

function formatDayShort(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isToday(dateStr: string) {
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

function ContainerChargesDialog({
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
              className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded px-1.5 py-0.5 whitespace-nowrap hover:bg-primary/20 transition-colors cursor-pointer"
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
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5 whitespace-nowrap mt-0.5">
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
            className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded px-1.5 py-0.5 whitespace-nowrap"
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
            <span className="inline-flex items-center gap-0.5 text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5 whitespace-nowrap mt-0.5">
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
function CompanyDayGrid({ days }: { days: DayEntry[] }) {
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

// ── Single company row ────────────────────────────────────────────────────────
function CompanyRow({ company }: { company: CompanyActivity }) {
  const [expanded, setExpanded] = useState(false);
  const hasActivity = company.totalOffloads > 0 || company.totalPurchases > 0;

  return (
    <div className="border-b last:border-0">
      <button
        className={cn(
          "w-full flex items-center gap-3 py-2.5 px-3 text-sm text-left transition-colors",
          "hover-elevate rounded-md",
          !hasActivity && "opacity-60"
        )}
        onClick={() => setExpanded((v) => !v)}
        data-testid={`button-country-expand-${company.id}`}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}

        <span className="font-medium flex-1 truncate">{company.name}</span>

        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary" className="gap-1 text-xs font-mono" data-testid={`badge-offloads-${company.id}`}>
            <Container className="h-2.5 w-2.5" />
            {company.totalOffloads}
          </Badge>
          <Badge variant="secondary" className="gap-1 text-xs font-mono" data-testid={`badge-purchases-${company.id}`}>
            <ShoppingCart className="h-2.5 w-2.5" />
            {company.totalPurchases}
          </Badge>
        </div>
      </button>

      {expanded && (
        <div className="pl-8 pr-3 pb-3">
          <CompanyDayGrid days={company.days} />
        </div>
      )}
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────
export function CountryActivityKPI() {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // offset is in days (1 = move back 1 day), not weeks
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const endDate = useMemo(() => addDays(today, -offset), [today, offset]);
  const startDate = useMemo(() => addDays(endDate, -(WINDOW_DAYS - 1)), [endDate]);
  const endStr = toDateStr(endDate);
  const startStr = toDateStr(startDate);

  const canGoForward = offset > 0;

  const { data, isLoading, isError } = useQuery<ActivityResponse>({
    queryKey: ["/api/stats/country-activity", startStr, endStr],
    queryFn: async () => {
      const res = await fetch(`/api/stats/country-activity?startDate=${startStr}&endDate=${endStr}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 1,
  });

  const summary = useMemo(() => {
    if (!data) return { totalOffloads: 0, totalPurchases: 0 };
    return data.companies.reduce(
      (acc, c) => ({
        totalOffloads: acc.totalOffloads + c.totalOffloads,
        totalPurchases: acc.totalPurchases + c.totalPurchases,
      }),
      { totalOffloads: 0, totalPurchases: 0 }
    );
  }, [data]);

  return (
    <Card className="overflow-hidden">
      {/* Header row — always visible. The expand toggle and the day navigator are siblings,
          so no button sits inside another interactive control. */}
      <div className="w-full flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex flex-1 min-w-0 items-center gap-2 rounded-md text-left hover-elevate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((v) => !v)}
          data-testid="button-country-activity-expand"
        >
          <span className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <Globe className="h-4 w-4 text-primary" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-none">Activity by Company</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Offloaded containers &amp; imports per day
            </span>
          </span>

          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </button>

        {/* KPI badges */}
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1 text-xs" data-testid="badge-total-offloads">
              <Container className="h-3 w-3" />
              {summary.totalOffloads} offloaded
            </Badge>
            <Badge variant="secondary" className="gap-1 text-xs" data-testid="badge-total-purchases">
              <ShoppingCart className="h-3 w-3" />
              {summary.totalPurchases} imported
            </Badge>
          </div>
        )}

        {/* Date navigator — moves 1 day at a time */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setOffset((o) => o + 1)}
            data-testid="button-activity-prev"
            title="Previous day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[120px] text-center select-none">
            {formatRange(startStr, endStr)}
          </span>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setOffset((o) => Math.max(0, o - 1))}
            disabled={!canGoForward}
            data-testid="button-activity-next"
            title="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Expandable body */}
      {expanded && (
        <div className="border-t">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <p className="text-sm text-destructive text-center py-8">Failed to load activity data — please refresh.</p>
          ) : !data || data.companies.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No ERP companies found.</p>
          ) : (
            <div className="px-2 py-1">
              {data.companies.map((c) => (
                <CompanyRow key={c.id} company={c} />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
