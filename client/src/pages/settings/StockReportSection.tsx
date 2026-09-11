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
import { Package, Send, ChevronDown, ChevronRight, Loader2, Users, Clock, Calendar } from "lucide-react";

interface Company {
  id: number;
  name: string;
}
interface Recipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

interface StockSettings {
  companyId: number | null;
  recipientId: number | null;
  autoSend: boolean;
  enabled: boolean;
  frequency: string;
  sendHour: number;
  sendDayOfWeek: number;
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

function scheduleLabel(cfg: StockSettings | undefined): string {
  if (!cfg?.autoSend) return "";
  const time = formatHour(cfg.sendHour ?? 18);
  if (cfg.frequency === "daily") return `Daily at ${time} EST`;
  if (cfg.frequency === "monthly") return `Monthly (1st) at ${time} EST`;
  if (cfg.frequency === "weekly") {
    const day = DAYS.find((d) => d.value === String(cfg.sendDayOfWeek))?.label ?? "Monday";
    return `Every ${day} at ${time} EST`;
  }
  return "Auto-Send On";
}

export function StockReportSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: expanded,
  });

  const { data: recipients = [] } = useQuery<Recipient[]>({
    queryKey: ["/api/whatsapp/recipients"],
    enabled: expanded,
  });

  const { data: cfg } = useQuery<StockSettings>({
    queryKey: ["/api/whatsapp/stock-settings"],
    enabled: expanded,
  });

  const groups = recipients.filter((r) => r.isGroup && r.active);

  // Local state for all editable fields
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [recipientId, setRecipientId] = useState<number | null>(null);
  const [frequency, setFrequency] = useState<string | null>(null);
  const [sendHour, setSendHour] = useState<number | null>(null);
  const [sendDayOfWeek, setSendDayOfWeek] = useState<number | null>(null);

  // Resolved values (local state overrides server state)
  const rCompanyId = companyId ?? cfg?.companyId ?? null;
  const rRecipientId = recipientId ?? cfg?.recipientId ?? null;
  const rFrequency = frequency ?? cfg?.frequency ?? "daily";
  const rSendHour = sendHour ?? cfg?.sendHour ?? 18;
  const rSendDayOfWeek = sendDayOfWeek ?? cfg?.sendDayOfWeek ?? 1;

  const buildPayload = (patch?: Partial<StockSettings>) => ({
    companyId: rCompanyId,
    recipientId: rRecipientId,
    frequency: rFrequency,
    sendHour: rSendHour,
    sendDayOfWeek: rSendDayOfWeek,
    autoSend: cfg?.autoSend ?? false,
    enabled: cfg?.enabled ?? false,
    ...patch,
  });

  const saveSettings = useMutation({
    mutationFn: (patch?: Partial<StockSettings>) =>
      apiRequest("PUT", "/api/whatsapp/stock-settings", buildPayload(patch)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/stock-settings"] });
      toast({ title: "Stock report settings saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const sendNow = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/whatsapp/send-stock-report", {
        companyId: rCompanyId,
        recipientId: rRecipientId,
      }),
    onSuccess: (data: unknown) => {
      const message = (data as SettingsMessageResult | null)?.message;
      toast({ title: "Reports sent", description: message || "Done" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const canSend = !!(rCompanyId && rRecipientId);
  const label = scheduleLabel(cfg);

  return (
    <div className="border rounded-md">
      <button
        className="w-full flex items-center justify-between p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-stock-report-section-toggle"
      >
        <div className="flex items-center gap-3">
          <Package className="h-5 w-5 text-blue-600" />
          <div>
            <p className="font-semibold">Stock + Net Position Report</p>
            <p className="text-sm text-muted-foreground">
              Send stock-with-cost PDF &amp; net position Excel to one WhatsApp group on your own schedule
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {cfg?.enabled && cfg?.autoSend && label && (
            <Badge variant="secondary" className="text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300">
              {label}
            </Badge>
          )}
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-5">
          {/* ── Company ──────────────────────────────────────────────────── */}
          <div className="space-y-1">
            <Label className="text-sm font-medium">Company</Label>
            <p className="text-xs text-muted-foreground">Which company's stock and net position to report on</p>
            <Select value={String(rCompanyId ?? "")} onValueChange={(v) => setCompanyId(v ? parseInt(v) : null)}>
              <SelectTrigger data-testid="select-stock-company" className="w-full sm:w-72">
                <SelectValue placeholder="Select a company…" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)} data-testid={`option-company-${c.id}`}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── WhatsApp Group ───────────────────────────────────────────── */}
          <div className="space-y-1">
            <Label className="text-sm font-medium">WhatsApp Group</Label>
            <p className="text-xs text-muted-foreground">
              Reports are sent to this group. Only active groups you've added appear here.
            </p>
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No active WhatsApp groups found. Add a group recipient in the WhatsApp Export section above.
              </p>
            ) : (
              <Select value={String(rRecipientId ?? "")} onValueChange={(v) => setRecipientId(v ? parseInt(v) : null)}>
                <SelectTrigger data-testid="select-stock-recipient" className="w-full sm:w-72">
                  <SelectValue placeholder="Select a group…" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} data-testid={`option-recipient-${r.id}`}>
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

          {/* ── Schedule ─────────────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium">Send Schedule</Label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {/* Frequency */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Frequency</Label>
                <Select value={rFrequency} onValueChange={(v) => setFrequency(v)}>
                  <SelectTrigger data-testid="select-stock-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly (1st of month)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Day of week — only for weekly */}
              {rFrequency === "weekly" && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Day of Week</Label>
                  <Select value={String(rSendDayOfWeek)} onValueChange={(v) => setSendDayOfWeek(parseInt(v))}>
                    <SelectTrigger data-testid="select-stock-day">
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

              {/* Time */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Send Time (EST)
                  </span>
                </Label>
                <Select value={String(rSendHour)} onValueChange={(v) => setSendHour(parseInt(v))}>
                  <SelectTrigger data-testid="select-stock-hour">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {HOURS.map((h) => (
                      <SelectItem key={h.value} value={h.value}>
                        {h.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Preview label */}
            {rCompanyId && rRecipientId && (
              <p className="text-xs text-muted-foreground">
                {rFrequency === "daily" && `Sends every day at ${formatHour(rSendHour)} EST`}
                {rFrequency === "weekly" &&
                  `Sends every ${DAYS.find((d) => d.value === String(rSendDayOfWeek))?.label ?? "Monday"} at ${formatHour(rSendHour)} EST`}
                {rFrequency === "monthly" && `Sends on the 1st of each month at ${formatHour(rSendHour)} EST`}
              </p>
            )}
          </div>

          <Separator />

          {/* ── Auto-send toggle ─────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Auto-Send</p>
              <p className="text-xs text-muted-foreground">Automatically send reports on the schedule above</p>
            </div>
            <Switch
              data-testid="switch-stock-auto-send"
              checked={cfg?.autoSend ?? false}
              disabled={!canSend || saveSettings.isPending}
              onCheckedChange={(v) => saveSettings.mutate({ autoSend: v, enabled: true })}
            />
          </div>

          {cfg?.lastSentAt && (
            <p className="text-xs text-muted-foreground">Last sent: {new Date(cfg.lastSentAt).toLocaleString()}</p>
          )}

          <Separator />

          {/* ── Save + Send Now ───────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => saveSettings.mutate(undefined)}
              disabled={!canSend || saveSettings.isPending}
              data-testid="button-stock-save"
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
              onClick={() => sendNow.mutate()}
              disabled={!canSend || sendNow.isPending}
              data-testid="button-stock-send-now"
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

            {!canSend && <p className="text-xs text-muted-foreground">Select a company and group first.</p>}
          </div>

          {/* ── What gets sent ───────────────────────────────────────────── */}
          <div className="rounded-md bg-muted/40 p-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">What gets sent:</p>
            <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
              <li>
                <span className="font-medium text-foreground">Stock PDF</span> — current inventory with cost (code,
                name, group, location, qty, unit cost, total value)
              </li>
              <li>
                <span className="font-medium text-foreground">Net Position Excel</span> — 01 Jan{" "}
                {new Date().getFullYear()} → today (revenue, expenses, net profit by month)
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
