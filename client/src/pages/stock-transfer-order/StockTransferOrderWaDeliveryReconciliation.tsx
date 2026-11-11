/**
 * Phase 6 administrator review of the exact final Stock Transfer Order Excel
 * sent to the original approval group and receiving destination.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getErrorDetails } from "@shared/errorUtils";
import { confirmAction } from "@/components/ConfirmHost";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Kind = "approval_group" | "destination";
type Delivery = {
  id: number; recipientKind: Kind; recipientChatId: string;
  status: "pending" | "sending" | "accepted" | "failed" | "uncertain" | "verified";
  attemptCount: number; manualRetryCount: number; providerMessageId: string | null;
  workbookSha256: string | null; filename: string | null;
  acceptedAt: string | null; updatedAt: string | null; lastError: string | null;
};
type Audit = {
  id: number; eventType: string; occurredAt: string;
  details?: { reason?: string; administratorId?: string;
    recipientKind?: Kind; sameChatDeduplicated?: boolean; attempt?: number; };
};
type Reconciliation = {
  batch: { id: number; batchKey: string; status: string;
    destinationName: string; requestMessageId: string | null; reviewedAt: string | null; };
  deliveries: Delivery[];
  events: Audit[];
  workbook: { filename: string | null; snapshotSha256: string; workbookSha256: string | null } | null;
  deliveryEnabled: boolean;
};

const base = "/api/stock-transfer-order/wa-approval";

function DeliveryReviewRow({ batchId, delivery, other, onCompleted }: {
  batchId: number; delivery: Delivery; other?: Delivery;
  onCompleted: () => void;
}) {
  const { toast } = useToast();
  const [action, setAction] = useState<"verify_delivered" | "authorize_retry">("verify_delivered");
  const [reason, setReason] = useState("");
  const [checkedChat, setCheckedChat] = useState(false);
  const [checkedProvider, setCheckedProvider] = useState(false);
  const [checkedResult, setCheckedResult] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [editing, setEditing] = useState(false);
  const sameChat = other?.recipientChatId === delivery.recipientChatId;
  const eligible = delivery.status === "uncertain" || delivery.status === "failed";
  const canReconcile = eligible && !(delivery.recipientKind === "destination" && sameChat);
  const canRetry = delivery.manualRetryCount < 3;
  const mutation = useMutation({
    mutationFn: async () => (await apiRequest("POST",
      base + "/requests/" + batchId + "/deliveries/" + delivery.recipientKind + "/reconcile", {
        action, expectedStatus: delivery.status, reason: reason.trim(),
        checkedWhatsApp: checkedChat, checkedProvider, confirmedDelivered: action === "verify_delivered" && checkedResult,
        confirmedNotDelivered: action === "authorize_retry" && checkedResult,
        acknowledgeDuplicateRisk: action === "authorize_retry" && acknowledged,
      })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [base + "/recent"] });
      queryClient.invalidateQueries({ queryKey: [base + "/requests/" + batchId + "/deliveries"] });
      toast({ title: action === "verify_delivered" ? "Delivery manually verified" : "One controlled retry queued",
        description: action === "authorize_retry"
          ? "The original approved Excel and recipient are preserved."
          : "A verification audit was recorded; this does not claim a GREEN API message ID." });
      setEditing(false); setReason(""); setCheckedChat(false); setCheckedProvider(false);
      setCheckedResult(false); setAcknowledged(false);
      onCompleted();
    },
    onError: error => toast({
      title: "Review was not saved",
      description: getErrorDetails(error).message, variant: "destructive",
    }),
  });
  const statusText: Record<Delivery["status"], string> = {
    accepted: "Accepted by GREEN API", verified: "Manually verified in WhatsApp",
    sending: "Sending — do not retry", pending: "Queued to send",
    failed: "GREEN API upload failed", uncertain: "Unknown result — manual review required",
  };
  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid={"sto-wa-delivery-" + delivery.recipientKind}>
      <div className="flex justify-between gap-2 items-start">
        <div className="min-w-0">
          <p className="font-medium text-sm">
            {delivery.recipientKind === "approval_group" ? "Approval group" : "Receiving destination"}
          </p>
          <p className="font-mono text-xs text-muted-foreground break-all">{delivery.recipientChatId}</p>
          <p className="text-xs font-medium mt-1">
            {delivery.status === "uncertain" && <AlertTriangle className="inline h-3.5 w-3.5 text-amber-600 mr-1"/>}
            {["accepted","verified"].includes(delivery.status) &&
              <CheckCircle2 className="inline h-3.5 w-3.5 text-green-600 mr-1"/>}
            {statusText[delivery.status]}
          </p>
        </div>
        {canReconcile && (
          <Button size="sm" variant="outline" onClick={() => setEditing(v => !v)}
            data-testid={"sto-wa-reconcile-" + delivery.recipientKind}>
            {editing ? "Close review" : "Review"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Automatic attempts: {delivery.attemptCount} · Manual retries: {delivery.manualRetryCount}/3
        {delivery.providerMessageId ? " · Provider ID: " + delivery.providerMessageId : ""}
      </p>
      {delivery.lastError && <p className="text-xs text-amber-700">{delivery.lastError}</p>}
      {sameChat && delivery.recipientKind === "destination" &&
        <p className="text-xs text-muted-foreground">
          Shares the approval-group chat. Reconcile the approval group to avoid uploading twice.
        </p>}
      {editing && canReconcile && (
        <div className="border-t pt-3 space-y-3">
          <p className="text-xs text-amber-700">
            An uncertain file may already be in WhatsApp. Check the exact batch, recipient,
            filename, and provider history before changing its status.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={action==="verify_delivered" ? "default":"outline"}
              onClick={() => {setAction("verify_delivered");setCheckedResult(false);setAcknowledged(false);}}>
              I found the file
            </Button>
            <Button size="sm" variant={action==="authorize_retry" ? "default":"outline"}
              disabled={!canRetry}
              onClick={() => {setAction("authorize_retry");setCheckedResult(false);}}>
              File not found — authorize retry
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={"sto-chat-"+delivery.id} checked={checkedChat} onCheckedChange={v=>setCheckedChat(v===true)}/>
            <Label htmlFor={"sto-chat-"+delivery.id} className="text-xs">
              I checked the exact WhatsApp recipient chat and batch filename.
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={"sto-provider-"+delivery.id} checked={checkedProvider} onCheckedChange={v=>setCheckedProvider(v===true)}/>
            <Label htmlFor={"sto-provider-"+delivery.id} className="text-xs">
              I checked GREEN API message history for this recipient.
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={"sto-result-"+delivery.id} checked={checkedResult} onCheckedChange={v=>setCheckedResult(v===true)}/>
            <Label htmlFor={"sto-result-"+delivery.id} className="text-xs">
              {action==="verify_delivered"
                ? "I verified the exact approved Excel is in this WhatsApp chat."
                : "I could not find the approved Excel in the recipient chat or provider history."}
            </Label>
          </div>
          {action==="authorize_retry" && (
            <div className="flex items-center gap-2">
              <Checkbox id={"sto-risk-"+delivery.id} checked={acknowledged} onCheckedChange={v=>setAcknowledged(v===true)}/>
              <Label htmlFor={"sto-risk-"+delivery.id} className="text-xs">
                I understand an earlier send may have succeeded; retrying may produce a duplicate.
              </Label>
            </div>
          )}
          <div className="space-y-1">
            <Label>What did you verify? (20–500 characters, saved in audit history)</Label>
            <Textarea rows={3} value={reason} onChange={setReason}
              placeholder="Where you checked, what batch/file you looked for, and the result"
              data-testid="sto-wa-review-evidence"/>
          </div>
          <Button size="sm" disabled={mutation.isPending || !checkedChat || !checkedProvider ||
            !checkedResult || reason.trim().length < 20 || reason.trim().length > 500 ||
            (action==="authorize_retry" && (!acknowledged || !canRetry))}
            onClick={async () => {
              if(await confirmAction({
                title: action==="verify_delivered"
                  ? "Mark this exact approved Excel as manually verified?"
                  : "Authorize a possible duplicate WhatsApp upload after review?",
                tone: action==="authorize_retry" ? "destructive" : "default",
              })) mutation.mutate();
            }}
            data-testid="sto-wa-confirm-reconciliation">
            {mutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin"/>}
            {action==="verify_delivered" ? "Record manual verification" : "Authorize one retry"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function StockTransferOrderWaDeliveryReconciliation({ batchId }: { batchId: number }) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const details=useQuery<Reconciliation>({
    queryKey: [base + "/requests/" + batchId + "/deliveries",selectedCompany?.id],
    queryFn: async () => (await apiRequest("GET", base + "/requests/" + batchId + "/deliveries")).json(),
    enabled: !!selectedCompany?.id && Number.isSafeInteger(batchId) && batchId>0,
    refetchInterval: 5_000,
  });
  if(details.isLoading)return <p className="text-xs text-muted-foreground">Loading delivery review…</p>;
  if(details.isError)return <p className="text-xs text-destructive">Could not load the delivery audit for this batch.</p>;
  const result=details.data;
  if(!result)return null;
  const other= (kind:Kind)=>result.deliveries.find(d=>d.recipientKind!==kind);
  return (
    <div className="rounded-lg border p-3 space-y-3" data-testid="sto-wa-delivery-reconciliation">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-2">
          <ShieldCheck className="h-4 w-4"/> Approved Excel — delivery reconciliation
        </p>
        <Button size="icon" variant="ghost" onClick={()=>{void details.refetch();}}
          title="Refresh delivery status"><RefreshCw className="h-4 w-4"/></Button>
      </div>
      <p className="text-xs text-muted-foreground break-all">
        {result.batch.destinationName} · Batch {result.batch.batchKey}
      </p>
      <p className="text-xs text-muted-foreground">
        File: {result.workbook?.filename||"Waiting for workbook generation"}
        {result.workbook?.workbookSha256 ? " · SHA-256: "+result.workbook.workbookSha256.slice(0,16)+"…" : ""}
      </p>
      {!result.deliveryEnabled && (
        <p className="text-xs text-amber-700">
          Excel delivery worker is paused. Authorizing a retry queues it until processing resumes.
        </p>
      )}
      {result.batch.status!=="approved" && (
        <p className="text-xs">This batch is not approved; no final Excel should be sent.</p>
      )}
      <div className="space-y-2">
        {result.deliveries.map(delivery=>(
          <DeliveryReviewRow key={delivery.id} batchId={batchId}
            delivery={delivery} other={other(delivery.recipientKind)}
            onCompleted={()=>{void details.refetch();}}/>
        ))}
      </div>
      {result.events.length>0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Delivery evidence history</p>
          <div className="max-h-36 overflow-y-auto space-y-1">
            {result.events.slice(0,12).map(event=>(
              <p key={event.id} className="text-xs text-muted-foreground">
                {new Date(event.occurredAt).toLocaleString()} · {event.eventType.replaceAll("_"," ")}
                {event.details?.recipientKind ? " · "+event.details.recipientKind : ""}
                {event.details?.administratorId ? " · by "+event.details.administratorId : ""}
                {event.details?.reason ? " · "+event.details.reason : ""}
              </p>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        GREEN API acceptance is not a read receipt. Manual verification records
        administrator evidence separately, without fabricating a provider message ID.
      </p>
    </div>
  );
}
