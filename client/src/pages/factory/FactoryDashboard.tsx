import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Trash2,
  Package,
  Users,
  ChevronDown,
  ChevronUp,
  Ship,
  TrendingUp,
  TrendingDown,
  Boxes,
  CalendarCheck,
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { FactoryKpiCard } from "@/components/FactoryKpiCard";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { StatusBadge } from "@/components/StatusBadge";

interface DashboardData {
  waste: { totalKg: number; breakdown: Array<{ wasteType: string; kg: number }> };
  workers: { active: number; attendanceToday: number };
  containers: { loaded: number };
}

interface KpiData {
  openingStockKg: string;
  closingStockKg: string;
  balesPressedToday: number;
  kgsUsedToday: string;
  totalBaleWeightToday: string;
  categories: Array<{ name: string; count: number; totalKg: number }>;
  balesDetail: Array<{
    id: number;
    baleCode: string;
    productName: string;
    category: string;
    weightKg: string;
    pressedAt: string;
    status: string;
    quantity: number;
  }>;
}

interface Container {
  id: number;
  containerNumber: string;
  supplierName: string | null;
  status: string;
  totalKg: string;
  actualReceivedKg: string | null;
  arrivalDate: string | null;
  origin: string | null;
}

const STATUS_ORDER = ["PENDING", "IN_TRANSIT", "ARRIVED", "OFFLOADED", "PARTIALLY_RECEIVED", "RECEIVED"];
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  IN_TRANSIT: "Pending",
  ARRIVED: "Pending",
  OFFLOADED: "Offloaded",
  PARTIALLY_RECEIVED: "Pending",
  RECEIVED: "Pending",
};
const STATUS_ACTIVE = new Set(["PENDING", "IN_TRANSIT", "ARRIVED", "RECEIVED"]);

const WASTE_TYPE_LABEL: Record<string, string> = {
  GARBAGE: "Garbage",
  WIPERS: "Wipers",
  OTHER: "Other",
};

function fmt(n: number | string, decimals = 0) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v)
    ? "0"
    : v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function CollapsiblePane({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: open ? undefined : "none" }} className="border-t mt-3 pt-3">
      {children}
    </div>
  );
}

export default function FactoryDashboard() {
  const today = new Date().toLocaleDateString("en-CA");
  const [date, setDate] = useState(today);
  const [showBalesPane, setShowBalesPane] = useState(false);

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/factory/dashboard", date],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dashboard?date=${date}`);
      if (!res.ok) throw new Error("Failed to load dashboard");
      return res.json();
    },
  });

  const { data: kpis } = useQuery<KpiData>({
    queryKey: ["/api/factory/dashboard-kpis"],
  });

  const { data: containers } = useQuery<Container[]>({
    queryKey: ["/api/factory/containers"],
  });

  const containersOtw = (containers || [])
    .filter((c) => STATUS_ACTIVE.has(c.status))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  const wasteHint = (data?.waste?.breakdown ?? [])
    .map((b) => `${WASTE_TYPE_LABEL[b.wasteType] ?? b.wasteType}: ${fmt(b.kg, 1)} kg`)
    .join(" · ");

  return (
    <div>
      <PageHeader title="Factory Dashboard" subtitle="Production overview and operations">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
            data-testid="input-date"
          />
        </div>
      </PageHeader>

      {isLoading ? (
        <LoadingSkeleton variant="kpi-grid" rows={4} />
      ) : (
        <div className="space-y-6">
          {/* KPI grid — unified factory grammar */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FactoryKpiCard
              metric="scrap"
              icon={Trash2}
              title="Waste"
              value={`${fmt(data?.waste?.totalKg ?? 0, 1)} kg`}
              hint={wasteHint || undefined}
              data-testid="card-stat-waste"
            />
            <FactoryKpiCard
              metric="output"
              icon={Package}
              title="Loaded Containers"
              value={data?.containers?.loaded ?? 0}
              hint="customer containers finalized"
              data-testid="card-stat-loaded-containers"
            />
            <FactoryKpiCard
              metric="neutral"
              icon={Users}
              title="Active Workers"
              value={data?.workers?.active ?? 0}
              data-testid="card-stat-active-workers"
            />
            <FactoryKpiCard
              metric="input"
              icon={CalendarCheck}
              title="Attendance Today"
              value={data?.workers?.attendanceToday ?? 0}
              hint="workers present"
              data-testid="card-stat-attendance"
            />
          </div>

          {/* Container OTW */}
          <SectionCard
            icon={Ship}
            title="Container OTW"
            actions={<Badge variant="outline">{containersOtw.length} active</Badge>}
            data-testid="section-container-otw"
          >
            {containersOtw.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No containers currently in transit or pending
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table mobileLayout="cards" data-testid="dashboard-containers-otw-table">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Origin</TableHead>
                      <TableHead className="text-right">KG</TableHead>
                      <TableHead>Arrival</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {containersOtw.map((c) => (
                      <TableRow key={c.id} data-testid={`row-container-otw-${c.id}`}>
                        <TableCell className="font-mono text-sm font-medium">{c.containerNumber}</TableCell>
                        <TableCell className="text-sm">{c.supplierName || "—"}</TableCell>
                        <TableCell>
                          <StatusBadge status={c.status.toLowerCase()} label={STATUS_LABEL[c.status] || c.status} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{c.origin || "—"}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmt(c.totalKg, 0)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{c.arrivalDate || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>

          {/* Total Bales Pressed */}
          <SectionCard
            icon={Boxes}
            title="Total Bales Pressed"
            description={`${kpis?.balesPressedToday ?? 0} bales · ${fmt(kpis?.totalBaleWeightToday ?? 0, 1)} kg total`}
            actions={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowBalesPane((v) => !v)}
                data-testid="button-toggle-bales-pane"
                aria-label={showBalesPane ? "Hide bale details" : "Show bale details"}
              >
                {showBalesPane ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </Button>
            }
            data-testid="section-bales-pressed"
          >
            <div className="text-3xl font-semibold tabular-nums" data-testid="text-total-bales-pressed">
              {kpis?.balesPressedToday ?? 0}
            </div>
            <CollapsiblePane open={showBalesPane}>
              {!kpis?.balesDetail || kpis.balesDetail.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bales pressed today</p>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  <Table mobileLayout="cards" data-testid="dashboard-recent-production-table">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Bales</TableHead>
                        <TableHead className="text-right">KG</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kpis.balesDetail.map((b, i) => (
                        <TableRow key={b.id ?? i} data-testid={`row-bale-${b.id ?? i}`}>
                          <TableCell className="text-sm text-muted-foreground" data-mobile-cell="field">
                            {b.category || "—"}
                          </TableCell>
                          <TableCell className="text-sm">{b.productName || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{b.quantity ?? 1}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmt(b.weightKg, 2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CollapsiblePane>
          </SectionCard>

          {/* Stock Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FactoryKpiCard
              metric="input"
              icon={TrendingUp}
              title="Opening Stock"
              value={`${fmt(kpis?.openingStockKg ?? 0, 1)} kg`}
              data-testid="card-stat-opening-stock"
            />
            <FactoryKpiCard
              metric="output"
              icon={TrendingDown}
              title="Closing Stock"
              value={`${fmt(kpis?.closingStockKg ?? 0, 1)} kg`}
              data-testid="card-stat-closing-stock"
            />
          </div>
        </div>
      )}
    </div>
  );
}
