import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { safeNumber } from "./TicketAdminDashboardHelpers";
import { useTicketAdminDashboardState } from "./useTicketAdminDashboardState";
import { TicketAdminDashboardContent } from "./TicketAdminDashboardContent";

export default function TicketAdminDashboard({
  onBack,
  onOpenTicket,
  canExport,
}: {
  onBack: () => void;
  onOpenTicket: (ticketId: number) => void;
  canExport: boolean;
}) {
  const { filters, setFilters, setApplied, exportError, employees, report, submit, set, download, s, cards } =
    useTicketAdminDashboardState();
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
      <TicketAdminDashboardContent
        employees={employees}
        filters={filters}
        set={set}
        setApplied={setApplied}
        setFilters={setFilters}
        submit={submit}
      />
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
