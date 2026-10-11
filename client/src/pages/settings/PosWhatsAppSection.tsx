import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  MessageCircle,
  Search,
  Check,
  X,
  Loader2,
  Users,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Moon,
  Save,
  Eye,
  EyeOff,
} from "lucide-react";

interface Location {
  id: number;
  name: string;
  whatsappGroupChatId?: string | null;
}

interface WaChat {
  id: string;
  name: string;
  type: string;
}

interface PosInstanceSettings {
  instanceId: string;
  apiToken: string;
  enabled: boolean;
  hasCredentials: boolean;
}

type InstanceState =
  "authorized" | "notAuthorized" | "sleepMode" | "starting" | "yellowCard" | "notConfigured" | "unknown";

function InstanceStateBadge({ state, loading }: { state: InstanceState | undefined; loading: boolean }) {
  if (loading) {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-instance-state">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </Badge>
    );
  }
  if (!state) return null;
  if (state === "authorized") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300"
        data-testid="badge-instance-state"
      >
        <CheckCircle className="h-3 w-3" />
        Authorized
      </Badge>
    );
  }
  if (state === "sleepMode") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300"
        data-testid="badge-instance-state"
      >
        <Moon className="h-3 w-3" />
        Sleeping — messages won't send
      </Badge>
    );
  }
  if (state === "notAuthorized") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300"
        data-testid="badge-instance-state"
      >
        <XCircle className="h-3 w-3" />
        Not authorized — scan QR code
      </Badge>
    );
  }
  if (state === "yellowCard") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-orange-700 bg-orange-100 dark:bg-orange-950 dark:text-orange-300"
        data-testid="badge-instance-state"
      >
        <AlertTriangle className="h-3 w-3" />
        Warning — account at risk
      </Badge>
    );
  }
  if (state === "starting") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300"
        data-testid="badge-instance-state"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Starting up…
      </Badge>
    );
  }
  if (state === "notConfigured") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-instance-state">
        <XCircle className="h-3 w-3 text-muted-foreground" />
        Not configured
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1" data-testid="badge-instance-state">
      <XCircle className="h-3 w-3 text-muted-foreground" />
      Unknown
    </Badge>
  );
}

export function PosWhatsAppSection() {
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

  function handleSaveGroup() {
    if (!editingLocation) return;
    saveGroupMutation.mutate({
      id: editingLocation.id,
      name: editingLocation.name,
      whatsappGroupChatId: selectedChatId || null,
    });
  }

  const filteredChats = waChats
    .filter((c) => c.type === "group")
    .filter((c) => c.name.toLowerCase().includes(chatSearch.toLowerCase()));

  const configuredCount = locations.filter((l) => l.whatsappGroupChatId).length;
  const isConfigured = posSettings?.hasCredentials;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            <h2 className="text-2xl font-semibold">POS WhatsApp Groups</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            Configure a dedicated Green API instance for POS shift reports, then assign a group to each location.
          </p>
        </div>
        {configuredCount > 0 && (
          <Badge variant="secondary" data-testid="badge-configured-count">
            <Users className="h-3 w-3 mr-1" />
            {configuredCount} of {locations.length} configured
          </Badge>
        )}
      </div>

      {/* ── API Credentials card ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base">POS Green API Instance</CardTitle>
              <CardDescription className="mt-0.5">
                This is a separate API instance used only for POS shift report messages. If left blank, the main
                WhatsApp API instance will be used as a fallback.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {instanceStateData ? (
                <InstanceStateBadge state={instanceStateData.state} loading={instanceStateLoading} />
              ) : settingsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : isConfigured ? (
                <Badge variant="secondary" className="gap-1" data-testid="badge-pos-api-status">
                  <CheckCircle className="h-3 w-3 text-muted-foreground" />
                  Credentials saved
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1" data-testid="badge-pos-api-status">
                  <XCircle className="h-3 w-3 text-muted-foreground" />
                  Not configured
                </Badge>
              )}
              {isConfigured && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCheckStateEnabled(true);
                    refetchInstanceState();
                  }}
                  disabled={instanceStateLoading}
                  data-testid="button-check-instance-state"
                >
                  {instanceStateLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Check Status
                </Button>
              )}
            </div>
          </div>
          {instanceStateData?.state === "sleepMode" && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 bg-amber-50 dark:bg-amber-950/40 rounded-sm px-2 py-1.5">
              Your Green API instance is in sleep mode. Log in to{" "}
              <a
                href="https://console.green-api.com"
                target="_blank"
                rel="noreferrer"
                className="underline font-medium"
              >
                console.green-api.com
              </a>{" "}
              and wake up your instance — messages are queued but not delivered while asleep.
            </p>
          )}
          {instanceStateData?.state === "notAuthorized" && (
            <p className="text-xs text-red-700 dark:text-red-400 mt-2 bg-red-50 dark:bg-red-950/40 rounded-sm px-2 py-1.5">
              Your WhatsApp session has expired. Go to{" "}
              <a
                href="https://console.green-api.com"
                target="_blank"
                rel="noreferrer"
                className="underline font-medium"
              >
                console.green-api.com
              </a>{" "}
              and scan the QR code to reconnect.
            </p>
          )}
        </CardHeader>
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
      </Card>

      <Separator />

      {/* ── Location group assignments ── */}
      <div>
        <h3 className="text-base font-semibold mb-1">Location Group Assignments</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Assign a WhatsApp group to each POS location. Reports are sent when a shift ends with low stock.
        </p>

        {locLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading locations…
          </div>
        ) : locations.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">No POS locations found.</p>
        ) : (
          <div className="space-y-2">
            {locations.map((loc) => {
              const chatId = loc.whatsappGroupChatId;
              return (
                <div
                  key={loc.id}
                  className="flex items-center justify-between gap-4 rounded-md border bg-card px-4 py-3 flex-wrap"
                  data-testid={`row-location-${loc.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`h-2 w-2 rounded-full shrink-0 ${chatId ? "bg-green-500" : "bg-muted-foreground/40"}`}
                    />
                    <div className="min-w-0">
                      <p className="font-medium text-sm leading-tight" data-testid={`text-location-name-${loc.id}`}>
                        {loc.name}
                      </p>
                      {chatId ? (
                        <p
                          className="text-xs text-muted-foreground font-mono truncate mt-0.5"
                          data-testid={`text-chat-id-${loc.id}`}
                        >
                          {chatId}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-0.5">No group configured</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {chatId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saveGroupMutation.isPending}
                        onClick={() =>
                          saveGroupMutation.mutate({ id: loc.id, name: loc.name, whatsappGroupChatId: null })
                        }
                        data-testid={`button-remove-group-${loc.id}`}
                      >
                        <X className="h-3.5 w-3.5 mr-1" />
                        Remove
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openDialog(loc)}
                      data-testid={`button-set-group-${loc.id}`}
                    >
                      <MessageCircle
                        className={`h-3.5 w-3.5 mr-1.5 ${chatId ? "text-green-600 dark:text-green-400" : ""}`}
                      />
                      {chatId ? "Change Group" : "Set Group"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Group picker dialog ── */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) setDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set WhatsApp Group</DialogTitle>
            <DialogDescription>
              Choose the group for <strong>{editingLocation?.name}</strong>. Stock reports will be sent here when a
              shift ends with low stock.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search groups…"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                className="pl-8"
                data-testid="input-chat-search"
              />
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => refetchChats()}
              disabled={chatsLoading}
              data-testid="button-refresh-chats"
              title="Refresh groups"
            >
              <RefreshCw className={`h-4 w-4 ${chatsLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="border rounded-md overflow-y-auto max-h-64">
            {chatsLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading groups…
              </div>
            ) : (
              <>
                <button
                  className={`w-full text-left px-3 py-2 text-sm hover-elevate flex items-center gap-2 ${!selectedChatId ? "bg-muted font-medium" : ""}`}
                  onClick={() => setSelectedChatId("")}
                  data-testid="option-no-group"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                  No group (disabled)
                  {!selectedChatId && <Check className="h-4 w-4 ml-auto text-green-600 dark:text-green-400" />}
                </button>
                {filteredChats.length === 0 && (
                  <p className="text-center text-muted-foreground text-sm py-4 px-3">
                    {waChats.filter((c) => c.type === "group").length === 0
                      ? "No WhatsApp groups found. Make sure the POS API instance is connected and has groups."
                      : "No groups match your search."}
                  </p>
                )}
                {filteredChats.map((chat) => (
                  <button
                    key={chat.id}
                    className={`w-full text-left px-3 py-2 text-sm hover-elevate flex items-center gap-2 ${selectedChatId === chat.id ? "bg-muted font-medium" : ""}`}
                    onClick={() => setSelectedChatId(chat.id)}
                    data-testid={`option-chat-${chat.id}`}
                  >
                    <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{chat.name}</span>
                    {selectedChatId === chat.id && (
                      <Check className="h-4 w-4 ml-auto shrink-0 text-green-600 dark:text-green-400" />
                    )}
                  </button>
                ))}
              </>
            )}
          </div>

          {selectedChatId && (
            <p className="text-xs text-muted-foreground">
              Selected ID: <code className="font-mono">{selectedChatId}</code>
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel-wa-group">
              Cancel
            </Button>
            <Button onClick={handleSaveGroup} disabled={saveGroupMutation.isPending} data-testid="button-save-wa-group">
              {saveGroupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
