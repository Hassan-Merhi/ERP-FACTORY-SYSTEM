import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import TicketConversation from "@/pages/tickets/TicketConversation";
import TicketNotificationSettings from "@/pages/tickets/TicketNotificationSettings";
import TicketAdminDashboard from "@/pages/tickets/TicketAdminDashboard";
import { fetchJson, ticketKey, type Ticket, type User } from "./useTicketFormState";
import { TicketForm } from "./TicketManagementTicketForm";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";
const statusLabels: Record<string, string> = {
  open: "Open",
  seen: "Seen",
  working: "Working on it",
  finalized: "Finalized",
  reopened: "Reopened",
};

export default function TicketManagement({ sourceMode = "erp" }: { sourceMode?: "erp" | "factory" }) {
  const { selectedCompany } = useCompany();
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editingNotifications, setEditingNotifications] = useState(false);
  const [showingDashboard, setShowingDashboard] = useState(
    () => new URLSearchParams(window.location.search).get("dashboard") === "1"
  );
  const [ticketId, setTicketId] = useState<number | undefined>(() => {
    const id = Number(new URLSearchParams(window.location.search).get("ticketId"));
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  });
  const [evidenceWarning, setEvidenceWarning] = useState<string | undefined>();
  useEffect(() => {
    setPage(1);
    setCreating(false);
    setEditingNotifications(false);
    setShowingDashboard(new URLSearchParams(window.location.search).get("dashboard") === "1");
    const id = Number(new URLSearchParams(window.location.search).get("ticketId"));
    setTicketId(Number.isSafeInteger(id) && id > 0 ? id : undefined);
  }, [selectedCompany?.id]);
  const params = new URLSearchParams({
    page: String(page),
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(status ? { status } : {}),
  });
  const adminAccess = useQuery({
    queryKey: ["ticket-admin-access", selectedCompany?.id],
    queryFn: () => fetchJson<{ canViewDashboard: boolean; canExport: boolean }>("/api/tickets/dashboard-access"),
    enabled: !!selectedCompany?.id,
  });
  const users = useQuery({
    queryKey: ["ticket-list-users", selectedCompany?.id],
    queryFn: () => fetchJson<{ users: User[] }>("/api/tickets/users"),
    enabled: !!selectedCompany?.id,
  });
  const names = new Map<string, string>((users.data?.users ?? []).map((u) => [u.id, u.username] as const));
  const listing = useQuery({
    queryKey: [...ticketKey(selectedCompany?.id), page, q, status],
    queryFn: () => fetchJson<{ tickets: Ticket[]; hasMore: boolean }>(`/api/tickets?${params}`),
    enabled: !!selectedCompany?.id,
  });

  const viewCreate = creating || location.endsWith("/new");
  if (showingDashboard)
    return (
      <main className="w-full min-w-0 overflow-x-hidden p-3 sm:p-6">
        <TicketAdminDashboard
          canExport={adminAccess.data?.canExport === true}
          onBack={() => {
            setShowingDashboard(false);
            navigate(sourceMode === "factory" ? "/factory/tickets" : "/tickets");
          }}
          onOpenTicket={(id) => {
            setShowingDashboard(false);
            setTicketId(id);
            navigate(`${sourceMode === "factory" ? "/factory/tickets" : "/tickets"}?ticketId=${id}`);
          }}
        />
      </main>
    );
  if (editingNotifications)
    return (
      <main className="w-full min-w-0 overflow-x-hidden p-3 sm:p-6">
        <TicketNotificationSettings onClose={() => setEditingNotifications(false)} />
      </main>
    );
  if (viewCreate)
    return (
      <main className="w-full min-w-0 overflow-x-hidden p-3 sm:p-6">
        <TicketForm
          sourceMode={sourceMode}
          onCancel={() => {
            setCreating(false);
            navigate(sourceMode === "factory" ? "/factory/tickets" : "/tickets");
          }}
          onCreated={(id, warning) => {
            setCreating(false);
            setEvidenceWarning(warning);
            navigate(sourceMode === "factory" ? "/factory/tickets" : "/tickets");
            setTicketId(id);
            navigate(`${sourceMode === "factory" ? "/factory/tickets" : "/tickets"}?ticketId=${id}`);
          }}
        />
      </main>
    );
  return (
    <main className="w-full min-w-0 space-y-4 overflow-x-hidden p-3 sm:p-6">
      <PageHeader title="Ticket Management" subtitle="Your tickets and permitted company cases">
        {adminAccess.data?.canViewDashboard && (
          <Button
            variant="outline"
            onClick={() => {
              setShowingDashboard(true);
              navigate(`${sourceMode === "factory" ? "/factory/tickets" : "/tickets"}?dashboard=1`);
            }}
          >
            Admin Dashboard
          </Button>
        )}
        <Button variant="outline" onClick={() => setEditingNotifications(true)}>
          Notification settings
        </Button>
        <Button
          onClick={() => {
            setCreating(true);
            setTicketId(undefined);
          }}
        >
          + Create Ticket
        </Button>
      </PageHeader>
      {ticketId ? (
        <>
          {evidenceWarning && (
            <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
              {evidenceWarning}
            </p>
          )}
          <TicketConversation
            ticketId={ticketId}
            companyId={selectedCompany?.id}
            userNames={names}
            onBack={() => {
              setTicketId(undefined);
              setEvidenceWarning(undefined);
              navigate(sourceMode === "factory" ? "/factory/tickets" : "/tickets");
            }}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: ticketKey(selectedCompany?.id) });
            }}
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
            <Input
              aria-label="Search tickets"
              placeholder="Search ticket number or title"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
            <Select
              value={status || "__all__"}
              onValueChange={(value) => {
                setStatus(value === "__all__" ? "" : value);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter status" className="w-full min-w-0 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All statuses</SelectItem>
                {Object.entries(statusLabels).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {listing.isLoading && <p role="status">Loading tickets...</p>}
          {listing.isError && (
            <p role="alert" className="text-destructive">
              Unable to load tickets. Verify your access and company selection.
            </p>
          )}
          <div className="space-y-2">
            {listing.data?.tickets.map((t) => (
              <button
                key={t.id}
                type="button"
                className="flex w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
                onClick={() => {
                  setTicketId(t.id);
                  navigate(`${sourceMode === "factory" ? "/factory/tickets" : "/tickets"}?ticketId=${t.id}`);
                }}
              >
                <span className="min-w-0">
                  <span className="text-sm font-semibold">{t.ticketNumber}</span>
                  <span className="ml-2 break-words text-sm">{t.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t.category} • Assigned: {names.get(t.assignedTo) ?? "Employee"} • {t.sourceMode.toUpperCase()} •{" "}
                    {new Date(t.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
                  <span className="rounded bg-muted px-2 py-1">{statusLabels[t.status] ?? t.status}</span>
                  <span className="rounded border px-2 py-1">{t.priority}</span>
                </span>
              </button>
            ))}
          </div>
          {listing.data?.tickets.length === 0 && (
            <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">No matching tickets.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" disabled={!listing.data?.hasMore} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
