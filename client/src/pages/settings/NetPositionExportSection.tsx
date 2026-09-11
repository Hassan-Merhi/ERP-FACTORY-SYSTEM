import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { SettingsMessageResult } from "./settingsTypes";
import {
  TrendingUp,
  Send,
  ChevronDown,
  ChevronRight,
  Loader2,
  Users,
  Clock,
  Calendar,
  CheckCircle2,
  Info,
} from "lucide-react";

interface Recipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

interface NpSettings {
  recipientId: number | null;
  frequency: string;
  sendHour: number;
  sendDayOfWeek: number;
  enabled: boolean;
  autoSend: boolean;
  lastSentAt: string | null;
}

const DAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

function formatHour(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}

const HOURS = Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: formatHour(i) }));

function scheduleLabel(cfg: NpSettings | undefined): string {
  if (!cfg?.autoSend || !cfg?.enabled) return "";
  const time = formatHour(cfg.sendHour ?? 18);
  if (cfg.frequency === "daily") return `Daily at ${time} EST`;
  if (cfg.frequency === "monthly") return `Monthly (1st) at ${time} EST`;
  if (cfg.frequency === "weekly") {
    const day = DAYS.find((d) => d.value === String(cfg.sendDayOfWeek))?.label ?? "Monday";
    return `Every ${day} at ${time} EST`;
  }
  return "Auto-Send On";
}

function currentYearDateRange(): { start: string; end: string } {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().split("T")[0];
  return { start: `${year}-01-01`, end: today };
}

export function NetPositionExportSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const { data: recipients = [] } = useQuery<Recipient[]>({
    queryKey: ["/api/whatsapp/recipients"],
    enabled: expanded,
  });

  const { data: cfg } = useQuery<NpSettings>({
    queryKey: ["/api/whatsapp/np-settings"],
    enabled: expanded,
  });

  const groups = recipients.filter((r) => r.isGroup && r.active);

  // Local state — null means "not changed by user, use cfg value"
  const [recipientId, setRecipientId] = useState<number | null | undefined>(undefined);
  const [frequency, setFrequency] = useState<string | null>(null);
  const [sendHour, setSendHour] = useState<number | null>(null);
  const [sendDayOfWeek, setSendDayOfWeek] = useState<number | null>(null);

  // Effective values: user-changed local state wins, otherwise use saved config
  const eff = {
    recipientId: recipientId !== undefined ? recipientId : (cfg?.recipientId ?? null),
    frequency: frequency !== null ? frequency : (cfg?.frequency ?? "daily"),
    sendHour: sendHour !== null ? sendHour : (cfg?.sendHour ?? 18),
    sendDayOfWeek: sendDayOfWeek !== null ? sendDayOfWeek : (cfg?.sendDayOfWeek ?? 1),
  };

  const buildPayload = (overrides?: Partial<NpSettings & { recipientId: number | null }>) => ({
    recipientId: eff.recipientId,
    frequency: eff.frequency,
    sendHour: eff.sendHour,
    sendDayOfWeek: eff.sendDayOfWeek,
    enabled: cfg?.enabled ?? false,
    autoSend: cfg?.autoSend ?? false,
    ...overrides,
  });

  const saveSettings = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/whatsapp/np-settings", buildPayload()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/np-settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleEnabled = useMutation({
    mutationFn: (value: boolean) => apiRequest("PUT", "/api/whatsapp/np-settings", buildPayload({ enabled: value })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/np-settings"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleAutoSend = useMutation({
    mutationFn: (value: boolean) => apiRequest("PUT", "/api/whatsapp/np-settings", buildPayload({ autoSend: value })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/np-settings"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const sendNow = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/send-np-all-now", { recipientId: eff.recipientId }),
    onSuccess: (data: unknown) => {
      const message = (data as SettingsMessageResult | null)?.message;
      toast({ title: "Net Position Export Sent", description: message || "Done" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const label = scheduleLabel(cfg);
  const { start: npStart, end: npEnd } = currentYearDateRange();

  return (
    <div className="border rounded-md" data-testid="section-np-export">
      <button
        className="w-full flex items-center justify-between p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-np-export-toggle"
      >
        <div className="flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-blue-600" />
          <div>
            <p className="font-semibold">Net Position Export Schedule</p>
            <p className="text-sm text-muted-foreground">
              {label
                ? `All-companies net position ZIP → WhatsApp group + email — ${label}`
                : "Send all-companies net position ZIP to a WhatsApp group and email on a schedule"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {cfg?.autoSend && cfg?.enabled && (
            <Badge variant="secondary" className="text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300">
              Active
            </Badge>
          )}
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-5">
          {/* ── Date range note ─────────────────────────────────────── */}
          <div className="flex items-start gap-2 rounded-md bg-muted/50 border p-3">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Date range: </span>
              Jan 1, {new Date().getFullYear()} → today ({npEnd}). Every send covers from the start of the current year
              up to the date the export runs.
            </div>
          </div>

          {/* ── WhatsApp group ──────────────────────────────────────── */}
          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              WhatsApp Group
            </Label>
            <p className="text-xs text-muted-foreground">
              A ZIP containing one net position Excel per company will be sent to this group. Manage groups in the
              WhatsApp Export section above.
            </p>
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No active group recipients — add one in the WhatsApp Export section first.
              </p>
            ) : (
              <Select
                value={String(eff.recipientId ?? "")}
                onValueChange={(v) => setRecipientId(v ? parseInt(v) : null)}
              >
                <SelectTrigger data-testid="select-np-group" className="w-full sm:w-80">
                  <SelectValue placeholder="Pick a group…" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} data-testid={`option-np-group-${r.id}`}>
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

          {/* ── Schedule ────────────────────────────────────────────── */}
          <div className="space-y-4">
            <p className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Schedule
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Frequency */}
              <div className="space-y-1">
                <Label className="text-xs">Frequency</Label>
                <Select value={eff.frequency} onValueChange={(v) => setFrequency(v)}>
                  <SelectTrigger data-testid="select-np-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly (1st of month)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Send hour */}
              <div className="space-y-1">
                <Label className="text-xs">Send Time (EST)</Label>
                <Select value={String(eff.sendHour)} onValueChange={(v) => setSendHour(parseInt(v))}>
                  <SelectTrigger data-testid="select-np-hour">
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
              </div>

              {/* Day of week (weekly only) */}
              {eff.frequency === "weekly" && (
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Day of Week
                  </Label>
                  <Select value={String(eff.sendDayOfWeek)} onValueChange={(v) => setSendDayOfWeek(parseInt(v))}>
                    <SelectTrigger data-testid="select-np-day">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* ── Enable toggles ──────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Enable</p>
                <p className="text-xs text-muted-foreground">Activate this export schedule</p>
              </div>
              <Switch
                data-testid="switch-np-enabled"
                checked={cfg?.enabled ?? false}
                onCheckedChange={(v) => toggleEnabled.mutate(v)}
                disabled={toggleEnabled.isPending}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Auto-Send</p>
                <p className="text-xs text-muted-foreground">Run automatically on the configured schedule</p>
              </div>
              <Switch
                data-testid="switch-np-autosend"
                checked={cfg?.autoSend ?? false}
                onCheckedChange={(v) => toggleAutoSend.mutate(v)}
                disabled={!cfg?.enabled || toggleAutoSend.isPending}
              />
            </div>
          </div>

          {/* Last sent */}
          {cfg?.lastSentAt && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-green-600" />
              Last sent: {new Date(cfg.lastSentAt).toLocaleString()}
            </div>
          )}

          <Separator />

          {/* ── Actions ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => saveSettings.mutate()}
              disabled={saveSettings.isPending}
              data-testid="button-np-save"
            >
              {saveSettings.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save Settings"
              )}
            </Button>

            <Button
              variant="outline"
              onClick={() => sendNow.mutate()}
              disabled={sendNow.isPending}
              data-testid="button-np-send-now"
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
          </div>

          <p className="text-xs text-muted-foreground">
            "Send Now" immediately sends the ZIP ({npStart} → {npEnd}) to the selected WhatsApp group and all email
            recipients. The scheduler checks every hour and sends automatically when the time matches.
          </p>
        </div>
      )}
    </div>
  );
}
