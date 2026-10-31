import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCheck, Clock, MessageCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
    mutationFn: async (destinationId: number) => {
      const response = await apiRequest(
        "POST",
        "/api/pos-transfer-approval/destination/" + destinationId + "/approve-send",
        {}
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
          {destinations.map((destination) => (
            <div key={destination.destinationId} className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
              <Clock className="h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{destination.destinationName}</p>
                <p className="text-xs text-muted-foreground">
                  {destination.transferCount} {destination.transferCount === 1 ? "transfer" : "transfers"}
                  {" · "}{destination.pendingRevisionCount} pending{" "}
                  {destination.pendingRevisionCount === 1 ? "revision" : "revisions"}
                </p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {destination.transfers.map((transfer) => transfer.voucherNumber).join(" · ")}
                </p>
              </div>
              <Button
                size="sm"
                className="min-h-10 gap-1.5"
                onClick={() => approve.mutate(destination.destinationId)}
                disabled={approve.isPending}
                data-testid={"approve-send-destination-" + destination.destinationId}
              >
                <CheckCheck className="h-4 w-4" />
                {approve.isPending && approve.variables === destination.destinationId
                  ? "Approving & Sending…"
                  : "Approve All & Send"}
                <MessageCircle className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
