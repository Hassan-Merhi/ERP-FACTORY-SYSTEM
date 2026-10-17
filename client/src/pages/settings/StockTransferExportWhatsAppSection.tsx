import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { MessageCircle, Plus, Trash2, RefreshCw, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getErrorDetails } from "@shared/errorUtils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

type WaGroup = { id: number; name: string; chatId: string };
type GroupSettings = { groups: WaGroup[]; connected: boolean };
type WhatsAppChat = { id: string; name: string; type: string };
const endpoint = "/api/stock-transfer-order/whatsapp-groups";

export function StockTransferExportWhatsAppSection() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [chatId, setChatId] = useState("");
  const [groupName, setGroupName] = useState("");

  const groupQuery = useQuery<GroupSettings>({
    queryKey: [endpoint, selectedCompany?.id],
    queryFn: async () => (await apiRequest("GET", endpoint)).json(),
    enabled: !!selectedCompany?.id,
  });
  const chatQuery = useQuery<WhatsAppChat[]>({
    queryKey: ["/api/whatsapp/chats", "transfer-export"],
    queryFn: async () => (await apiRequest("GET", "/api/whatsapp/chats")).json(),
    enabled: false,
    retry: false,
  });
  const chats = (chatQuery.data ?? []).filter((c) => c.type === "group" || c.id.endsWith("@g.us"));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [endpoint] });
  const saveGroup = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", endpoint, { chatId, name: groupName.trim() });
      return r.json();
    },
    onSuccess: () => {
      invalidate();
      setChatId("");
      setGroupName("");
      toast({ title: "WhatsApp group saved" });
    },
    onError: (error) => toast({ title: "Could not save group", description: getErrorDetails(error).message, variant: "destructive" }),
  });
  const removeGroup = useMutation({
    mutationFn: (groupId: number) => apiRequest("DELETE", endpoint + "/" + groupId),
    onSuccess: () => {
      invalidate();
      toast({ title: "WhatsApp group removed" });
    },
    onError: (error) => toast({ title: "Could not remove group", description: getErrorDetails(error).message, variant: "destructive" }),
  });

  function chooseChat(nextId: string) {
    setChatId(nextId);
    const found = chats.find((x) => x.id === nextId);
    if (found) setGroupName(found.name);
  }

  return (
    <Card data-testid="stock-transfer-export-whatsapp-settings">
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="h-4 w-4 text-green-600" />
          Stock Transfer Order — Export to WhatsApp
        </CardTitle>
        <CardDescription>
          Connect groups for this company. When exporting a transfer without cost, choose one or two groups to receive
          the Excel file. This is separate from automatic transfer notifications.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant={groupQuery.data?.connected ? "secondary" : "outline"}>
            {groupQuery.data?.connected ? "WhatsApp connected" : "WhatsApp not enabled"}
          </Badge>
          <span className="text-muted-foreground">Uses the main Green API instance from Settings → Export Center.</span>
        </div>
        <div className="space-y-2">
          <Label>Saved WhatsApp groups for {selectedCompany?.name || "current company"}</Label>
          {groupQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading groups…</p> :
            groupQuery.isError ? <p className="text-sm text-destructive">Unable to load groups. Check the connection.</p> :
            (groupQuery.data?.groups.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">No groups linked yet.</p> :
            <div className="space-y-2">
              {groupQuery.data?.groups.map((group) => (
                <div key={group.id} className="flex items-center justify-between gap-3 rounded-md border p-2.5" data-testid={"transfer-export-saved-group-" + group.id}>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{group.name}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate">{group.chatId}</div>
                  </div>
                  <Button size="icon" variant="ghost" title={"Remove " + group.name}
                    disabled={removeGroup.isPending} onClick={() => removeGroup.mutate(group.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          }
        </div>
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <Label>Add a WhatsApp group</Label>
            <Button variant="outline" size="sm" onClick={() => chatQuery.refetch()} disabled={chatQuery.isFetching || !groupQuery.data?.connected}
              data-testid="transfer-export-load-wa-groups">
              {chatQuery.isFetching ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Load groups
            </Button>
          </div>
          <Select value={chatId} onValueChange={chooseChat}>
            <SelectTrigger data-testid="transfer-export-select-wa-group">
              <SelectValue placeholder="Choose a WhatsApp group" />
            </SelectTrigger>
            <SelectContent>
              {chats.map((chat) => <SelectItem key={chat.id} value={chat.id}>{chat.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {chatQuery.isError && <p className="text-xs text-destructive">Could not load WhatsApp groups. Check your Green API connection.</p>}
          <Input placeholder="Group label (editable)" value={groupName} onChange={(e) => setGroupName(e.target.value)}
            maxLength={100} data-testid="transfer-export-group-label" />
          <Button onClick={() => saveGroup.mutate()} disabled={!chatId || !groupName.trim() || saveGroup.isPending}
            data-testid="transfer-export-save-wa-group">
            {saveGroup.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Add group
          </Button>
          <p className="text-xs text-muted-foreground">
            You can save several groups here; each send lets you select a maximum of two. No costs or pricing are sent.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
