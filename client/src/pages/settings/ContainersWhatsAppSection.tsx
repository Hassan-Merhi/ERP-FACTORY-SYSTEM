import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  MessageCircle,
  ChevronDown,
  ChevronRight,
  Users,
  CheckCircle,
  XCircle,
  Loader2,
  Send,
  Clock,
} from "lucide-react";

interface ContainersWaSettings {
  groupChatId: string;
  scheduleEnabled: boolean;
  scheduleHour: number;
  lastSentAt: string | null;
  hasCredentials: boolean;
  waEnabled: boolean;
}

interface GreenChat {
  id: string;
  name: string;
  type: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${String(i).padStart(2, "0")}:00`,
}));

export function ContainersWhatsAppSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [groupChatId, setGroupChatId] = useState("");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleHour, setScheduleHour] = useState(8);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chats, setChats] = useState<GreenChat[]>([]);

  const { data: settings, isLoading } = useQuery<ContainersWaSettings>({
    queryKey: ["/api/git/containers-wa-settings"],
    enabled: expanded,
  });

  useEffect(() => {
    if (settings) {
      setGroupChatId(settings.groupChatId);
      setScheduleEnabled(settings.scheduleEnabled);
      setScheduleHour(settings.scheduleHour);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", "/api/git/containers-wa-settings", {
        groupChatId,
        scheduleEnabled,
        scheduleHour,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/git/containers-wa-settings"] });
      toast({ title: "Containers WhatsApp settings saved." });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const testSendMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/git/send-containers-whatsapp", {}),
    onSuccess: () => toast({ title: "Sent", description: "Container report (PDF) sent to the configured group." }),
    onError: (e: ClientErrorLike) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  async function loadChats() {
    setChatsLoading(true);
    try {
      const res = await apiRequest("GET", "/api/whatsapp/chats");
      if (!res.ok) throw new Error("Failed to fetch chats");
      const data = (await res.json()) as GreenChat[];
      setChats(data.filter((c) => c.type === "group" || String(c.id).endsWith("@g.us")));
      setShowGroupPicker(true);
    } catch (e) {
      toast({ title: "Could not load chats", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setChatsLoading(false);
    }
  }

  const selectedChat = chats.find((c) => c.id === groupChatId);

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 hover-elevate"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-toggle-containers-wa"
      >
        <div className="flex items-center gap-3">
          <MessageCircle className="h-4 w-4 text-green-500" />
          <div className="text-left">
            <p className="text-sm font-medium">Containers OTW — WhatsApp</p>
            <p className="text-xs text-muted-foreground">
              Send the containers table as an image to a WhatsApp group, manually or on a schedule.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {settings?.groupChatId ? (
            <Badge variant="secondary" className="text-xs">
              Configured
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs">
              Not set
            </Badge>
          )}
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-5">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading settings…
            </div>
          ) : (
            <>
              {/* Credential check */}
              <div className="flex items-center gap-2 text-sm">
                {settings?.hasCredentials && settings?.waEnabled ? (
                  <>
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-muted-foreground">WhatsApp connected and enabled.</span>
                  </>
                ) : settings?.hasCredentials ? (
                  <>
                    <XCircle className="h-4 w-4 text-amber-500" />
                    <span className="text-muted-foreground">
                      Credentials set but WhatsApp sending is disabled. Enable it in WhatsApp settings.
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4 text-red-500" />
                    <span className="text-muted-foreground">
                      WhatsApp not configured. Set credentials in WhatsApp &amp; Notifications → Main Instance.
                    </span>
                  </>
                )}
              </div>

              <Separator />

              {/* Group chat selection */}
              <div className="space-y-2">
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Target Group
                </Label>

                {groupChatId ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {selectedChat?.name ?? groupChatId}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => {
                        setGroupChatId("");
                        setShowGroupPicker(false);
                      }}
                      data-testid="button-clear-containers-wa-group"
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No group selected.</p>
                )}

                {!showGroupPicker && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadChats}
                    disabled={chatsLoading || !settings?.hasCredentials}
                    data-testid="button-load-containers-wa-chats"
                  >
                    {chatsLoading ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                        Loading groups…
                      </>
                    ) : (
                      <>
                        <Users className="h-3.5 w-3.5 mr-1.5" />
                        Fetch WhatsApp Groups
                      </>
                    )}
                  </Button>
                )}

                {showGroupPicker && chats.length > 0 && (
                  <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border p-1">
                    {chats.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`w-full text-left px-3 py-2 rounded-sm text-xs hover-elevate ${groupChatId === c.id ? "bg-primary/10 text-primary font-medium" : ""}`}
                        onClick={() => {
                          setGroupChatId(c.id);
                          setShowGroupPicker(false);
                        }}
                        data-testid={`option-wa-group-${c.id}`}
                      >
                        {c.name}
                        <span className="text-muted-foreground ml-2 font-mono">{c.id}</span>
                      </button>
                    ))}
                  </div>
                )}

                {showGroupPicker && chats.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No groups found. Make sure your WhatsApp instance is connected.
                  </p>
                )}
              </div>

              <Separator />

              {/* Schedule */}
              <div className="space-y-3">
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> Daily Schedule
                </Label>

                <div className="flex items-center gap-3">
                  <Switch
                    checked={scheduleEnabled}
                    onCheckedChange={setScheduleEnabled}
                    data-testid="switch-containers-wa-schedule"
                  />
                  <span className="text-sm">{scheduleEnabled ? "Enabled" : "Disabled"}</span>
                </div>

                {scheduleEnabled && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <Label className="text-xs text-muted-foreground">Send at</Label>
                    <Select value={String(scheduleHour)} onValueChange={(v) => setScheduleHour(Number(v))}>
                      <SelectTrigger className="w-28" data-testid="select-containers-wa-hour">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOURS.map((h) => (
                          <SelectItem key={h.value} value={h.value}>
                            {h.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-xs text-muted-foreground">(server local time, checked every hour)</span>
                  </div>
                )}

                {settings?.lastSentAt && (
                  <p className="text-xs text-muted-foreground">
                    Last sent: {new Date(settings.lastSentAt).toLocaleString()}
                  </p>
                )}
              </div>

              <Separator />

              {/* Actions */}
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  data-testid="button-save-containers-wa"
                >
                  {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                  Save Settings
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => testSendMutation.mutate()}
                  disabled={
                    testSendMutation.isPending || !groupChatId || !settings?.hasCredentials || !settings?.waEnabled
                  }
                  data-testid="button-test-containers-wa"
                >
                  {testSendMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <Send className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Test Send PDF
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
