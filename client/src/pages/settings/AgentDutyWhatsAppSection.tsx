import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  MessageCircle,
  ChevronDown,
  ChevronRight,
  Users,
  CheckCircle,
  XCircle,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

interface AgentDutyWaSettings {
  groups: Record<string, string>;
  hasCredentials: boolean;
  waEnabled: boolean;
}

interface GreenChat {
  id: string;
  name: string;
  type: string;
}

export function AgentDutyWhatsAppSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [newAgentName, setNewAgentName] = useState("");
  const [chats, setChats] = useState<GreenChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery<AgentDutyWaSettings>({
    queryKey: ["/api/git/agent-duty-wa-settings"],
    enabled: expanded,
  });

  useEffect(() => {
    if (settings) setGroups(settings.groups ?? {});
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", "/api/git/agent-duty-wa-settings", { groups }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/git/agent-duty-wa-settings"] });
      toast({ title: "Agent Duty WhatsApp settings saved." });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  async function loadChats() {
    setChatsLoading(true);
    try {
      const res = await apiRequest("GET", "/api/whatsapp/chats");
      if (!res.ok) throw new Error("Failed to fetch chats");
      const data = (await res.json()) as GreenChat[];
      setChats(data.filter((c) => c.type === "group" || String(c.id).endsWith("@g.us")));
    } catch (e) {
      toast({ title: "Could not load chats", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setChatsLoading(false);
    }
  }

  function addAgent() {
    const name = newAgentName.trim();
    if (!name) return;
    if (groups[name] !== undefined) {
      toast({ title: "Agent already exists", variant: "destructive" });
      return;
    }
    setGroups((prev) => ({ ...prev, [name]: "" }));
    setNewAgentName("");
  }

  function removeAgent(name: string) {
    setGroups((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (pickerFor === name) setPickerFor(null);
  }

  function assignGroup(agentName: string, chatId: string) {
    setGroups((prev) => ({ ...prev, [agentName]: chatId }));
    setPickerFor(null);
  }

  const configuredCount = Object.values(groups).filter(Boolean).length;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 hover-elevate"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-toggle-agent-duty-wa"
      >
        <div className="flex items-center gap-3">
          <MessageCircle className="h-4 w-4 text-green-500" />
          <div className="text-left">
            <p className="text-sm font-medium">Agent / Duty — WhatsApp</p>
            <p className="text-xs text-muted-foreground">
              Map each clearing agent (NCA, Nahli, etc.) to a WhatsApp group for the balance allocation image send.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {configuredCount > 0 ? (
            <Badge variant="secondary" className="text-xs">
              {configuredCount} configured
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
              <div className="flex items-center gap-2 text-sm">
                {settings?.hasCredentials && settings?.waEnabled ? (
                  <>
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-muted-foreground">WhatsApp connected and enabled.</span>
                  </>
                ) : settings?.hasCredentials ? (
                  <>
                    <XCircle className="h-4 w-4 text-amber-500" />
                    <span className="text-muted-foreground">Credentials set but WhatsApp sending is disabled.</span>
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

              <div className="space-y-3">
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Agent → Group Mappings
                </Label>
                <p className="text-xs text-muted-foreground">
                  Add each agent name exactly as it appears in the Agent / Duty tab, then pick its WhatsApp group.
                </p>

                {Object.keys(groups).length === 0 && (
                  <p className="text-xs text-muted-foreground italic">No agents configured yet.</p>
                )}

                {Object.entries(groups).map(([name, chatId]) => {
                  const matchedChat = chats.find((c) => c.id === chatId);
                  return (
                    <div key={name} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium w-24 shrink-0">{name}</span>
                        {chatId ? (
                          <Badge variant="secondary" className="font-mono text-xs">
                            {matchedChat?.name ?? chatId}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">No group set</span>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (chats.length === 0) loadChats();
                            setPickerFor((prev) => (prev === name ? null : name));
                          }}
                          disabled={chatsLoading}
                          data-testid={`button-pick-group-${name}`}
                        >
                          {chatsLoading && pickerFor === name ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                          ) : (
                            <Users className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          {chatId ? "Change" : "Pick Group"}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => removeAgent(name)}
                          data-testid={`button-remove-agent-${name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>

                      {pickerFor === name && chats.length > 0 && (
                        <div className="ml-26 space-y-1 max-h-40 overflow-y-auto rounded-md border p-1 ml-28">
                          {chats.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              className={`w-full text-left px-3 py-2 rounded-sm text-xs hover-elevate ${chatId === c.id ? "bg-primary/10 text-primary font-medium" : ""}`}
                              onClick={() => assignGroup(name, c.id)}
                              data-testid={`option-wa-group-${name}-${c.id}`}
                            >
                              {c.name}
                              <span className="text-muted-foreground ml-2 font-mono">{c.id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                <Separator />

                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    className="border rounded-md px-2 py-1 text-sm h-9 w-36 bg-background"
                    placeholder="Agent name"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addAgent()}
                    data-testid="input-new-agent-name"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addAgent}
                    disabled={!newAgentName.trim()}
                    data-testid="button-add-agent"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    Add Agent
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  data-testid="button-save-agent-duty-wa"
                >
                  {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Settings
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={loadChats}
                  disabled={chatsLoading || !settings?.hasCredentials}
                  data-testid="button-refresh-agent-duty-wa-chats"
                >
                  {chatsLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <Users className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Refresh Groups
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
