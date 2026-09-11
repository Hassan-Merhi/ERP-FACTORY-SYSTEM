import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { SettingsMessageResult } from "./settingsTypes";
import { Archive, ChevronDown, ChevronRight, Users, Info, Loader2, Send } from "lucide-react";

interface WaSettings {
  instanceId: string;
  enabled: boolean;
  dailyAutoSend: boolean;
  dailyRecipientId: number | null;
  hasCredentials: boolean;
}

interface Recipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

export function DailyAutoSendSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(true);

  const { data: settings } = useQuery<WaSettings>({
    queryKey: ["/api/whatsapp/settings"],
    enabled: expanded,
  });

  const { data: recipients = [] } = useQuery<Recipient[]>({
    queryKey: ["/api/whatsapp/recipients"],
    enabled: expanded,
  });

  const groups = recipients.filter((r) => r.isGroup);

  const patchSettings = useMutation({
    mutationFn: (patch: Partial<{ dailyAutoSend: boolean; dailyRecipientId: number | null }>) =>
      apiRequest("PUT", "/api/whatsapp/settings", patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/settings"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const sendNow = useMutation({
    mutationFn: () => apiRequest("POST", "/api/daily-export/trigger-whatsapp"),
    onSuccess: (data: unknown) => {
      const message = (data as SettingsMessageResult | null)?.message;
      toast({ title: "Daily export sent", description: message || "ZIP sent to WhatsApp group" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const isActive = !!(settings?.enabled && settings?.dailyAutoSend && settings?.dailyRecipientId);

  return (
    <div className="border rounded-md">
      <button
        className="w-full flex items-center justify-between p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-daily-autosend-section-toggle"
      >
        <div className="flex items-center gap-3">
          <Archive className="h-5 w-5 text-blue-500" />
          <div>
            <p className="font-semibold">Daily Auto-Send</p>
            <p className="text-sm text-muted-foreground">Send the daily ZIP export to a WhatsApp group every day</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <Badge variant="secondary" className="text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300">
              Active
            </Badge>
          )}
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-6">
          {/* Info box */}
          <div className="flex gap-2 rounded-md bg-muted/50 border p-3 text-sm text-muted-foreground">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
            <p>
              Every day at the configured schedule time a ZIP file is generated containing all company exports plus the
              all-companies net position Excel (full current year) and sent to the selected WhatsApp group.
            </p>
          </div>

          {!settings?.hasCredentials && (
            <p className="text-sm text-destructive">
              Green API credentials are not configured. Go to the <strong>WhatsApp Export</strong> section to add them.
            </p>
          )}

          {!settings?.enabled && settings?.hasCredentials && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              WhatsApp sending is currently disabled. Enable it in the <strong>WhatsApp Export</strong> section.
            </p>
          )}

          <Separator />

          {/* Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Daily Auto-Send</p>
              <p className="text-xs text-muted-foreground">
                Automatically send the ZIP every day at the scheduled time to the group below
              </p>
            </div>
            <Switch
              data-testid="switch-daily-autosend"
              checked={settings?.dailyAutoSend ?? false}
              onCheckedChange={(v) => patchSettings.mutate({ dailyAutoSend: v })}
              disabled={!settings?.enabled || patchSettings.isPending}
            />
          </div>

          {/* Group picker */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Daily Export WhatsApp Group</p>
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No group recipients added yet — add one in the <strong>WhatsApp Export</strong> section.
              </p>
            ) : (
              <Select
                value={String(settings?.dailyRecipientId ?? "")}
                onValueChange={(v) => patchSettings.mutate({ dailyRecipientId: v ? parseInt(v) : null })}
                disabled={!settings?.enabled || patchSettings.isPending}
              >
                <SelectTrigger data-testid="select-daily-autosend-group" className="w-full sm:w-80">
                  <SelectValue placeholder="Pick a group…" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} data-testid={`option-daily-group-${r.id}`}>
                      <div className="flex items-center gap-2">
                        <Users className="h-3.5 w-3.5" />
                        {r.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <Separator />

          {/* Manual send */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Send Now</p>
            <p className="text-xs text-muted-foreground">
              Trigger the daily ZIP export immediately and send it to the selected group.
            </p>
            <Button
              onClick={() => sendNow.mutate()}
              disabled={sendNow.isPending || !isActive}
              data-testid="button-daily-autosend-send-now"
            >
              {sendNow.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send Now
                </>
              )}
            </Button>
            {!isActive && (
              <p className="text-xs text-muted-foreground">
                Enable auto-send and select a group above to use this button.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
