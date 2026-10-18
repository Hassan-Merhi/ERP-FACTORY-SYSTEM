import { useState } from "react";
import { format } from "date-fns";
import { CheckCircle2, Loader2, MessageCircle, XCircle } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { getErrorDetails } from "@shared/errorUtils";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { useStockTransferOrderModel } from "./useStockTransferOrderModel";

type Model = ReturnType<typeof useStockTransferOrderModel>;
type Group = { id: number; name: string; chatId: string };
type Settings = { groups: Group[]; connected: boolean };
type SendResult = {
  ok: boolean;
  sent: number;
  failed: number;
  results: { groupId: number; name: string; success: boolean; error?: string }[];
};

export function SendStockTransferWhatsAppDialog({
  model,
  open,
  onOpenChange,
}: {
  model: Model;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [result, setResult] = useState<SendResult | null>(null);
  const url = "/api/stock-transfer-order/whatsapp-groups";
  const groupsQuery = useQuery<Settings>({
    queryKey: [url, selectedCompany?.id],
    queryFn: async () => (await apiRequest("GET", url)).json(),
    enabled: open && !!selectedCompany?.id,
  });
  const send = useMutation({
    mutationFn: async () => {
      const destination = model.locations.find((x) => x.id === model.destinationLocationId);
      if (!destination) throw new Error("Choose a destination first.");
      const response = await apiRequest("POST", "/api/stock-transfer-order/send-whatsapp", {
        groupIds: selectedGroupIds,
        transferDate: format(model.transferDate, "yyyy-MM-dd"),
        destination: destination.name,
        items: model.orderItems.map((x) => ({
          stockItemName: x.stockItemName,
          sourceLocationName: x.sourceLocationName,
          quantity: x.quantity,
        })),
      });
      return response.json() as Promise<SendResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      toast({
        title: data.failed === 0 ? "Transfer export sent" : "WhatsApp delivery incomplete",
        description: "Sent to " + data.sent + " group(s); " + data.failed + " unsuccessful.",
        variant: data.failed === 0 ? "default" : "destructive",
      });
    },
    onError: (error) =>
      toast({ title: "WhatsApp send failed", description: getErrorDetails(error).message, variant: "destructive" }),
  });

  function setOpen(next: boolean) {
    if (send.isPending) return;
    if (next) {
      setSelectedGroupIds([]);
      setResult(null);
    }
    onOpenChange(next);
  }

  function toggle(id: number, checked: boolean) {
    setResult(null);
    setSelectedGroupIds((previous) =>
      checked
        ? previous.includes(id) || previous.length >= 2
          ? previous
          : [...previous, id]
        : previous.filter((x) => x !== id)
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-testid="stock-transfer-wa-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-green-600" />
            Send Transfer to WhatsApp
          </DialogTitle>
          <DialogDescription>
            Send the Stock Transfer Order Excel export <strong>without cost</strong>. Choose one or two groups
            configured in Settings → Export Center.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!groupsQuery.data?.connected && !groupsQuery.isLoading && (
            <p className="text-sm text-amber-600">The main WhatsApp instance is not connected and enabled.</p>
          )}
          {groupsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading saved groups…</p>
          ) : groupsQuery.isError ? (
            <p className="text-sm text-destructive">Unable to load saved WhatsApp groups.</p>
          ) : groupsQuery.data?.groups.length ? (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {groupsQuery.data.groups.map((group) => (
                <label key={group.id} className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-3">
                  <Checkbox
                    checked={selectedGroupIds.includes(group.id)}
                    disabled={send.isPending || (selectedGroupIds.length === 2 && !selectedGroupIds.includes(group.id))}
                    onCheckedChange={(checked) => toggle(group.id, checked === true)}
                    data-testid={"transfer-wa-checkbox-" + group.id}
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{group.name}</div>
                    <div className="text-xs text-muted-foreground">WhatsApp group</div>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No groups configured for this company. Add groups in Settings → Export Center.
            </p>
          )}
          <div className="text-xs text-muted-foreground">
            Selected {selectedGroupIds.length} of 2 maximum. This sends only item names, locations and quantities —
            never rates, prices, amounts or costs.
          </div>
          {result && (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              {result.results.map((group) => (
                <div key={group.groupId} className="flex items-start gap-2">
                  {group.success ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
                  )}
                  <div>
                    <strong>{group.name}:</strong> {group.success ? "Sent" : group.error || "Failed"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={send.isPending} onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            disabled={
              send.isPending ||
              !!result ||
              selectedGroupIds.length < 1 ||
              !groupsQuery.data?.connected ||
              model.orderItems.length === 0 ||
              !model.destinationLocationId
            }
            onClick={() => send.mutate()}
            data-testid="transfer-wa-send-selected"
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <MessageCircle className="h-4 w-4 mr-2" />
            )}
            Send to {selectedGroupIds.length || ""} Group{selectedGroupIds.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
