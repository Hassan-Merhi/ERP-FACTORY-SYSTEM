import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckCircle2, XCircle, Clock, Play, Trash2, MessageSquare, ClipboardList } from "lucide-react";
import type { ApprovalRequest } from "@shared/schema";

const STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  executed: { label: "Executed", variant: "secondary" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function fmtDate(v: string | Date | null | undefined) {
  if (!v) return "—";
  return new Date(v).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface ReviewDialogProps {
  request: ApprovalRequest;
  action: "approve" | "reject";
  onClose: () => void;
  onDone: () => void;
}

function ReviewDialog({ request, action, onClose, onDone }: ReviewDialogProps) {
  const { toast } = useToast();
  const [note, setNote] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/approvals/${request.id}/${action}`, {
        reviewerNote: note || undefined,
      }),
    onSuccess: () => {
      toast({ title: action === "approve" ? "Request approved" : "Request rejected" });
      queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/approvals/my"] });
      onDone();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{action === "approve" ? "Approve request" : "Reject request"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-muted p-3 text-sm space-y-1">
            <p>
              <span className="text-muted-foreground">Action: </span>
              <span className="font-medium">{request.actionType}</span>
            </p>
            {request.targetIdentifier && (
              <p>
                <span className="text-muted-foreground">Target: </span>
                {request.targetIdentifier}
              </p>
            )}
            {request.amountValue && (
              <p>
                <span className="text-muted-foreground">Amount: </span>
                {parseFloat(request.amountValue).toLocaleString()}
              </p>
            )}
            <p>
              <span className="text-muted-foreground">Requested by: </span>
              {request.requestedByUsername} · {fmtDate(request.requestedAt)}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note for the requester…"
              className="resize-none"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action === "reject" ? "destructive" : "default"}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid={`button-confirm-${action}`}
          >
            {mutation.isPending ? "Saving…" : action === "approve" ? "Approve" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestRow({
  r,
  isAdmin,
  currentUserId,
  onAction,
}: {
  r: ApprovalRequest;
  isAdmin: boolean;
  currentUserId?: string;
  onAction: (req: ApprovalRequest, act: "approve" | "reject" | "execute" | "cancel") => void;
}) {
  const isOwn = r.requestedByUserId === currentUserId;

  return (
    <TableRow key={r.id} data-testid={`row-approval-${r.id}`}>
      <TableCell className="font-medium text-sm">{r.actionType}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{r.targetIdentifier ?? r.targetTable ?? "—"}</TableCell>
      <TableCell className="text-sm">{r.amountValue ? parseFloat(r.amountValue).toLocaleString() : "—"}</TableCell>
      <TableCell className="text-sm">{r.requestedByUsername}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{fmtDate(r.requestedAt)}</TableCell>
      <TableCell>
        <StatusBadge status={r.status} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground max-w-[160px] truncate">{r.reviewerNote ?? "—"}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          {r.status === "pending" && isAdmin && !isOwn && (
            <>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onAction(r, "approve")}
                data-testid={`button-approve-${r.id}`}
                title="Approve"
              >
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onAction(r, "reject")}
                data-testid={`button-reject-${r.id}`}
                title="Reject"
              >
                <XCircle className="h-4 w-4 text-destructive" />
              </Button>
            </>
          )}
          {r.status === "approved" && isAdmin && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onAction(r, "execute")}
              data-testid={`button-execute-${r.id}`}
              title="Mark as executed"
            >
              <Play className="h-4 w-4 text-blue-600" />
            </Button>
          )}
          {r.status === "pending" && isOwn && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onAction(r, "cancel")}
              data-testid={`button-cancel-${r.id}`}
              title="Cancel request"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-12 text-center text-muted-foreground text-sm">
      <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-30" />
      {message}
    </div>
  );
}

interface Props {
  currentUser?: { id?: string; role?: string } | null;
}

export function ApprovalsPage({ currentUser }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState("pending");
  const [reviewing, setReviewing] = useState<{
    request: ApprovalRequest;
    action: "approve" | "reject";
  } | null>(null);

  const isAdmin = ["Admin", "Developer"].includes(currentUser?.role ?? "");

  const allQuery = useQuery<ApprovalRequest[]>({
    queryKey: ["/api/approvals"],
    enabled: isAdmin,
  });

  const myQuery = useQuery<ApprovalRequest[]>({
    queryKey: ["/api/approvals/my"],
    enabled: !isAdmin,
  });

  const executeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/approvals/${id}/execute`, {}),
    onSuccess: () => {
      toast({ title: "Marked as executed" });
      queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/approvals/${id}`),
    onSuccess: () => {
      toast({ title: "Request cancelled" });
      queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/approvals/my"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleAction = (r: ApprovalRequest, act: "approve" | "reject" | "execute" | "cancel") => {
    if (act === "approve" || act === "reject") {
      setReviewing({ request: r, action: act });
    } else if (act === "execute") {
      executeMutation.mutate(r.id);
    } else {
      cancelMutation.mutate(r.id);
    }
  };

  const all = allQuery.data ?? [];
  const byStatus = (s: string) => all.filter((r) => r.status === s);
  const myAll = isAdmin ? all.filter((r) => r.requestedByUserId === currentUser?.id) : (myQuery.data ?? []);

  const isLoading = isAdmin ? allQuery.isLoading : myQuery.isLoading;

  const tableHeader = (
    <TableRow>
      <TableHead>Action</TableHead>
      <TableHead>Target</TableHead>
      <TableHead>Amount</TableHead>
      <TableHead>Requested by</TableHead>
      <TableHead>Date</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Note</TableHead>
      <TableHead className="w-[80px]" />
    </TableRow>
  );

  const renderTable = (rows: ApprovalRequest[], empty: string) => {
    if (isLoading) {
      return <div className="py-8 text-center text-muted-foreground text-sm">Loading…</div>;
    }
    if (!rows.length) return <EmptyState message={empty} />;
    return (
      <Table>
        <TableHeader>{tableHeader}</TableHeader>
        <TableBody>
          {rows.map((r) => (
            <RequestRow key={r.id} r={r} isAdmin={isAdmin} currentUserId={currentUser?.id} onAction={handleAction} />
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Approval Requests</h2>
        <p className="text-sm text-muted-foreground">
          Review and action risky operations that need a second set of eyes.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Tabs value={tab} onValueChange={setTab}>
            <div className="border-b px-4 pt-2">
              <TabsList className="bg-transparent p-0 h-auto gap-1">
                {isAdmin && (
                  <>
                    <TabsTrigger
                      value="pending"
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 px-3 text-sm"
                      data-testid="tab-approvals-pending"
                    >
                      <Clock className="h-3.5 w-3.5 mr-1.5" />
                      Pending
                      {byStatus("pending").length > 0 && (
                        <Badge className="ml-1.5 h-4 text-[11px] px-1">{byStatus("pending").length}</Badge>
                      )}
                    </TabsTrigger>
                    <TabsTrigger
                      value="approved"
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 px-3 text-sm"
                      data-testid="tab-approvals-approved"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                      Approved
                    </TabsTrigger>
                    <TabsTrigger
                      value="rejected"
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 px-3 text-sm"
                      data-testid="tab-approvals-rejected"
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1.5" />
                      Rejected
                    </TabsTrigger>
                    <TabsTrigger
                      value="executed"
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 px-3 text-sm"
                      data-testid="tab-approvals-executed"
                    >
                      <Play className="h-3.5 w-3.5 mr-1.5" />
                      Executed
                    </TabsTrigger>
                  </>
                )}
                <TabsTrigger
                  value="mine"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 px-3 text-sm"
                  data-testid="tab-approvals-mine"
                >
                  <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                  My Requests
                </TabsTrigger>
              </TabsList>
            </div>

            {isAdmin && (
              <>
                <TabsContent value="pending" className="m-0">
                  {renderTable(byStatus("pending"), "No pending requests")}
                </TabsContent>
                <TabsContent value="approved" className="m-0">
                  {renderTable(byStatus("approved"), "No approved requests")}
                </TabsContent>
                <TabsContent value="rejected" className="m-0">
                  {renderTable(byStatus("rejected"), "No rejected requests")}
                </TabsContent>
                <TabsContent value="executed" className="m-0">
                  {renderTable(
                    [...byStatus("executed"), ...byStatus("cancelled")].sort(
                      (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
                    ),
                    "No executed requests yet"
                  )}
                </TabsContent>
              </>
            )}

            <TabsContent value="mine" className="m-0">
              {renderTable(myAll, "You have no requests yet")}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {reviewing && (
        <ReviewDialog
          request={reviewing.request}
          action={reviewing.action}
          onClose={() => setReviewing(null)}
          onDone={() => setReviewing(null)}
        />
      )}
    </div>
  );
}
