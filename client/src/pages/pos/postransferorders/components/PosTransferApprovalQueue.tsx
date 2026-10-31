import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCheck, Clock, MessageCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";

type PendingVoucher = {
  transferId: number;
  voucherNumber: string;
  pendingRevisionCount: number;
};
type DestinationOrder = {
  destinationId: number;
  destinationName: string;
  transferCount: number;
  pendingRevisionCount: number;
  transfers: PendingVoucher[];
};
type Queue = { enabled: boolean; needsGroup?: boolean; destinations: DestinationOrder[] };
type ApprovalResult = {
  approved: number;
  total: number;
  sent: boolean;
  failures: Array<{ voucherNumber: string; message: string }>;
  message: string;
};

export function PosTransferApprovalQueue() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [excludedIds, setExcludedIds] = useState<Set<number>>(() => new Set());
  const url = "/api/pos-transfer-approval/queue";
  const key = [url, selectedCompany?.id];
  const queue = useQuery<Queue>({
    queryKey: key,
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const response = await apiRequest("GET", url);
      if (!response.ok) throw new Error("Could not load stock-transfer approvals.");
      return response.json();
    },
    refetchInterval: 30000,
  });
  const approve = useMutation({
    mutationFn: async (group: { destinationId: number; transferIds: number[] }) => {
      const response = await apiRequest(
        "POST",
        "/api/pos-transfer-approval/destination/" + group.destinationId + "/approve-send",
        { transferIds: group.transferIds }
      );
      const result: ApprovalResult = await response.json();
      if (!response.ok) throw new Error(result.message || "Approval failed.");
      return result;
    },
    onSuccess: (result) => {
      const fullyApproved = result.approved === result.total && result.failures.length === 0;
      toast({
        title: fullyApproved && result.sent ? "Approved and sent" : "Approval needs attention",
        description: result.message,
        variant: fullyApproved && result.sent ? "default" : "destructive",
      });
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
    },
    onError: (error: Error) => {
      if ((error as Error & { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Could not approve", description: error.message, variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
  if (!queue.data?.enabled) return null;
  const destinations = queue.data.destinations;
  const pending = destinations.reduce((sum, destination) => sum + destination.transferCount, 0);

  return (
    <Card className="overflow-hidden border-blue-500/30" data-testid="pos-transfer-approval-queue">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-blue-500/5 p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-blue-500" />
          <div>
            <h3 className="font-semibold">Approve Stock Transfer Orders</h3>
            <p className="text-xs text-muted-foreground">
              One approval for all pending transfer vouchers to each destination.
              Send one combined WhatsApp Excel without costs.
            </p>
          </div>
        </div>
        <Badge variant="secondary">{destinations.length} destinations · {pending} transfers</Badge>
      </div>
      {destinations.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No pending transfer orders to approve.</p>
      ) : (
        <div className="divide-y">
          {destinations.map((destination) => {
            const included = destination.transfers.filter((transfer) => !excludedIds.has(transfer.transferId));
            return (
            <div key={destination.destinationId} className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
              <Clock className="h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{destination.destinationName}</p>
                <p className="text-xs text-muted-foreground">
                  {destination.transferCount} {destination.transferCount === 1 ? "transfer" : "transfers"}
                  {" · "}{destination.pendingRevisionCount} pending{" "}
                  {destination.pendingRevisionCount === 1 ? "revision" : "revisions"}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {destination.transfers.map((transfer) => (
                    <label key={transfer.transferId} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox
                        checked={!excludedIds.has(transfer.transferId)}
                        disabled={approve.isPending}
                        onCheckedChange={(checked) => {
                          setExcludedIds((previous) => {
                            const next = new Set(previous);
                            if (checked === true) next.delete(transfer.transferId);
                            else next.add(transfer.transferId);
                            return next;
                          });
                        }}
                        aria-label={"Include " + transfer.voucherNumber}
                      />
                      {transfer.voucherNumber}
                    </label>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                className="min-h-10 gap-1.5"
                onClick={() => approve.mutate({
                  destinationId: destination.destinationId,
                  transferIds: included.map((transfer) => transfer.transferId),
                })}
                disabled={approve.isPending || included.length === 0}
                data-testid={"approve-send-destination-" + destination.destinationId}
              >
                <CheckCheck className="h-4 w-4" />
                {approve.isPending && approve.variables?.destinationId === destination.destinationId
                  ? "Approving & Sending…"
                  : "Approve All & Send"}
                <MessageCircle className="h-4 w-4" />
              </Button>
            </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
