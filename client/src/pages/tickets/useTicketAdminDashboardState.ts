// Extracted from ./TicketAdminDashboard.tsx
import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { initial, queryString, type ReportFilters, type Report } from "./TicketAdminDashboardHelpers";

export function useTicketAdminDashboardState() {
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
  return { filters, setFilters, setApplied, exportError, employees, report, submit, set, download, s, cards };
}
