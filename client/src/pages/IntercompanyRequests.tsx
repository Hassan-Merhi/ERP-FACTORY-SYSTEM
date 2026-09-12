import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, CheckCircle, XCircle, ArrowRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

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

function StatusBadge({ status }: { status: string }) {
  if (status === "approved")
    return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30">Approved</Badge>;
  if (status === "dismissed")
    return <Badge className="bg-rose-500/10 text-rose-600 border-rose-500/30">Dismissed</Badge>;
  return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30">Pending</Badge>;
}

export default function IntercompanyRequests() {
  const [, _navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState("pending");
  const [approveDialogRequest, setApproveDialogRequest] = useState<ICRequest | null>(null);
  const [dismissDialogRequest, setDismissDialogRequest] = useState<ICRequest | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [approveDescription, setApproveDescription] = useState<string>("");
  const [dismissNote, setDismissNote] = useState("");

  const { data: requests = [], isLoading } = useQuery<ICRequest[]>({
    queryKey: ["/api/intercompany-requests", statusFilter],
    queryFn: async () => {
      const r = await fetch(`/api/intercompany-requests?status=${statusFilter}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });

  // Load accounts for the destination company when the approve dialog opens
  const { data: destAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", approveDialogRequest?.destCompanyId],
    queryFn: async () => {
      if (!approveDialogRequest?.destCompanyId) return [];
      const r = await fetch(`/api/ledger-accounts?companyId=${approveDialogRequest.destCompanyId}`, {
        credentials: "include",
      });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!approveDialogRequest,
  });

  const approveMutation = useMutation({
    mutationFn: async ({
      id,
      destLedgerAccountId,
      description,
    }: {
      id: number;
      destLedgerAccountId: number;
      description?: string;
    }) => {
      return apiRequest("POST", `/api/intercompany-requests/${id}/approve`, {
        destLedgerAccountId,
        description: description || undefined,
      });
    },
    onSuccess: async (response) => {
      const data = (await response.json()) as { voucherNumber?: string };
      toast({ title: "Approved", description: `Mirror voucher ${data.voucherNumber} created in destination company.` });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-requests/pending-count"] });
      setApproveDialogRequest(null);
      setSelectedAccountId("");
      setApproveDescription("");
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      return apiRequest("POST", `/api/intercompany-requests/${id}/dismiss`, { note });
    },
    onSuccess: () => {
      toast({ title: "Dismissed" });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-requests/pending-count"] });
      setDismissDialogRequest(null);
      setDismissNote("");
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  function handleApprove() {
    if (!approveDialogRequest || !selectedAccountId) return;
    approveMutation.mutate({
      id: approveDialogRequest.id,
      destLedgerAccountId: parseInt(selectedAccountId),
      description: approveDescription.trim() || undefined,
    });
  }

  function handleDismiss() {
    if (!dismissDialogRequest) return;
    dismissMutation.mutate({ id: dismissDialogRequest.id, note: dismissNote });
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => window.history.back()} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Intercompany Payment Requests</h1>
          <p className="text-sm text-muted-foreground">Review and approve cross-company payment notifications</p>
        </div>
        <div className="ml-auto">
          <Select value={statusFilter} onValueChange={setStatusFilter} data-testid="select-status-filter">
            <SelectTrigger className="w-36" data-testid="select-trigger-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-muted-foreground text-sm py-8 text-center">Loading…</div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {statusFilter === "pending" ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle className="h-8 w-8 text-emerald-500" />
                <p className="font-medium">All caught up — no pending requests</p>
              </div>
            ) : (
              <p>No {statusFilter} requests found.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <Card key={req.id} data-testid={`card-ic-request-${req.id}`}>
              <CardContent className="pt-4 pb-4">
                <div className="flex flex-wrap gap-4 items-start justify-between">
                  {/* Company flow */}
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{req.fromCompanyName}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span>{req.destCompanyName}</span>
                  </div>
                  <StatusBadge status={req.status} />
                </div>

                <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">Date</p>
                    <p className="font-medium">{req.fromVoucherDate}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Amount</p>
                    <p className="font-medium">
                      $
                      {Number.isInteger(parseFloat(req.amount))
                        ? parseFloat(req.amount).toLocaleString()
                        : parseFloat(req.amount).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">IC Account (CR)</p>
                    <p className="font-medium">{req.linkDestLedgerName}</p>
                  </div>
                </div>

                {req.description && <p className="mt-2 text-sm text-muted-foreground">{req.description}</p>}

                {req.status === "approved" && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Approved by <strong>{req.approvedByUsername}</strong>
                    {req.approvedAt && ` · ${formatDistanceToNow(new Date(req.approvedAt), { addSuffix: true })}`}
                    {req.chosenAccountName && ` · DR: ${req.chosenAccountName}`}
                  </p>
                )}
                {req.status === "dismissed" && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Dismissed by <strong>{req.approvedByUsername}</strong>
                    {req.dismissNote && ` · "${req.dismissNote}"`}
                  </p>
                )}

                {req.status === "pending" && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setApproveDialogRequest(req);
                        setSelectedAccountId("");
                        setApproveDescription("");
                      }}
                      data-testid={`button-approve-${req.id}`}
                    >
                      <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDismissDialogRequest(req);
                        setDismissNote("");
                      }}
                      data-testid={`button-dismiss-${req.id}`}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1.5" />
                      Dismiss
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Approve Dialog */}
      <Dialog
        open={!!approveDialogRequest}
        onOpenChange={(open) => {
          if (!open) {
            setApproveDialogRequest(null);
            setApproveDescription("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Payment Request</DialogTitle>
          </DialogHeader>
          {approveDialogRequest && (
            <div className="space-y-4 py-2">
              <div className="text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">From:</span> {approveDialogRequest.fromCompanyName}
                </p>
                <p>
                  <span className="text-muted-foreground">Amount:</span> $
                  {Number.isInteger(parseFloat(approveDialogRequest.amount))
                    ? parseFloat(approveDialogRequest.amount).toLocaleString()
                    : parseFloat(approveDialogRequest.amount).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                </p>
                <p>
                  <span className="text-muted-foreground">CR side:</span> {approveDialogRequest.linkDestLedgerName}
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
                      .filter((a) => a.id !== approveDialogRequest.linkDestLedgerAccountId)
                      .map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="approve-description">
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="approve-description"
                  rows={2}
                  placeholder={(() => {
                    const drName = selectedAccountId
                      ? (destAccounts.find((a) => a.id === parseInt(selectedAccountId))?.name ?? "selected account")
                      : "selected account";
                    return `Received from ${approveDialogRequest.linkDestLedgerName} into ${drName}`;
                  })()}
                  value={approveDescription}
                  onChange={(e) => setApproveDescription(e.target.value)}
                  data-testid="input-approve-description"
                  className="resize-none text-sm"
                />
                <p className="text-xs text-muted-foreground">Leave blank to use the placeholder text automatically.</p>
              </div>
              <p className="text-xs text-muted-foreground">
                A Receipt voucher will be created in <strong>{approveDialogRequest.destCompanyName}</strong>: DR
                selected account · CR {approveDialogRequest.linkDestLedgerName}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveDialogRequest(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleApprove}
              disabled={!selectedAccountId || approveMutation.isPending}
              data-testid="button-confirm-approve"
            >
              {approveMutation.isPending ? "Approving…" : "Approve & Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dismiss Dialog */}
      <Dialog
        open={!!dismissDialogRequest}
        onOpenChange={(open) => {
          if (!open) setDismissDialogRequest(null);
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
            <Button variant="outline" onClick={() => setDismissDialogRequest(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDismiss}
              disabled={dismissMutation.isPending}
              data-testid="button-confirm-dismiss"
            >
              {dismissMutation.isPending ? "Dismissing…" : "Dismiss"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
