import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { intercompanyApprovalMessage, parseIntercompanyApproval } from "@/lib/intercompanyApproval";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { liveCountQueryPolicy, stableReferenceQueryPolicy } from "@/lib/queryPolicies";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bell, CheckCircle, XCircle, ArrowRight, ExternalLink, CheckCheck, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationItem {
  id: number;
  eventType: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: number | null;
  triggeredByUserId: string | null;
  triggeredByUsername: string | null;
  companyId: number | null;
  companyName: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

interface ICRequest {
  id: number;
  fromCompanyName: string;
  destCompanyName: string;
  destCompanyId: number;
  fromVoucherNumber: string;
  fromVoucherDate: string;
  amount: string;
  description: string | null;
  status: string;
  createdAt: string;
  approvedByUsername: string | null;
  approvedAt: string | null;
  dismissNote: string | null;
  linkDestLedgerAccountId: number;
  linkDestLedgerName: string;
  chosenAccountName: string | null;
  destVoucherId: number | null;
}

interface LedgerAccount {
  id: number;
  name: string;
  companyId: number;
}

type TabId = "all" | "loading" | "invoice" | "intercompany";

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "loading", label: "Loading" },
  { id: "invoice", label: "Invoice" },
  { id: "intercompany", label: "Intercompany" },
];

const EVENT_META: Record<string, { label: string; className: string }> = {
  LOADING_STARTED: { label: "Loading", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  LOADING_FINALIZED: { label: "Loading", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  INVOICE_PENDING: { label: "Invoice", className: "bg-amber-500/15 text-amber-600 border-amber-300/50" },
  INVOICE_FINALIZED: { label: "Invoice", className: "bg-emerald-500/15 text-emerald-600 border-emerald-300/50" },
  INTERCOMPANY_REQUEST: { label: "Intercompany", className: "bg-purple-500/15 text-purple-600 border-purple-300/50" },
};

function getNavPath(item: NotificationItem): string | null {
  switch (item.eventType) {
    case "LOADING_STARTED":
      return "/factory/sales/loadings";
    case "LOADING_FINALIZED":
      return "/factory/invoicing";
    case "INVOICE_PENDING":
      return "/factory/invoicing";
    case "INVOICE_FINALIZED":
      return "/factory/invoicing";
    default:
      return null;
  }
}

function formatAmount(amount: string) {
  const n = parseFloat(amount);
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function NotificationsCenter() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("all");

  // Intercompany approve/dismiss state
  const [approveReq, setApproveReq] = useState<ICRequest | null>(null);
  const [dismissReq, setDismissReq] = useState<ICRequest | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [dismissNote, setDismissNote] = useState("");

  // ── Unread count (scoped to current company) ──────────────────────────────────
  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: companyQueryKey("/api/notifications/unread-count", companyId),
    queryFn: async () => {
      const r = await fetch("/api/notifications/unread-count", { credentials: "include" });
      return r.ok ? r.json() : { count: 0 };
    },
    ...liveCountQueryPolicy(60_000),
    enabled: !!companyId,
  });

  const { data: icCountData } = useQuery<{ count: number }>({
    queryKey: companyQueryKey("/api/intercompany-requests/pending-count", companyId),
    queryFn: async () => {
      const r = await fetch("/api/intercompany-requests/pending-count", { credentials: "include" });
      return r.ok ? r.json() : { count: 0 };
    },
    ...liveCountQueryPolicy(60_000),
    enabled: !!companyId,
  });

  const totalBadge = (unreadData?.count ?? 0) + (icCountData?.count ?? 0);

  // ── Notifications list — always unread only, scoped to current company ────────
  const typeParam = activeTab === "all" || activeTab === "intercompany" ? undefined : activeTab;

  const qKey = companyQueryKey("/api/notifications", companyId, activeTab);
  const { data: notifList = [], isLoading: notifLoading } = useQuery<NotificationItem[]>({
    queryKey: qKey,
    queryFn: async () => {
      const params = new URLSearchParams({ unread: "true" });
      if (typeParam) params.set("type", typeParam);
      const r = await fetch(`/api/notifications?${params}`, { credentials: "include" });
      return r.ok ? r.json() : [];
    },
    ...liveCountQueryPolicy(60_000),
    enabled: open && activeTab !== "intercompany" && !!companyId,
  });

  // ── IC requests ───────────────────────────────────────────────────────────────
  const { data: icRequests = [], isLoading: icLoading } = useQuery<ICRequest[]>({
    queryKey: companyQueryKey("/api/intercompany-requests", companyId, "pending"),
    queryFn: async () => {
      const r = await fetch("/api/intercompany-requests?status=pending", { credentials: "include" });
      return r.ok ? r.json() : [];
    },
    ...liveCountQueryPolicy(60_000),
    enabled: open && activeTab === "intercompany" && !!companyId,
  });

  // Dest accounts for IC approve dialog
  const { data: destAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyQueryKey("/api/ledger-accounts", approveReq?.destCompanyId),
    queryFn: async () => {
      if (!approveReq?.destCompanyId) return [];
      const r = await fetch(`/api/ledger-accounts?companyId=${approveReq.destCompanyId}`, { credentials: "include" });
      return r.ok ? r.json() : [];
    },
    ...stableReferenceQueryPolicy,
    enabled: !!approveReq?.destCompanyId,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const invalidateNotifs = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/notifications"], refetchType: "active" });
    queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"], refetchType: "active" });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/notifications/${id}/read`, {}),
    onSuccess: () => invalidateNotifs(),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/notifications/read-all", {}),
    onSuccess: () => {
      invalidateNotifs();
      toast({ title: "All notifications marked as read" });
    },
  });

  const invalidateIC = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/intercompany-requests"], refetchType: "active" });
    queryClient.invalidateQueries({ queryKey: ["/api/intercompany-requests/pending-count"], refetchType: "active" });
  };

  const approveMutation = useMutation({
    mutationFn: async ({ id, destLedgerAccountId }: { id: number; destLedgerAccountId: number }) => {
      const response = await apiRequest("POST", `/api/intercompany-requests/${id}/approve`, { destLedgerAccountId });
      return parseIntercompanyApproval(await response.json());
    },
    onSuccess: (result) => {
      toast({ title: "Approved", description: intercompanyApprovalMessage(result) });
      invalidateIC();
      setApproveReq(null);
      setSelectedAccountId("");
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      apiRequest("POST", `/api/intercompany-requests/${id}/dismiss`, { note }),
    onSuccess: () => {
      toast({ title: "Dismissed" });
      invalidateIC();
      setDismissReq(null);
      setDismissNote("");
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // ── Notification item click ───────────────────────────────────────────────────
  const handleNotifClick = (item: NotificationItem) => {
    if (!item.isRead) markReadMutation.mutate(item.id);
    const path = getNavPath(item);
    if (path) {
      setOpen(false);
      navigate(path);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const showNotifEmpty = !notifLoading && notifList.length === 0 && activeTab !== "intercompany";
  // All items in notifList are unread (we always fetch unread=true)
  const unreadInView = notifList.length;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className="relative">
            <Button variant="ghost" size="icon" title="Notifications" data-testid="button-notifications-bell">
              <Bell className="h-4 w-4" />
            </Button>
            {totalBadge > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center pointer-events-none"
                data-testid="badge-notif-count"
              >
                {totalBadge > 99 ? "99+" : totalBadge}
              </span>
            )}
          </div>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-96 p-0" data-testid="popover-notifications">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div>
              <p className="text-sm font-semibold">Notifications</p>
              <p className="text-xs text-muted-foreground">
                {totalBadge > 0 ? `${totalBadge} unread` : "All caught up"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {unreadInView > 0 && activeTab !== "intercompany" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 h-7"
                  onClick={() => markAllReadMutation.mutate()}
                  disabled={markAllReadMutation.isPending}
                  data-testid="button-mark-all-read"
                  title="Mark all as read"
                >
                  {markAllReadMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCheck className="h-3 w-3" />
                  )}
                  <span className="hidden sm:inline">Mark all read</span>
                </Button>
              )}
              {activeTab === "intercompany" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 h-7"
                  onClick={() => {
                    setOpen(false);
                    navigate("/intercompany-requests");
                  }}
                  data-testid="button-ic-view-all"
                >
                  View all
                  <ExternalLink className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex border-b overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                data-testid={`tab-notif-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex-1 px-2 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                  activeTab === tab.id
                    ? "border-b-2 border-primary text-foreground"
                    : "text-muted-foreground hover-elevate"
                )}
              >
                {tab.label}
                {tab.id === "intercompany" && (icCountData?.count ?? 0) > 0 && (
                  <span className="ml-1 inline-flex h-3.5 min-w-3.5 px-0.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold">
                    {icCountData!.count}
                  </span>
                )}
                {tab.id === "all" && (unreadData?.count ?? 0) > 0 && (
                  <span className="ml-1 inline-flex h-3.5 min-w-3.5 px-0.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold">
                    {unreadData!.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="max-h-[400px] overflow-y-auto">
            {/* Intercompany tab */}
            {activeTab === "intercompany" &&
              (icLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : icRequests.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                  <CheckCircle className="h-6 w-6 text-emerald-500" />
                  <p className="text-sm">No pending requests</p>
                </div>
              ) : (
                <div className="divide-y">
                  {icRequests.map((req) => (
                    <div key={req.id} className="px-4 py-3 space-y-2" data-testid={`ic-request-${req.id}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-sm font-medium min-w-0">
                          <span className="truncate">{req.fromCompanyName}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{req.destCompanyName}</span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatDistanceToNow(new Date(req.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="font-semibold">${formatAmount(req.amount)}</span>
                        <span className="text-muted-foreground text-xs truncate">CR: {req.linkDestLedgerName}</span>
                      </div>
                      {req.description && <p className="text-xs text-muted-foreground truncate">{req.description}</p>}
                      <div className="flex gap-2 pt-0.5">
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setApproveReq(req);
                            setSelectedAccountId("");
                          }}
                          data-testid={`button-approve-${req.id}`}
                        >
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => {
                            setDismissReq(req);
                            setDismissNote("");
                          }}
                          data-testid={`button-dismiss-${req.id}`}
                        >
                          <XCircle className="h-3 w-3 mr-1" />
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}

            {/* Notifications tabs */}
            {activeTab !== "intercompany" &&
              (notifLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : showNotifEmpty ? (
                <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                  <CheckCircle className="h-6 w-6 text-emerald-500" />
                  <p className="text-sm">All caught up — no notifications</p>
                </div>
              ) : (
                <div className="divide-y">
                  {notifList.map((item) => {
                    const meta = EVENT_META[item.eventType];
                    const navPath = getNavPath(item);
                    return (
                      <div
                        key={item.id}
                        data-testid={`notif-item-${item.id}`}
                        className={cn(
                          "px-4 py-3 space-y-1.5",
                          !item.isRead && "bg-primary/5 border-l-2 border-l-primary"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {!item.isRead && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 mt-0.5" />}
                            <span className="text-sm font-medium leading-snug truncate">{item.title}</span>
                          </div>
                          {meta && (
                            <Badge
                              variant="outline"
                              className={cn("text-[9px] px-1 h-4 font-medium shrink-0", meta.className)}
                            >
                              {meta.label}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{item.message}</p>
                        {/* Company info */}
                        {item.companyName && (
                          <p className="text-[10px] text-muted-foreground font-medium">{item.companyName}</p>
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-muted-foreground leading-tight">
                            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                            {item.triggeredByUsername && ` · by ${item.triggeredByUsername}`}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {!item.isRead && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  markReadMutation.mutate(item.id);
                                }}
                                className="text-[10px] text-muted-foreground underline hover:text-foreground"
                                data-testid={`button-mark-read-${item.id}`}
                              >
                                Mark read
                              </button>
                            )}
                            {navPath && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[10px] px-2 gap-0.5"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleNotifClick(item);
                                }}
                                data-testid={`button-go-to-record-${item.id}`}
                              >
                                Go to record
                                <ArrowRight className="h-2.5 w-2.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* IC Approve Dialog */}
      <Dialog
        open={!!approveReq}
        onOpenChange={(o) => {
          if (!o) setApproveReq(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Payment Request</DialogTitle>
          </DialogHeader>
          {approveReq && (
            <div className="space-y-4 py-2">
              <div className="text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">From:</span> {approveReq.fromCompanyName}
                </p>
                <p>
                  <span className="text-muted-foreground">Amount:</span> ${formatAmount(approveReq.amount)}
                </p>
                <p>
                  <span className="text-muted-foreground">CR side:</span> {approveReq.linkDestLedgerName}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="dest-account-select">Debit account (where money was received)</Label>
                <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                  <SelectTrigger id="dest-account-select" data-testid="select-dest-account">
                    <SelectValue placeholder="Select account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {destAccounts
                      .filter((a) => a.id !== approveReq.linkDestLedgerAccountId)
                      .map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                A Receipt voucher will be created in <strong>{approveReq.destCompanyName}</strong>: DR selected account
                · CR {approveReq.linkDestLedgerName}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveReq(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                approveReq &&
                approveMutation.mutate({ id: approveReq.id, destLedgerAccountId: parseInt(selectedAccountId) })
              }
              disabled={!selectedAccountId || approveMutation.isPending}
              data-testid="button-confirm-approve"
            >
              {approveMutation.isPending ? "Approving…" : "Approve & Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* IC Dismiss Dialog */}
      <Dialog
        open={!!dismissReq}
        onOpenChange={(o) => {
          if (!o) setDismissReq(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This will mark the request as dismissed without posting a mirror voucher.
            </p>
            <div className="space-y-2">
              <Label htmlFor="dismiss-note">Note (optional)</Label>
              <Textarea
                id="dismiss-note"
                placeholder="Reason for dismissal…"
                value={dismissNote}
                onChange={(e) => setDismissNote(e.target.value)}
                data-testid="input-dismiss-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissReq(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => dismissReq && dismissMutation.mutate({ id: dismissReq.id, note: dismissNote })}
              disabled={dismissMutation.isPending}
              data-testid="button-confirm-dismiss"
            >
              {dismissMutation.isPending ? "Dismissing…" : "Dismiss"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
