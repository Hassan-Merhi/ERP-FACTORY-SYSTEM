/** Stock Transfer Order WhatsApp approval settings. No ordinary transfer settings are affected. */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck, Loader2, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getErrorDetails } from "@shared/errorUtils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const endpoint = "/api/stock-transfer-order/wa-approval/settings";
export type StockTransferOrderWaSettings = {
  settings: { enabled: boolean; approvalGroupChatId: string | null; authorizedPhoneE164: string | null };
  connected: boolean;
  webhookConfigured: boolean;
  executionEnabled: boolean;
  deliveryEnabled: boolean;
  canConfigure: boolean;
  groups: Array<{ id: number; name: string; chatId: string }>;
  destinations: Array<{ id: number; name: string; chatId: string | null; enabled: boolean }>;
};

function DestinationRecipient({ destination, groups, canConfigure }: {
  destination: StockTransferOrderWaSettings["destinations"][number];
  groups: StockTransferOrderWaSettings["groups"];
  canConfigure: boolean;
}) {
  const { toast } = useToast();
  const [chatId, setChatId] = useState(destination.chatId || "");
  const [enabled, setEnabled] = useState(destination.enabled);
  useEffect(() => { setChatId(destination.chatId || ""); setEnabled(destination.enabled); },
    [destination.id, destination.chatId, destination.enabled]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PUT",
        "/api/stock-transfer-order/wa-approval/destinations/" + destination.id, { chatId: chatId.trim(), enabled });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [endpoint] });
      toast({ title: destination.name + " recipient saved" });
    },
    onError: error => toast({
      title: "Could not save destination", description: getErrorDetails(error).message, variant: "destructive",
    }),
  });
  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid={"sto-wa-destination-" + destination.id}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-sm">{destination.name}</span>
        <div className="flex items-center gap-2">
          <Label className="text-xs" htmlFor={"sto-wa-dest-enable-" + destination.id}>Enabled</Label>
          <Switch id={"sto-wa-dest-enable-" + destination.id} checked={enabled} disabled={!canConfigure} onCheckedChange={setEnabled}/>
        </div>
      </div>
      <Select value={groups.some(g => g.chatId === chatId) ? chatId : ""} disabled={!canConfigure} onValueChange={setChatId}>
        <SelectTrigger><SelectValue placeholder="Select saved WhatsApp group (optional)" /></SelectTrigger>
        <SelectContent>{groups.map(g => (
          <SelectItem key={g.id} value={g.chatId}>{g.name}</SelectItem>
        ))}</SelectContent>
      </Select>
      <Input value={chatId} disabled={!canConfigure} onChange={e => setChatId(e.target.value)}
        placeholder="WhatsApp group ID or international number@c.us" aria-label={destination.name + " WhatsApp recipient"}/>
      <Button size="sm" variant="outline" disabled={!canConfigure || save.isPending || !chatId.trim()} onClick={() => save.mutate()}>
        {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Save className="mr-2 h-4 w-4"/>}
        Save recipient
      </Button>
    </div>
  );
}

export function StockTransferOrderApprovalSettings() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [group, setGroup] = useState("");
  const [phone, setPhone] = useState("");

  const settings = useQuery<StockTransferOrderWaSettings>({
    queryKey: [endpoint, selectedCompany?.id],
    queryFn: async () => (await apiRequest("GET", endpoint)).json(),
    enabled: !!selectedCompany?.id,
  });
  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.settings.enabled);
    setGroup(settings.data.settings.approvalGroupChatId || "");
    setPhone(settings.data.settings.authorizedPhoneE164 || "");
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PUT", endpoint, {
        enabled, approvalGroupChatId: group, authorizedPhoneE164: phone.trim(),
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [endpoint] });
      toast({ title: "Stock Transfer Order approval settings saved" });
    },
    onError: error => toast({
      title: "Approval settings not saved", description: getErrorDetails(error).message, variant: "destructive",
    }),
  });
  return (
    <Card data-testid="stock-transfer-order-wa-approval-settings">
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-green-600"/> Stock Transfer Order — WhatsApp Approval
        </CardTitle>
        <CardDescription>
          Configure the approval group, a single authorized replying phone number, and the WhatsApp
          recipient linked to each destination. Only saved Stock Transfer Orders are eligible.
          A verified DONE approves the complete selected order batch. Final Excel delivery to both WhatsApp recipients is tracked separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.isError ? <p className="text-sm text-destructive">Could not load approval settings.</p> :
         settings.isLoading ? <p className="text-sm text-muted-foreground">Loading approval settings…</p> : (
          <>
            <Badge variant={settings.data?.connected ? "secondary" : "outline"}>
              {settings.data?.connected ? "Main WhatsApp configured" : "Main WhatsApp not enabled"}
            </Badge>
            <Badge variant={settings.data?.webhookConfigured ? "secondary" : "outline"}>
              {settings.data?.webhookConfigured ? "Protected inbound webhook configured" : "Webhook token not configured"}
            </Badge>
            <Badge variant={settings.data?.executionEnabled ? "secondary" : "outline"}>
              {settings.data?.executionEnabled ? "Automatic batch approval processor enabled" : "Automatic batch approval processor paused"}
            </Badge>
            <Badge variant={settings.data?.deliveryEnabled ? "secondary" : "outline"}>
              {settings.data?.deliveryEnabled ? "Final Excel delivery worker enabled" : "Final Excel delivery paused"}
            </Badge>
            {!settings.data?.webhookConfigured && (
              <p className="text-xs text-amber-600">
                Set STO_WA_GREEN_API_WEBHOOK_TOKEN on the ERP server and configure Green API
                webhookUrlToken using Bearer authentication before sending requests.
              </p>
            )}
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <Label htmlFor="sto-wa-enabled">Enable requesting Stock Transfer Order approvals</Label>
              <Switch id="sto-wa-enabled" checked={enabled} disabled={!settings.data?.canConfigure} onCheckedChange={setEnabled}/>
            </div>
            <div className="space-y-2">
              <Label>WhatsApp approval group</Label>
              <Select value={group} disabled={!settings.data?.canConfigure} onValueChange={setGroup}>
                <SelectTrigger data-testid="sto-wa-approval-group">
                  <SelectValue placeholder="Choose a linked WhatsApp group"/>
                </SelectTrigger>
                <SelectContent>{(settings.data?.groups || []).map(g => (
                  <SelectItem key={g.id} value={g.chatId}>{g.name}</SelectItem>
                ))}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sto-wa-authorized-phone">Authorized WhatsApp number (international)</Label>
              <Input id="sto-wa-authorized-phone" value={phone} onChange={e => setPhone(e.target.value)}
                placeholder="+961XXXXXXXX" disabled={!settings.data?.canConfigure} data-testid="sto-wa-authorized-phone"/>
            </div>
            <Button disabled={!settings.data?.canConfigure || save.isPending || (enabled && (!group || !phone.trim()))}
              onClick={() => save.mutate()} data-testid="sto-wa-save-settings">
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Save className="mr-2 h-4 w-4"/>}
              Save approval settings
            </Button>
            <div className="space-y-2">
              <h4 className="font-medium text-sm">Destination WhatsApp recipients</h4>
              <p className="text-xs text-muted-foreground">
                After full-batch approval, the same cost-free Excel is automatically sent to the
                approval group and this destination recipient. Use a group ID ending @g.us or a phone ending @c.us.
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {(settings.data?.destinations || []).map(destination => (
                  <DestinationRecipient key={destination.id} destination={destination}
                    groups={settings.data?.groups || []} canConfigure={!!settings.data?.canConfigure}/>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
