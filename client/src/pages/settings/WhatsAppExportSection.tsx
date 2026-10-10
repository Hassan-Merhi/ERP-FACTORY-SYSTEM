import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  MessageSquare,
  Plus,
  Trash2,
  Users,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Moon,
} from "lucide-react";

interface WaSettings {
  instanceId: string;
  apiToken: string;
  enabled: boolean;
  hasCredentials: boolean;
}

interface Recipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

interface GreenChat {
  id: string;
  name: string;
  type: string;
}

type InstanceState =
  "authorized" | "notAuthorized" | "sleepMode" | "starting" | "yellowCard" | "notConfigured" | "unknown";

export function WhatsAppExportSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [instanceId, setInstanceId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [newChatId, setNewChatId] = useState("");
  const [newName, setNewName] = useState("");
  const [checkStateEnabled, setCheckStateEnabled] = useState(false);

  const { data: settings } = useQuery<WaSettings>({
    queryKey: ["/api/whatsapp/settings"],
    enabled: expanded,
  });

  const {
    data: instanceStateData,
    isLoading: instanceStateLoading,
    refetch: refetchInstanceState,
  } = useQuery<{ state: InstanceState }>({
    queryKey: ["/api/whatsapp/instance-state/main"],
    enabled: checkStateEnabled && expanded,
    staleTime: 10_000,
    retry: false,
  });

  const { data: recipients = [], isLoading: loadingRecipients } = useQuery<Recipient[]>({
    queryKey: ["/api/whatsapp/recipients"],
    enabled: expanded,
  });

  const {
    data: chats = [],
    isLoading: loadingChats,
    refetch: fetchChats,
  } = useQuery<GreenChat[]>({
    queryKey: ["/api/whatsapp/chats"],
    enabled: false,
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      apiRequest("PUT", "/api/whatsapp/settings", {
        instanceId,
        apiToken,
        enabled: settings?.enabled ?? false,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/settings"] });
      toast({ title: "WhatsApp credentials saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleEnabled = useMutation({
    mutationFn: (value: boolean) =>
      apiRequest("PUT", "/api/whatsapp/settings", {
        instanceId: settings?.instanceId ?? "",
        apiToken: "••••••",
        enabled: value,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/settings"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const addRecipient = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/recipients", { chatId: newChatId, name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      setNewChatId("");
      setNewName("");
      toast({ title: "Recipient added" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const addFromChat = useMutation({
    mutationFn: (chat: GreenChat) =>
      apiRequest("POST", "/api/whatsapp/recipients", { chatId: chat.id, name: chat.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      toast({ title: "Added from group list" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiRequest("PUT", `/api/whatsapp/recipients/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteRecipient = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/whatsapp/recipients/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      toast({ title: "Recipient removed" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleFetchChats = async () => {
    setShowGroupPicker(true);
    await fetchChats();
  };

  const groups = chats.filter((c) => c.type === "group" || c.id.endsWith("@g.us"));

  return (
    <div className="border rounded-md">
      <button
        className="w-full flex items-center justify-between p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-whatsapp-section-toggle"
      >
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-green-600" />
          <div>
            <p className="font-semibold">WhatsApp Export</p>
            <p className="text-sm text-muted-foreground">Green API credentials, recipients, and master on/off switch</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {settings?.enabled && (
            <Badge variant="secondary" className="text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300">
              Active
            </Badge>
          )}
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-6">
          {/* ── Credentials ─────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-sm font-medium">Green API Credentials</p>
            <p className="text-xs text-muted-foreground">
              Create a free account at{" "}
              <a href="https://green-api.com" target="_blank" rel="noreferrer" className="underline">
                green-api.com
              </a>
              , connect your WhatsApp number, then copy your Instance ID and API Token here.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wa-instance">Instance ID</Label>
                <Input
                  id="wa-instance"
                  data-testid="input-wa-instance-id"
                  placeholder="e.g. 1101234567"
                  value={instanceId || settings?.instanceId || ""}
                  onChange={(e) => setInstanceId(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wa-token">API Token</Label>
                <Input
                  id="wa-token"
                  data-testid="input-wa-api-token"
                  type="password"
                  placeholder="Paste your API token"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="default"
                onClick={() => saveSettings.mutate()}
                disabled={saveSettings.isPending}
                data-testid="button-wa-save-credentials"
              >
                {saveSettings.isPending ? "Saving…" : "Save Credentials"}
              </Button>
              {settings?.hasCredentials && (
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => {
                    setCheckStateEnabled(true);
                    refetchInstanceState();
                  }}
                  disabled={instanceStateLoading}
                  data-testid="button-check-main-instance-state"
                >
                  {instanceStateLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Check Status
                </Button>
              )}
              {instanceStateData &&
                (instanceStateData.state === "authorized" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300"
                  >
                    <CheckCircle className="h-3 w-3" />
                    Authorized
                  </Badge>
                ) : instanceStateData.state === "sleepMode" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300"
                  >
                    <Moon className="h-3 w-3" />
                    Sleeping
                  </Badge>
                ) : instanceStateData.state === "notAuthorized" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300"
                  >
                    <XCircle className="h-3 w-3" />
                    Not authorized
                  </Badge>
                ) : instanceStateData.state === "yellowCard" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-orange-700 bg-orange-100 dark:bg-orange-950 dark:text-orange-300"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Warning
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <XCircle className="h-3 w-3 text-muted-foreground" />
                    Unknown
                  </Badge>
                ))}
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
                and wake up your instance — messages won't be delivered while asleep.
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
          </div>

          <Separator />

          {/* ── Enable toggle ────────────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable WhatsApp Sending</p>
              <p className="text-xs text-muted-foreground">
                Master switch — enables all WhatsApp auto-send features and the "Send" buttons
              </p>
            </div>
            <Switch
              data-testid="switch-wa-enabled"
              checked={settings?.enabled ?? false}
              onCheckedChange={(v) => toggleEnabled.mutate(v)}
              disabled={!settings?.hasCredentials}
            />
          </div>

          <Separator />

          {/* ── Recipients ──────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-medium">Recipients</p>
              <Button
                size="default"
                variant="outline"
                onClick={handleFetchChats}
                disabled={!settings?.hasCredentials || loadingChats}
                data-testid="button-wa-fetch-groups"
              >
                <Users className="h-4 w-4 mr-2" />
                {loadingChats ? "Loading…" : "Pick from WhatsApp Groups"}
              </Button>
            </div>

            {/* Group picker from Green API */}
            {showGroupPicker && (
              <div className="border rounded-md p-3 space-y-2 bg-muted/40">
                <p className="text-xs font-medium text-muted-foreground">
                  {groups.length === 0 && !loadingChats
                    ? "No groups found. Make sure the WhatsApp number is connected."
                    : `${groups.length} group(s) found — click to add:`}
                </p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {groups.map((g) => {
                    const already = recipients.some((r) => r.chatId === g.id);
                    return (
                      <div
                        key={g.id}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-background text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{g.name}</span>
                          <span className="text-xs text-muted-foreground truncate hidden sm:block">{g.id}</span>
                        </div>
                        {already ? (
                          <Badge variant="secondary">Added</Badge>
                        ) : (
                          <Button
                            size="default"
                            variant="outline"
                            onClick={() => addFromChat.mutate(g)}
                            disabled={addFromChat.isPending}
                            data-testid={`button-add-group-${g.id}`}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />
                            Add
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Manual entry */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Or enter a chatId manually. For DRC use{" "}
                <code className="bg-muted px-1 rounded-sm">243XXXXXXXXX@c.us</code> (individual) or paste a group chatId
                ending in <code className="bg-muted px-1 rounded-sm">@g.us</code>.
              </p>
              <div className="flex gap-2 flex-wrap">
                <Input
                  className="flex-1 min-w-0"
                  placeholder="243XXXXXXXXX@c.us or group@g.us"
                  value={newChatId}
                  onChange={(e) => setNewChatId(e.target.value)}
                  data-testid="input-wa-new-chat-id"
                />
                <Input
                  className="w-40"
                  placeholder="Label (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  data-testid="input-wa-new-name"
                />
                <Button
                  size="default"
                  onClick={() => addRecipient.mutate()}
                  disabled={!newChatId.trim() || addRecipient.isPending}
                  data-testid="button-wa-add-recipient"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>
            </div>

            {/* Recipient list */}
            {loadingRecipients ? (
              <p className="text-sm text-muted-foreground">Loading recipients…</p>
            ) : recipients.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No recipients yet.</p>
            ) : (
              <div className="space-y-2">
                {recipients.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border bg-card"
                    data-testid={`row-wa-recipient-${r.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {r.isGroup ? (
                        <Users className="h-4 w-4 shrink-0 text-blue-500" />
                      ) : (
                        <MessageSquare className="h-4 w-4 shrink-0 text-green-500" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{r.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{r.chatId}</p>
                      </div>
                      {r.isGroup && (
                        <Badge variant="secondary" className="shrink-0">
                          Group
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {r.active ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                      <Switch
                        checked={r.active}
                        onCheckedChange={(v) => toggleActive.mutate({ id: r.id, active: v })}
                        data-testid={`switch-wa-recipient-${r.id}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteRecipient.mutate(r.id)}
                        disabled={deleteRecipient.isPending}
                        data-testid={`button-delete-wa-recipient-${r.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
