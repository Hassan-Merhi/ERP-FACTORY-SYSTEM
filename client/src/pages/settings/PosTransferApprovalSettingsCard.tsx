import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck, MessageCircle, Save, Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";

type ApprovalSettings = {
  userId: string | null;
  groupId: number | null;
  users: Array<{ id: string; username: string }>;
  groups: Array<{ id: number; name: string }>;
};

type DeliveryHealth = {
  delegateConfigured: boolean;
  groupConfigured: boolean;
  groupName: string | null;
  groupVisible: boolean | null;
  whatsappState: string;
  ready: boolean;
  note: string;
};

export function PosTransferApprovalSettingsCard() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [userChoice, setUserChoice] = useState<string | null>(null);
  const [groupChoice, setGroupChoice] = useState<string | null>(null);
  useEffect(() => {
    setUserChoice(null);
    setGroupChoice(null);
    setHealth(null);
  }, [selectedCompany?.id]);
  const url = "/api/settings/pos-transfer-approval";
  const key = [url, selectedCompany?.id];
  const settings = useQuery<ApprovalSettings>({
    queryKey: key,
    enabled: !!selectedCompany?.id,
    retry: false,
    queryFn: async () => {
      const response = await apiRequest("GET", url);
      if (!response.ok) throw new Error("Could not load POS transfer approval settings.");
      return response.json();
    },
  });
  const [health, setHealth] = useState<DeliveryHealth | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const checkDelivery = async () => {
    setHealth(null);
    setCheckingHealth(true);
    try {
      const response = await apiRequest("GET", "/api/settings/pos-transfer-approval/delivery-health");
      if (!response.ok) throw new Error("Could not check WhatsApp connection.");
      const result: DeliveryHealth = await response.json();
      setHealth(result);
    } catch (error) {
      toast({ title: "Connection check failed", description: error instanceof Error ? error.message : "Connection unavailable.", variant: "destructive" });
    } finally {
      setCheckingHealth(false);
    }
  };
  const userId = userChoice ?? (settings.data?.userId || "none");
  const groupId = groupChoice ?? (settings.data?.groupId ? String(settings.data.groupId) : "none");
  const save = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PUT", url, {
        userId: userId === "none" ? null : userId,
        groupId: groupId === "none" ? null : Number(groupId),
      });
      if (!response.ok) throw new Error("Could not save the approval delegate.");
      return response.json();
    },
    onSuccess: () => {
      setHealth(null);
      setUserChoice(null);
      setGroupChoice(null);
      queryClient.invalidateQueries({ queryKey: key });
      toast({ title: "POS approval delegate saved", description: "Only the selected POS user can approve and automatically send transfer revisions." });
    },
    onError: (error: Error) => {
      if ((error as Error & { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Could not save", description: error.message, variant: "destructive" });
    },
  });
  // This control is for administrators; other roles receive a 403 from the API.
  if (settings.isError) return null;
  return (
    <Card className="space-y-4 p-5" data-testid="pos-transfer-delegate-settings">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-blue-500/10 p-2.5"><ShieldCheck className="h-5 w-5 text-blue-500" /></div>
        <div>
          <h3 className="font-semibold">Stock Transfer Revision Approver</h3>
          <p className="text-sm text-muted-foreground">
            Assign one POS user in this company to approve pending stock transfer revisions without opening the changes.
            Approval automatically sends the updated stock transfer Excel without costs or prices to the selected WhatsApp group.
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Authorized POS user</label>
          <Select value={userId} onValueChange={setUserChoice} disabled={settings.isLoading || save.isPending}>
            <SelectTrigger data-testid="select-pos-transfer-approver"><SelectValue placeholder="Choose a POS user" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — disable approval</SelectItem>
              {settings.data?.users.map((user) => <SelectItem key={user.id} value={user.id}>{user.username}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium"><MessageCircle className="h-4 w-4" /> Send approved orders to</label>
          <Select value={groupId} onValueChange={setGroupChoice} disabled={settings.isLoading || save.isPending}>
            <SelectTrigger data-testid="select-pos-transfer-group"><SelectValue placeholder="Choose a WhatsApp group" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — configure later</SelectItem>
              {settings.data?.groups.map((group) => <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Add WhatsApp groups first in Settings → Export Center. The delegate cannot approve until a group is selected and WhatsApp is connected. This does not grant access to other ERP administration screens.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={checkDelivery} disabled={checkingHealth || settings.isLoading || save.isPending} data-testid="check-pos-transfer-whatsapp-health">
          <Activity className="mr-2 h-4 w-4" />
          {checkingHealth ? "Checking connection…" : "Check WhatsApp connection"}
        </Button>
        <Button onClick={() => save.mutate()} disabled={settings.isLoading || save.isPending} data-testid="save-pos-transfer-approver">
          <Save className="mr-2 h-4 w-4" /> {save.isPending ? "Saving…" : "Save delegate"}
        </Button>
      </div>
      {health && (
        <div className="space-y-1 border-t pt-3 text-sm" role="status" data-testid="pos-transfer-whatsapp-health-result">
          <p className={health.ready ? "font-medium text-green-600" : "font-medium text-amber-600"}>
            {health.ready ? "Ready for approval-to-WhatsApp" : "Not ready for approval-to-WhatsApp"}
          </p>
          <p>WhatsApp: {health.whatsappState} · Group: {health.groupName || "Not configured"} · Group visible: {health.groupVisible === null ? "Unverified" : health.groupVisible ? "Yes" : "No"} · POS delegate: {health.delegateConfigured ? "Assigned" : "Not assigned"}</p>
          <p className="text-xs text-muted-foreground">{health.note}</p>
        </div>
      )}
    </Card>
  );
}