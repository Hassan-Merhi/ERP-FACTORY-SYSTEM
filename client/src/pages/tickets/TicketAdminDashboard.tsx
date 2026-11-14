import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { Input } from "@/components/ui/input";

type ReportFilters = {
  from: string;
  to: string;
  status: string;
  priority: string;
  sourceMode: string;
  category: string;
  assignedTo: string;
};
type Summary = {
  total: string;
  open: string;
  seen: string;
  working: string;
  reopened: string;
  finalized: string;
  overdue: string;
  urgent: string;
  avg_resolution_hours: string | null;
  resolved_within_24_hours: string;
};
type Group = { label: string; count: string; overdue: string };
type Employee = {
  user_id: string;
  username: string | null;
  count: string;
  finalized: string;
  overdue: string;
  avg_resolution_hours: string | null;
};
type Day = { day: string; created: string; finalized: string };
type OverdueCase = {
  id: number;
  ticket_number: string;
  title: string;
  assigned_to: string;
  username: string | null;
  status: string;
  priority: string;
  due_at: string;
  overdue_hours: string;
};
type Report = {
  summary: Summary;
  byStatus: Group[];
  byCategory: Group[];
  byEmployee: Employee[];
  byCreatedDay: Day[];
  overdueCases: OverdueCase[];
  generatedAt: string;
};
const initial: ReportFilters = {
  from: "",
  to: "",
  status: "",
  priority: "",
  sourceMode: "",
  category: "",
  assignedTo: "",
};
function queryString(filters: ReportFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  return params.toString();
}
function safeNumber(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
export default function TicketAdminDashboard({
  onBack,
  onOpenTicket,
  canExport,
}: {
  onBack: () => void;
  onOpenTicket: (ticketId: number) => void;
  canExport: boolean;
}) {
  const { selectedCompany } = useCompany();
  const [filters, setFilters] = useState<ReportFilters>(initial);
  const [applied, setApplied] = useState<ReportFilters>(initial);
  const [exportError, setExportError] = useState("");
  const employees = useQuery({
    queryKey: ["ticket-dashboard-users", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const res = await fetch("/api/tickets/users", { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error("Unable to load employees");
      return res.json() as Promise<{ users: { id: string; username: string }[] }>;
    },
  });
  const qs = useMemo(() => queryString(applied), [applied]);
  const report = useQuery({
    queryKey: ["ticket-admin-dashboard", selectedCompany?.id, qs],
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const r = await fetch("/api/tickets/dashboard" + (qs ? "?" + qs : ""), {
        credentials: "include",
        cache: "no-store",
      });
      if (r.status === 403) throw new Error("You do not have permission to view company-wide ticket reports.");
      if (!r.ok) throw new Error("Unable to load the ticket dashboard.");
      return r.json() as Promise<Report>;
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ ...filters });
  };
  const set = (key: keyof ReportFilters, value: string) => setFilters((prev) => ({ ...prev, [key]: value }));
  const download = async () => {
    setExportError("");
    try {
      const r = await fetch("/api/tickets/export" + (qs ? "?" + qs : ""), {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) {
        const response = await r.json().catch(() => ({ message: "Unable to export tickets" }));
        throw new Error(response.message || "Unable to export tickets");
      }
      downloadBlob(await r.blob(), exportFileName("ticket report", "csv", { from: applied.from, to: applied.to }));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    }
  };
  const s = report.data?.summary;
  const cards = [
    ["All tickets", s?.total],
    ["Open", s?.open],
    ["Seen", s?.seen],
    ["Working", s?.working],
    ["Reopened", s?.reopened],
    ["Finalized", s?.finalized],
    ["Overdue", s?.overdue],
    ["Urgent unresolved", s?.urgent],
  ];
  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold">Ticket Admin Dashboard</h2>
          <p className="text-sm text-muted-foreground">Company-restricted reporting and follow-up</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onBack}>
            Back to tickets
          </Button>
          {canExport && <ExportButton kind="csv" disabled={!report.data} onClick={download} />}
        </div>
      </header>
      <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1 text-sm">
            Created from (UTC)
            <Input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            Created through (UTC)
            <Input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            Status
            <select
              className="h-10 w-full rounded-md border bg-background px-2"
              value={filters.status}
              onChange={(e) => set("status", e.target.value)}
            >
              <option value="">All statuses</option>
              {["open", "seen", "working", "finalized", "reopened"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Priority
            <select
              className="h-10 w-full rounded-md border bg-background px-2"
              value={filters.priority}
              onChange={(e) => set("priority", e.target.value)}
            >
              <option value="">All priorities</option>
              {["low", "normal", "high", "urgent"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Source
            <select
              className="h-10 w-full rounded-md border bg-background px-2"
              value={filters.sourceMode}
              onChange={(e) => set("sourceMode", e.target.value)}
            >
              <option value="">ERP + Factory</option>
              <option value="erp">ERP</option>
              <option value="factory">Factory</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Issue category
            <Input
              maxLength={80}
              value={filters.category}
              onChange={(e) => set("category", e.target.value)}
              placeholder="Exact category"
            />
          </label>
          <label className="space-y-1 text-sm">
            Assigned employee
            <select
              className="h-10 w-full rounded-md border bg-background px-2"
              value={filters.assignedTo}
              onChange={(e) => set("assignedTo", e.target.value)}
            >
              <option value="">All employees</option>
              {employees.data?.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.username}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setFilters(initial);
              setApplied(initial);
            }}
          >
            Clear
          </Button>
          <Button type="submit">Apply filters</Button>
        </div>
      </form>
      {report.isLoading && (
        <p role="status" className="rounded-lg border p-4">
          Loading dashboard...
        </p>
      )}
      {report.isError && (
        <p role="alert" className="rounded-lg border p-4 text-destructive">
          {(report.error as Error).message}
        </p>
      )}
      {exportError && (
        <p role="alert" className="text-sm text-destructive">
          {exportError}
        </p>
      )}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {cards.map(([label, value]) => (
              <div key={label} className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{safeNumber(value).toLocaleString()}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-sm font-medium">Average resolution time</p>
              <p className="mt-2 text-2xl font-semibold">
                {s.avg_resolution_hours === null ? "—" : safeNumber(s.avg_resolution_hours).toFixed(1) + " hours"}
              </p>
              <p className="text-xs text-muted-foreground">Calculated from finalized cases in the current filter</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-sm font-medium">Finalized by ticket due time</p>
              <p className="mt-2 text-2xl font-semibold">{safeNumber(s.resolved_within_24_hours).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Count of finalized tickets resolved by their due time</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border bg-card p-4">
              <h3 className="font-semibold">Tickets by status</h3>
              <div className="mt-3 space-y-3">
                {report.data?.byStatus.map((row) => (
                  <div key={row.label}>
                    <div className="flex justify-between text-sm">
                      <span>{row.label}</span>
                      <span className="tabular-nums">{row.count}</span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-muted">
                      <div
                        className="h-2 rounded bg-primary"
                        style={{
                          width: `${Math.min(100, (safeNumber(row.count) / Math.max(1, safeNumber(s.total))) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <h3 className="font-semibold">Top issue categories</h3>
              <div className="mt-3 space-y-3">
                {report.data?.byCategory.map((row) => (
                  <div key={row.label}>
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="break-words">{row.label}</span>
                      <span className="shrink-0 tabular-nums">
                        {row.count} · {row.overdue} overdue
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-muted">
                      <div
                        className="h-2 rounded bg-primary"
                        style={{
                          width: `${Math.min(100, (safeNumber(row.count) / Math.max(1, safeNumber(s.total))) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b p-4">
              <h3 className="font-semibold">Oldest overdue tickets</h3>
              <p className="text-xs text-muted-foreground">
                Top 30 unresolved tickets by due date. Open one to review its correction status.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    {["Ticket", "Subject", "Assigned employee", "Status", "Hours overdue", "Open"].map((h) => (
                      <th key={h} scope="col" className="p-3 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.data?.overdueCases.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="p-3 font-medium">{t.ticket_number}</td>
                      <td className="max-w-[260px] break-words p-3">{t.title}</td>
                      <td className="p-3">{t.username ?? t.assigned_to}</td>
                      <td className="p-3">{t.status}</td>
                      <td className="p-3 tabular-nums">{t.overdue_hours}</td>
                      <td className="p-3">
                        <Button size="sm" variant="outline" onClick={() => onOpenTicket(t.id)}>
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.data?.overdueCases.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No overdue tickets match your filters.</p>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b p-4">
              <h3 className="font-semibold">Employee assignment and resolution</h3>
              <p className="text-xs text-muted-foreground">
                Counts reflect assignment, not fault or employee misconduct.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    {["Employee", "Tickets", "Finalized", "Overdue", "Avg. resolution"].map((h) => (
                      <th key={h} scope="col" className="p-3 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.data?.byEmployee.map((e) => (
                    <tr key={e.user_id} className="border-t">
                      <td className="p-3">{e.username ?? e.user_id}</td>
                      <td className="p-3">{e.count}</td>
                      <td className="p-3">{e.finalized}</td>
                      <td className="p-3">{e.overdue}</td>
                      <td className="p-3">{e.avg_resolution_hours === null ? "—" : e.avg_resolution_hours + " h"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.data?.byEmployee.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No employee results for these filters.</p>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b p-4">
              <h3 className="font-semibold">Daily ticket creation (most recent 31 days with activity)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    {["UTC day", "Created", "Currently finalized"].map((h) => (
                      <th key={h} scope="col" className="p-3 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.data?.byCreatedDay.map((d) => (
                    <tr className="border-t" key={d.day}>
                      <td className="p-3">{d.day}</td>
                      <td className="p-3">{d.created}</td>
                      <td className="p-3">{d.finalized}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Last calculated: {report.data?.generatedAt && new Date(report.data.generatedAt).toLocaleString()}. Filters
            apply to ticket creation dates. Results are restricted to your current company.
          </p>
        </>
      )}
    </section>
  );
}
