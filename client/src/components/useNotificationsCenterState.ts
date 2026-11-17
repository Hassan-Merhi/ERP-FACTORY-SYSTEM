// Extracted from ./NotificationsCenter.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { intercompanyApprovalMessage, parseIntercompanyApproval } from "@/lib/intercompanyApproval";
import { dismissIntercompanyRequestsInBatches } from "@/lib/bulkDismissIntercompanyRequests";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { liveCountQueryPolicy, stableReferenceQueryPolicy } from "@/lib/queryPolicies";
import { useToast } from "@/hooks/use-toast";

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

export const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "loading", label: "Loading" },
  { id: "invoice", label: "Invoice" },
  { id: "intercompany", label: "Intercompany" },
];

export const EVENT_META: Record<string, { label: string; className: string }> = {
  LOADING_STARTED: { label: "Loading", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  LOADING_FINALIZED: { label: "Loading", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  INVOICE_PENDING: { label: "Invoice", className: "bg-amber-500/15 text-amber-600 border-amber-300/50" },
  INVOICE_FINALIZED: { label: "Invoice", className: "bg-emerald-500/15 text-emerald-600 border-emerald-300/50" },
  INTERCOMPANY_REQUEST: { label: "Intercompany", className: "bg-purple-500/15 text-purple-600 border-purple-300/50" },
  TICKET_CREATED: { label: "Ticket", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  TICKET_SEEN: { label: "Ticket", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  TICKET_START: { label: "Ticket", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  TICKET_FINALIZE: { label: "Ticket", className: "bg-emerald-500/15 text-emerald-600 border-emerald-300/50" },
  TICKET_REOPEN: { label: "Ticket", className: "bg-amber-500/15 text-amber-600 border-amber-300/50" },
  TICKET_COMMENT: { label: "Ticket", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  TICKET_ATTACHMENT: { label: "Ticket", className: "bg-blue-500/15 text-blue-600 border-blue-300/50" },
  TICKET_OVERDUE: { label: "Overdue", className: "bg-amber-500/15 text-amber-600 border-amber-300/50" },
};

export function getNavPath(item: NotificationItem, isFactory: boolean): string | null {
  if (item.entityType === "support_ticket" && item.entityId && item.entityId > 0) {
    return `${isFactory ? "/factory/tickets" : "/tickets"}?ticketId=${item.entityId}`;
  }
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

export function formatAmount(amount: string) {
  const n = parseFloat(amount);
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function useNotificationsCenterState() {
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
  const [confirmBulkDismiss, setConfirmBulkDismiss] = useState(false);

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
    onError: (err: ClientErrorLike) =>
      toast({ title: "Approval failed", description: err.message, variant: "destructive" }),
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
    onError: (err: ClientErrorLike) =>
      toast({ title: "Dismiss failed", description: err.message, variant: "destructive" }),
  });

  // Reuse the existing, individually authorized dismissal endpoint. Each request
  // is claimed only while pending; no source or destination vouchers are changed.
  const dismissAllICMutation = useMutation({
    mutationFn: (ids: number[]) =>
      dismissIntercompanyRequestsInBatches(ids, (id) =>
        apiRequest("POST", `/api/intercompany-requests/${id}/dismiss`, {
          note: "Bulk dismissed from notification center",
        })
      ),
    onSuccess: ({ dismissed, failed }) => {
      setConfirmBulkDismiss(false);
      invalidateIC();
      toast({
        title: failed ? "Some requests could not be dismissed" : "Intercompany requests dismissed",
        description: failed
          ? `${dismissed} dismissed; ${failed} could not be dismissed. Refresh and review remaining requests.`
          : `${dismissed} pending request${dismissed === 1 ? "" : "s"} dismissed.`,
        variant: failed ? "destructive" : "default",
      });
    },
    onError: (err: ClientErrorLike) => {
      invalidateIC();
      toast({ title: "Dismiss all failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Notification item click ───────────────────────────────────────────────────
  const handleNotifClick = (item: NotificationItem) => {
    if (!item.isRead) markReadMutation.mutate(item.id);
    const path = getNavPath(
      item,
      selectedCompany?.companyType === "factory" || selectedCompany?.companyType === "factory_v2"
    );
    if (path) {
      setOpen(false);
      navigate(path);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const showNotifEmpty = !notifLoading && notifList.length === 0 && activeTab !== "intercompany";
  // All items in notifList are unread (we always fetch unread=true)
  const unreadInView = notifList.length;
  return {
    activeTab,
    approveMutation,
    approveReq,
    confirmBulkDismiss,
    destAccounts,
    dismissAllICMutation,
    dismissMutation,
    dismissNote,
    dismissReq,
    handleNotifClick,
    icCountData,
    icLoading,
    icRequests,
    markAllReadMutation,
    markReadMutation,
    navigate,
    notifList,
    notifLoading,
    open,
    selectedAccountId,
    selectedCompany,
    setActiveTab,
    setApproveReq,
    setConfirmBulkDismiss,
    setDismissNote,
    setDismissReq,
    setOpen,
    setSelectedAccountId,
    showNotifEmpty,
    totalBadge,
    unreadData,
    unreadInView,
  };
}
