// Extracted from ./PosWhatsAppSection.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";
import type { InstanceState, Location, PosInstanceSettings, WaChat } from "./PosWhatsAppSectionInstanceStateBadge";

export function usePosWhatsAppSectionState() {
  const { toast } = useToast();

  // ── Credentials state ──
  const [instanceId, setInstanceId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [credsDirty, setCredsDirty] = useState(false);
  const [checkStateEnabled, setCheckStateEnabled] = useState(false);

  // ── Group picker dialog state ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string>("");
  const [chatSearch, setChatSearch] = useState("");

  // ── Queries ──
  const { data: posSettings, isLoading: settingsLoading } = useQuery<PosInstanceSettings>({
    queryKey: ["/api/whatsapp/settings/pos"],
  });

  const {
    data: instanceStateData,
    isLoading: instanceStateLoading,
    refetch: refetchInstanceState,
  } = useQuery<{ state: InstanceState }>({
    queryKey: ["/api/whatsapp/instance-state/pos"],
    enabled: checkStateEnabled,
    staleTime: 10_000,
    retry: false,
  });

  useEffect(() => {
    if (posSettings && !credsDirty) {
      setInstanceId(posSettings.instanceId ?? "");
      setApiToken(posSettings.apiToken ?? "");
      setEnabled(posSettings.enabled ?? true);
    }
  }, [posSettings, credsDirty]);

  const { data: locations = [], isLoading: locLoading } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const {
    data: waChats = [],
    isLoading: chatsLoading,
    isError: chatsError,
    error: chatsErrorDetail,
    refetch: refetchChats,
  } = useQuery<WaChat[]>({
    queryKey: ["/api/whatsapp/chats/pos"],
    enabled: dialogOpen,
    staleTime: 60_000,
    retry: false,
  });

  // ── Mutations ──
  const saveCredsMutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/whatsapp/settings/pos", { instanceId, apiToken, enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/settings/pos"] });
      setCredsDirty(false);
      setShowToken(false);
      toast({ title: "POS WhatsApp API saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saveGroupMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      whatsappGroupChatId,
    }: {
      id: number;
      name: string;
      whatsappGroupChatId: string | null;
    }) => {
      const res = await apiRequest("PATCH", `/api/locations/${id}`, { name, whatsappGroupChatId });
      return res.json();
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({
        title: updated.whatsappGroupChatId ? "Group linked" : "Group removed",
        description: updated.whatsappGroupChatId
          ? `"${updated.name}" will now receive shift reports.`
          : `WhatsApp group removed from "${updated.name}".`,
      });
      setDialogOpen(false);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // ── Handlers ──
  function openDialog(loc: Location) {
    setEditingLocation(loc);
    setSelectedChatId(loc.whatsappGroupChatId ?? "");
    setChatSearch("");
    setDialogOpen(true);
  }
  return {
    apiToken,
    chatSearch,
    chatsError,
    chatsErrorDetail,
    chatsLoading,
    checkStateEnabled,
    credsDirty,
    dialogOpen,
    editingLocation,
    enabled,
    instanceId,
    instanceStateData,
    instanceStateLoading,
    locLoading,
    locations,
    openDialog,
    posSettings,
    refetchChats,
    refetchInstanceState,
    saveCredsMutation,
    saveGroupMutation,
    selectedChatId,
    setApiToken,
    setChatSearch,
    setCheckStateEnabled,
    setCredsDirty,
    setDialogOpen,
    setEnabled,
    setInstanceId,
    setSelectedChatId,
    setShowToken,
    settingsLoading,
    showToken,
    waChats,
  };
}

export function PosWhatsAppSectionCardContentSection({
  apiToken,
  credsDirty,
  enabled,
  instanceId,
  saveCredsMutation,
  setApiToken,
  setCredsDirty,
  setEnabled,
  setInstanceId,
  setShowToken,
  showToken,
}: Pick<
  ReturnType<typeof usePosWhatsAppSectionState>,
  | "apiToken"
  | "credsDirty"
  | "enabled"
  | "instanceId"
  | "saveCredsMutation"
  | "setApiToken"
  | "setCredsDirty"
  | "setEnabled"
  | "setInstanceId"
  | "setShowToken"
  | "showToken"
>) {
  return (
    <CardContent className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="pos-instance-id">Instance ID</Label>
          <Input
            id="pos-instance-id"
            placeholder="e.g. 7105123456789"
            value={instanceId}
            onChange={(e) => {
              setInstanceId(e.target.value);
              setCredsDirty(true);
            }}
            data-testid="input-pos-instance-id"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pos-api-token">API Token</Label>
          <div className="relative">
            <Input
              id="pos-api-token"
              type={showToken ? "text" : "password"}
              placeholder="API token from Green API"
              value={apiToken}
              onChange={(e) => {
                setApiToken(e.target.value);
                setCredsDirty(true);
              }}
              className="pr-10"
              data-testid="input-pos-api-token"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              data-testid="button-toggle-token-visibility"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 pt-1">
        <div className="flex items-center gap-2">
          <Switch
            id="pos-wa-enabled"
            checked={enabled}
            onCheckedChange={(v) => {
              setEnabled(v);
              setCredsDirty(true);
            }}
            data-testid="switch-pos-wa-enabled"
          />
          <Label htmlFor="pos-wa-enabled" className="text-sm cursor-pointer">
            Sending enabled
          </Label>
        </div>
        <Button
          size="sm"
          onClick={() => saveCredsMutation.mutate()}
          disabled={saveCredsMutation.isPending || !credsDirty}
          data-testid="button-save-pos-creds"
        >
          {saveCredsMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Save className="h-3.5 w-3.5 mr-1.5" />
          )}
          Save Credentials
        </Button>
      </div>
    </CardContent>
  );
}
