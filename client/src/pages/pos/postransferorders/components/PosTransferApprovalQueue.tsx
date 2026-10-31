import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCheck, Clock, MessageCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";

type PendingRevision = {
  id: number;
  revisionNumber: number;
  voucherNumber: string;
  destinationName: string;
  createdAt: string;
};
type Queue = { enabled: boolean; needsGroup?: boolean; revisions: PendingRevision[] };
type Result = { approved: boolean; sent: boolean; message: string };

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
      if (!response.ok) throw new Error("Could not load revision approvals.");
      return response.json();
    },
    refetchInterval: 30000,
  });
  const approve = useMutation({
    mutationFn: async (revisionId: number) => {
      const response = await apiRequest("POST", "/api/pos-transfer-approval/" + revisionId + "/approve-send", {});
      const result: Result = await response.json();
      if (!response.ok) throw new Error(result.message || "Approval failed.");
      return result;
    },
    onSuccess: (result) => {
      toast({
        title: result.sent ? "Approved and sent" : "Approved — WhatsApp not sent",
        description: result.message,
        variant: result.sent ? "default" : "destructive",
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

  return (
    <Card className="overflow-hidden border-blue-500/30" data-testid="pos-transfer-approval-queue">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-blue-500/5 p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-blue-500" />
          <div>
            <h3 className="font-semibold">Approve Stock Transfer Revisions</h3>
            <p className="text-xs text-muted-foreground">One-click approval and automatic cost-free WhatsApp Excel delivery</p>
          </div>
        </div>
        <Badge variant="secondary">{queue.data.revisions.length} pending</Badge>
      </div>
      {queue.data.revisions.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No pending revisions to approve.</p>
      ) : (
        <div className="divide-y">
          {queue.data.revisions.map((revision) => (
            <div key={revision.id} className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
              <Clock className="h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{revision.voucherNumber} · Rev {revision.revisionNumber}</p>
                <p className="text-xs text-muted-foreground">To {revision.destinationName} · Pending approval</p>
              </div>
              <Button
                size="sm"
                className="min-h-10 gap-1.5"
                onClick={() => approve.mutate(revision.id)}
                disabled={approve.isPending}
                data-testid={"approve-send-transfer-revision-" + revision.id}
              >
                <CheckCheck className="h-4 w-4" />
                Approve &amp; Send
                <MessageCircle className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}