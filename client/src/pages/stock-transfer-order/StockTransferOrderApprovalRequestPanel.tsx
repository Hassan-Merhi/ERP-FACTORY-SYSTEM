/**
 * "Request Approval" tab in the existing Stock Transfer Order Send to WhatsApp.
 * Selects persisted, order-origin vouchers, never draft screen rows.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck, AlertTriangle, RefreshCw, XCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getErrorDetails } from "@shared/errorUtils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmAction } from "@/components/ConfirmHost";
import type { useStockTransferOrderModel } from "./useStockTransferOrderModel";
import type { StockTransferOrderWaSettings } from "../settings/StockTransferOrderApprovalSettings";

type Model = ReturnType<typeof useStockTransferOrderModel>;
type EligibleOrder = { transferId: number; voucherNumber: string; pendingRevisions: number; reserved: boolean };
type Batch = { id: number; batchKey: string; destinationName: string; orderCount: number; revisionCount: number; status: string; requestedAt: string|null; reviewedAt: string|null; reviewedByPhone: string|null };
type RequestOutcome = { ok: boolean; uncertain?: boolean; batchId: number; batchKey?: string; orders?: number; revisions?: number; message: string };
const base = "/api/stock-transfer-order/wa-approval";

export function StockTransferOrderApprovalRequestPanel({ model, open }: { model: Model; open: boolean }) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [destinationId, setDestinationId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [legacyIds, setLegacyIds] = useState<number[]>([]);
  const autoSelected = useRef<number | null>(null);
  const destinationSeededForCompany = useRef<number | null>(null);
  const [result, setResult] = useState<RequestOutcome | null>(null);

  const config = useQuery<StockTransferOrderWaSettings>({
    queryKey: [base + "/settings", selectedCompany?.id],
    queryFn: async () => (await apiRequest("GET", base + "/settings")).json(),
    enabled: open && !!selectedCompany?.id,
  });
  useEffect(() => {
    if (!open) {
      destinationSeededForCompany.current = null;
      return;
    }
    if (destinationSeededForCompany.current === selectedCompany?.id) return;
    if (model.destinationLocationId &&
        config.data?.destinations.some(d => d.id === model.destinationLocationId)) {
      setDestinationId(model.destinationLocationId);
      destinationSeededForCompany.current = selectedCompany?.id ?? null;
    }
  }, [open, model.destinationLocationId, config.data, selectedCompany?.id]);

  const eligible = useQuery<{ orders: EligibleOrder[] }>({
    queryKey: [base + "/eligible", selectedCompany?.id, destinationId],
    queryFn: async () => (await apiRequest("GET", base + "/eligible?destinationId=" + destinationId)).json(),
    enabled: open && !!selectedCompany?.id && !!destinationId,
  });
  const legacy = useQuery<{ orders: EligibleOrder[] }>({
    queryKey: [base + "/legacy", selectedCompany?.id, destinationId],
    queryFn: async () => (await apiRequest("GET", base + "/legacy?destinationId=" + destinationId)).json(),
    enabled: open && !!selectedCompany?.id && !!destinationId && !!config.data?.canConfigure,
  });
  const recent = useQuery<{ batches: Batch[] }>({
    queryKey: [base + "/recent", selectedCompany?.id],
    queryFn: async () => (await apiRequest("GET", base + "/recent")).json(),
    enabled: open && !!selectedCompany?.id,
  });
  useEffect(() => {
    const currentTransferId = model.existingTransfer?.id;
    if (!currentTransferId || !eligible.data || autoSelected.current === currentTransferId) return;
    if (eligible.data.orders.some(order => order.transferId === currentTransferId && !order.reserved)) {
      autoSelected.current = currentTransferId;
      setSelectedIds(previous => previous.includes(currentTransferId) ? previous : [...previous, currentTransferId]);
    }
  }, [model.existingTransfer?.id, eligible.data]);

  const available = useMemo(() => (eligible.data?.orders || []).filter(o => !o.reserved), [eligible.data]);
  const pendingCount = available.filter(o => selectedIds.includes(o.transferId))
    .reduce((sum, o) => sum + o.pendingRevisions, 0);
  const send = useMutation<RequestOutcome>({
    mutationFn: async () => {
      const response = await apiRequest("POST", base + "/requests", {
        destinationLocationId: destinationId, transferIds: selectedIds,
      });
      return response.json();
    },
    onSuccess: data => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: [base + "/eligible"] });
      queryClient.invalidateQueries({ queryKey: [base + "/recent"] });
      toast({ title: data.ok ? "Approval request sent" : "Delivery needs verification",
        description: data.message, variant: data.ok ? "default" : "destructive" });
    },
    onError: error => toast({
      title: "Approval request not sent", description: getErrorDetails(error).message, variant: "destructive",
    }),
  });
  const enrollLegacy = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", base + "/enroll-legacy", {
        destinationLocationId: destinationId, transferIds: legacyIds, acknowledge: true,
      })).json(),
    onSuccess: () => {
      setLegacyIds([]);
      queryClient.invalidateQueries({ queryKey: [base + "/legacy"] });
      queryClient.invalidateQueries({ queryKey: [base + "/eligible"] });
      toast({ title: "Historical Stock Transfer Orders enabled for approval" });
    },
    onError: error => toast({
      title: "Historical order enrollment failed", description: getErrorDetails(error).message,
      variant: "destructive",
    }),
  });
  const cancel = useMutation({
    mutationFn: async (batchId: number) =>
      (await apiRequest("POST", base + "/requests/" + batchId + "/cancel", {})).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [base + "/eligible"] });
      queryClient.invalidateQueries({ queryKey: [base + "/recent"] });
      setSelectedIds([]);
      toast({ title: "Approval request cancelled" });
    },
    onError: error => toast({ title: "Could not cancel approval request",
      description: getErrorDetails(error).message, variant: "destructive" }),
  });

  function selectDestination(value: string) {
    setDestinationId(Number(value));
    autoSelected.current = null;
    setSelectedIds([]);
    setLegacyIds([]);
    setResult(null);
  }
  function toggle(id: number, checked: boolean) {
    setSelectedIds(ids => checked ? [...new Set([...ids, id])] : ids.filter(x => x !== id));
    setResult(null);
  }

  return (
    <div className="space-y-4" data-testid="sto-wa-approval-request">
      <div className="rounded-lg border p-3 text-sm space-y-1">
        <p className="font-medium flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-green-600"/>
          One DONE records the full-batch decision for every pending revision in the selected orders
        </p>
        <p className="text-xs text-muted-foreground">
          All source locations are included. This sends one WhatsApp request to the approval group.
          The decision is recorded once. Stock approval and the final Excel delivery are implemented in Phases 4–5.
        </p>
      </div>
      {config.isError && <p className="text-sm text-destructive">Could not load WhatsApp approval settings.</p>}
      {config.data && !config.data.executionEnabled && (
        <p className="text-sm text-amber-600">Automatic full-batch approvals are paused on the server.</p>
      )}
      {config.data && !config.data.webhookConfigured && (
        <p className="text-sm text-amber-600">
          Approval webhook token is not configured yet; requests are disabled until the provider
          and ERP have the same Bearer token.
        </p>
      )}
      {config.data && (!config.data.settings.enabled || !config.data.connected) &&
        <p className="text-sm text-amber-600">Enable approval settings and connect the main WhatsApp account in Export Center.</p>}
      <div className="space-y-2">
        <Label>Destination (one destination per approval batch)</Label>
        <Select value={destinationId?.toString() || ""} onValueChange={selectDestination}>
          <SelectTrigger data-testid="sto-wa-select-destination"><SelectValue placeholder="Select destination" /></SelectTrigger>
          <SelectContent>{(config.data?.destinations || []).map(d => (
            <SelectItem key={d.id} value={String(d.id)}>{d.name}{d.chatId && d.enabled ? "" : " — no recipient"}</SelectItem>
          ))}</SelectContent>
        </Select>
      </div>
      {destinationId && (
        <div className="rounded-lg border">
          <div className="p-3 border-b flex items-center justify-between">
            <div className="font-medium text-sm">Saved orders awaiting revision approval</div>
            <Button size="icon" variant="ghost" onClick={() => eligible.refetch()} title="Refresh orders">
              <RefreshCw className="h-4 w-4"/>
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto p-3 space-y-2">
            {eligible.isLoading ? <p className="text-sm text-muted-foreground">Loading orders…</p> :
            eligible.isError ? <p className="text-sm text-destructive">Could not load orders.</p> :
            eligible.data?.orders.length === 0 ? <p className="text-sm text-muted-foreground">No eligible pending Stock Transfer Orders for this destination.</p> :
            eligible.data?.orders.map(order => (
              <label key={order.transferId} className="flex items-center gap-3 rounded-md border p-2.5">
                <Checkbox checked={selectedIds.includes(order.transferId)} disabled={order.reserved || send.isPending}
                  onCheckedChange={checked => toggle(order.transferId, checked === true)}/>
                <span className="flex-1 text-sm font-medium">{order.voucherNumber}</span>
                <span className="text-xs text-muted-foreground">{order.pendingRevisions} revisions</span>
                {order.reserved && <Badge variant="secondary">Already in batch</Badge>}
              </label>
            ))}
          </div>
          <div className="px-3 pb-3 flex items-center justify-between text-sm">
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(available.map(o => o.transferId))}
              disabled={!available.length || send.isPending}>Select all eligible</Button>
            <span>{selectedIds.length} orders · {pendingCount} pending revisions</span>
          </div>
        </div>
      )}
      {config.data?.canConfigure && destinationId && (legacy.data?.orders.length || 0) > 0 && (
        <div className="rounded-lg border p-3 space-y-2">
          <p className="font-medium text-sm">Older saved Stock Transfer Orders</p>
          <p className="text-xs text-muted-foreground">
            Orders created before this workflow need one-time admin enrollment.
            Only previously saved orders identified as Stock Transfer Orders appear here.
            This changes an order classification only — not its stock or accounting.
          </p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {legacy.data?.orders.map(order => (
              <label key={order.transferId} className="flex gap-2 items-center text-sm rounded border p-2">
                <Checkbox checked={legacyIds.includes(order.transferId)}
                  onCheckedChange={checked => setLegacyIds(ids => checked ?
                    [...new Set([...ids, order.transferId])] : ids.filter(id => id !== order.transferId))}/>
                {order.voucherNumber} · {order.pendingRevisions} revisions
              </label>
            ))}
          </div>
          <Button variant="outline" size="sm" disabled={enrollLegacy.isPending || !legacyIds.length}
            onClick={async () => {
              if (await confirmAction({
                title:"Confirm these are historical Stock Transfer Orders? Inventory and vouchers remain unchanged.",
                tone:"default",
              })) enrollLegacy.mutate();
            }}>
            {enrollLegacy.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : null}
            Enable {legacyIds.length} older orders
          </Button>
        </div>
      )}
      <Button className="w-full" disabled={!config.data?.connected || !config.data?.webhookConfigured || !config.data?.executionEnabled || !config.data?.settings.enabled ||
          !config.data?.destinations.some(d => d.id === destinationId && d.chatId && d.enabled) ||
          selectedIds.length === 0 || send.isPending || !!result}
        onClick={() => send.mutate()} data-testid="sto-wa-send-approval-request">
        {send.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin"/> : <ShieldCheck className="h-4 w-4 mr-2"/>}
        Request WhatsApp Approval — {selectedIds.length} Order{selectedIds.length === 1 ? "" : "s"}
      </Button>
      {result && (
        <div className="rounded-md border p-3 space-y-2">
          {result.uncertain && <AlertTriangle className="h-4 w-4 text-amber-600"/>}
          <p className="text-sm font-medium">{result.message}</p>
          {result.batchKey && <p className="font-mono text-xs break-all">Batch: {result.batchKey}</p>}
          <Button variant="outline" size="sm" onClick={() => {setResult(null);setSelectedIds([]);}}>
            Start another request
          </Button>
        </div>
      )}
      {(recent.data?.batches.length || 0) > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Recent approval requests</h4>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {recent.data?.batches.map(batch => (
              <div key={batch.id} className="rounded-md border p-2 flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{batch.destinationName} · {batch.orderCount} orders · {batch.revisionCount} revisions</span>
                  {batch.reviewedByPhone && batch.reviewedAt && (
                    <span className="block text-muted-foreground mt-0.5">
                      {batch.status === "approved" ? "Approved" : "Declined"} by WhatsApp {batch.reviewedByPhone}
                      {" · "}{new Date(batch.reviewedAt).toLocaleString()}
                    </span>
                  )}
                </span>
                <Badge variant="outline">{batch.status}</Badge>
                {config.data?.canConfigure && ["draft", "uncertain", "requested", "stale"].includes(batch.status) &&
                  <Button size="sm" variant="ghost" disabled={cancel.isPending}
                    onClick={async () => {
                      if (await confirmAction({title:"Cancel this approval request? Check WhatsApp delivery first.",tone:"destructive"})) {
                        cancel.mutate(batch.id);
                      }
                    }}>
                    <XCircle className="h-3 w-3 mr-1"/> Cancel
                  </Button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
