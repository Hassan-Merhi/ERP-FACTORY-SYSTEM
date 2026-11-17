import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import TicketConversation, { uploadInitialTicketEvidence } from "@/pages/tickets/TicketConversation";
import TicketNotificationSettings from "@/pages/tickets/TicketNotificationSettings";
import TicketAdminDashboard from "@/pages/tickets/TicketAdminDashboard";

type Ticket = {
  id: number;
  ticketNumber: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  sourceMode: string;
  assignedTo: string;
  createdBy: string;
  createdAt: string;
  dueAt: string;
  description: string;
};
type User = { id: string; username: string };
type Voucher = { id: number; reference: string; type: string };
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok)
    throw new Error(response.status === 403 ? "You do not have ticket access." : "Unable to load ticket information.");
  return response.json() as Promise<T>;
}
const ticketKey = (companyId: number | undefined) => ["tickets", companyId];
const statusLabels: Record<string, string> = {
  open: "Open",
  seen: "Seen",
  working: "Working on it",
  finalized: "Finalized",
  reopened: "Reopened",
};
const priorities = ["low", "normal", "high", "urgent"] as const;
const categories = [
  "Voucher Error",
  "Stock Discrepancy",
  "Production Error",
  "Attendance Issue",
  "Invoice / Loading Error",
  "Other",
];
const inputStyle = "w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm";
function TicketForm({
  onCreated,
  onCancel,
  sourceMode,
}: {
  onCreated: (id: number, warning?: string) => void;
  onCancel: () => void;
  sourceMode: "erp" | "factory";
}) {
  const { selectedCompany } = useCompany();
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(categories[0]);
  const [priority, setPriority] = useState<(typeof priorities)[number]>("normal");
  const [assignedTo, setAssignedTo] = useState("");
  const [reportedUserId, setReportedUserId] = useState("");
  const [voucherQ, setVoucherQ] = useState("");
  const [voucherId, setVoucherId] = useState<number | undefined>();
  const [voucherLabel, setVoucherLabel] = useState("");
  const [error, setError] = useState("");
  const [initialEvidence, setInitialEvidence] = useState<File | null>(null);
  const users = useQuery({
    queryKey: ["ticket-users", selectedCompany?.id],
    queryFn: () => fetchJson<{ users: User[] }>("/api/tickets/users"),
    enabled: !!selectedCompany?.id,
  });
  const vouchers = useQuery({
    queryKey: ["ticket-voucher-search", selectedCompany?.id, voucherQ],
    queryFn: () => fetchJson<{ records: Voucher[] }>(`/api/tickets/voucher-search?q=${encodeURIComponent(voucherQ)}`),
    enabled: !!selectedCompany?.id && voucherQ.trim().length >= 2 && !voucherId,
  });
  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/tickets", {
        title,
        description,
        category,
        priority,
        assignedTo,
        sourceMode,
        ...(reportedUserId ? { reportedUserId } : {}),
        ...(voucherId ? { voucherId } : {}),
      });
      return res.json() as Promise<{ ticket: Ticket }>;
    },
    onSuccess: async ({ ticket }) => {
      let warning: string | undefined;
      if (initialEvidence) {
        try {
          await uploadInitialTicketEvidence(ticket.id, initialEvidence);
        } catch (err) {
          warning = "Ticket saved, but photo upload failed: " + (err instanceof Error ? err.message : "Unknown error");
        }
      }
      await client.invalidateQueries({ queryKey: ticketKey(selectedCompany?.id) });
      onCreated(ticket.id, warning);
    },
    onError: (err: Error) => setError(err.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!assignedTo) return setError("Select an employee.");
    create.mutate();
  };
  return (
    <Card className="mx-auto w-full max-w-3xl">
      <CardHeader>
        <CardTitle>Create Ticket</CardTitle>
        <p className="text-sm text-muted-foreground">
          Assign a problem to a user and optionally link an exact voucher.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1 text-sm font-medium">
            Ticket title
            <Input
              required
              minLength={3}
              maxLength={240}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be fixed?"
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm font-medium">
              Issue type
              <select className={inputStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Priority
              <select
                className={inputStyle}
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm font-medium">
            Assign to employee
            <select className={inputStyle} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} required>
              <option value="">Select employee...</option>
              {users.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Employee associated with reported error (optional)
            <select className={inputStyle} value={reportedUserId} onChange={(e) => setReportedUserId(e.target.value)}>
              <option value="">Not specified / system issue</option>
              {users.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </label>
          {users.isError && (
            <p role="alert" className="text-sm text-destructive">
              Unable to load employees.
            </p>
          )}
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="ticket-voucher-search">
              Linked voucher (optional)
            </label>
            {voucherId ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span className="min-w-0 flex-1 break-all">{voucherLabel}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setVoucherId(undefined);
                    setVoucherLabel("");
                    setVoucherQ("");
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id="ticket-voucher-search"
                  placeholder="Search voucher number (minimum 2 characters)"
                  value={voucherQ}
                  onChange={(e) => setVoucherQ(e.target.value)}
                />
                {voucherQ.length >= 2 && (
                  <div
                    className="max-h-44 space-y-1 overflow-auto rounded-md border p-1"
                    aria-label="Matching vouchers"
                  >
                    {vouchers.isLoading && <p className="p-2 text-sm">Searching...</p>}
                    {vouchers.isError && (
                      <p className="p-2 text-sm text-muted-foreground">Voucher search unavailable or restricted.</p>
                    )}
                    {vouchers.data?.records.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className="block w-full rounded p-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setVoucherId(v.id);
                          setVoucherLabel(`${v.reference} — ${v.type}`);
                        }}
                      >
                        {v.reference} — {v.type}
                      </button>
                    ))}
                    {vouchers.data?.records.length === 0 && (
                      <p className="p-2 text-sm text-muted-foreground">No matching vouchers.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="space-y-2">
            <span className="block text-sm font-medium">Photo or evidence (optional)</span>
            <p className="text-xs text-muted-foreground">
              Select a photo now, or add evidence from inside the ticket later. Maximum 5 MB.
            </p>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm">
                Take photo
                <input
                  aria-label="Take initial ticket photo"
                  type="file"
                  capture="environment"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => setInitialEvidence(e.target.files?.[0] ?? null)}
                />
              </label>
              <label className="inline-flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm">
                Choose file
                <input
                  aria-label="Select initial ticket evidence"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="sr-only"
                  onChange={(e) => setInitialEvidence(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            {initialEvidence && (
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 break-all">{initialEvidence.name}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => setInitialEvidence(null)}>
                  Remove
                </Button>
              </div>
            )}
          </div>
          <label className="block space-y-1 text-sm font-medium">
            Describe the issue
            <Textarea
              required
              minLength={3}
              maxLength={10000}
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explain the mistake and the correction needed."
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !assignedTo}>
              {create.isPending ? "Creating..." : "Create ticket"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

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
            <select
              aria-label="Filter status"
              className={inputStyle}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {Object.entries(statusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
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
