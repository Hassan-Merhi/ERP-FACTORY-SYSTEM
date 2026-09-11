import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import {
  Download,
  Mail,
  MessageSquare,
  ChevronDown,
  Calendar,
  Clock,
  CheckCircle2,
  Loader2,
  EyeOff,
  Eye,
  Trash2,
  Plus,
  Building2,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Recipient, ExportSettings, Company, BackupStatus } from "./ExportCenterTypes";
import type { SettingsMessageResult } from "./settingsTypes";
import { fmt12h, tzLabel } from "./ExportCenterHelpers";
import { TIMEZONES } from "./ExportCenterConstants";
import { BackupStatusCard } from "./BackupStatusCard";
import { ExportProgressDialog } from "./ExportProgressDialog";
import { DataCoverage } from "./DataCoverage";

export function DailyExportSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [newEmail, setNewEmail] = useState("");
  const [gmailUser, setGmailUser] = useState("");
  const [gmailPassword, setGmailPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [scheduleHour, setScheduleHour] = useState<number | null>(null);
  const [scheduleTimezone, setScheduleTimezone] = useState<string | null>(null);
  const [savingScheduleTime, setSavingScheduleTime] = useState(false);

  const [progressOpen, setProgressOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState("");
  const [activeMode, setActiveMode] = useState<"download" | "email">("download");

  const npDefaultEnd = new Date().toLocaleDateString("en-CA");
  const npDefaultStart = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toLocaleDateString("en-CA");
  })();
  const [npStart, setNpStart] = useState(npDefaultStart);
  const [npEnd, setNpEnd] = useState(npDefaultEnd);

  const { data: recipients = [] } = useQuery<Recipient[]>({ queryKey: ["/api/export/recipients"] });
  const { data: settings } = useQuery<ExportSettings>({ queryKey: ["/api/export/settings"] });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["/api/export/companies"] });

  const addRecipient = useMutation({
    mutationFn: (email: string) => apiRequest("POST", "/api/export/recipients", { email }),
    onSuccess: () => {
      setNewEmail("");
      qc.invalidateQueries({ queryKey: ["/api/export/recipients"] });
      toast({ title: "Recipient added" });
    },
    onError: (e: ClientErrorLike) => toast({ variant: "destructive", title: "Error", description: e.message }),
  });

  const removeRecipient = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/export/recipients/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/export/recipients"] });
      toast({ title: "Recipient removed" });
    },
  });

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const body: { scheduleEnabled: boolean; gmailUser?: string; gmailAppPassword?: string } = {
        scheduleEnabled: settings?.scheduleEnabled ?? false,
      };
      if (gmailUser) body.gmailUser = gmailUser;
      if (gmailPassword) body.gmailAppPassword = gmailPassword;
      await apiRequest("PUT", "/api/export/settings", body);
      qc.invalidateQueries({ queryKey: ["/api/export/settings"] });
      setGmailUser("");
      setGmailPassword("");
      toast({ title: "Settings saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: getErrorDetails(e).message });
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleSchedule = async (enabled: boolean) => {
    try {
      await apiRequest("PUT", "/api/export/settings", {
        scheduleEnabled: enabled,
        gmailUser: settings?.gmailUser,
      });
      qc.invalidateQueries({ queryKey: ["/api/export/settings"] });
      const effHour = scheduleHour ?? settings?.scheduleHour ?? 18;
      const effTz = scheduleTimezone ?? settings?.scheduleTimezone ?? "America/New_York";
      toast({
        title: enabled
          ? `Schedule enabled — runs daily at ${fmt12h(effHour)} (${tzLabel(effTz)})`
          : "Schedule disabled",
      });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: getErrorDetails(e).message });
    }
  };

  const saveScheduleTime = async () => {
    setSavingScheduleTime(true);
    try {
      const effHour = scheduleHour ?? settings?.scheduleHour ?? 18;
      const effTz = scheduleTimezone ?? settings?.scheduleTimezone ?? "America/New_York";
      await apiRequest("PUT", "/api/export/settings", {
        scheduleEnabled: settings?.scheduleEnabled ?? false,
        scheduleHour: effHour,
        scheduleTimezone: effTz,
      });
      qc.invalidateQueries({ queryKey: ["/api/export/settings"] });
      toast({ title: `Schedule time saved — runs daily at ${fmt12h(effHour)} (${tzLabel(effTz)})` });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: getErrorDetails(e).message });
    } finally {
      setSavingScheduleTime(false);
    }
  };

  const startExport = async (mode: "download" | "email") => {
    try {
      const body: { mode: "download" | "email"; fromDate?: string; toDate?: string } = { mode };
      if (fromDate) body.fromDate = fromDate;
      if (toDate) body.toDate = toDate;
      const result = await (await apiRequest("POST", "/api/export/start", body)).json();
      setActiveJobId(result.jobId);
      setActiveMode(mode);
      setProgressOpen(true);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not start export", description: getErrorDetails(e).message });
    }
  };

  const { data: waSettings } = useQuery<{
    enabled: boolean;
    dailyAutoSend: boolean;
    dailyRecipientId: number | null;
    hasCredentials: boolean;
  }>({
    queryKey: ["/api/whatsapp/settings"],
  });
  const waReady = !!(waSettings?.enabled && waSettings?.dailyRecipientId);

  const {
    data: backupStatus,
    isFetching: backupFetching,
    refetch: refetchBackup,
  } = useQuery<BackupStatus>({
    queryKey: ["/api/export/backup-status"],
    refetchInterval: 60000,
  });

  const [sendingWa, setSendingWa] = useState(false);
  const sendViaWhatsApp = async () => {
    setSendingWa(true);
    try {
      const body: { fromDate?: string; toDate?: string } = {};
      if (fromDate) body.fromDate = fromDate;
      if (toDate) body.toDate = toDate;
      const data = await (await apiRequest("POST", "/api/daily-export/trigger-whatsapp", body)).json();
      toast({ title: "WhatsApp export started", description: data.message || "Building ZIP and sending." });
      [5, 20, 45, 75, 120].forEach((s) => setTimeout(() => refetchBackup(), s * 1000));
    } catch (e) {
      toast({ variant: "destructive", title: "WhatsApp send failed", description: getErrorDetails(e).message });
    } finally {
      setSendingWa(false);
      refetchBackup();
    }
  };

  const sendNpToWa = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/send-net-position", { startDate: npStart, endDate: npEnd }),
    onSuccess: (data: unknown) =>
      toast({
        title: "Sent via WhatsApp",
        description: (data as SettingsMessageResult | null)?.message || "Net position report sent",
      }),
    onError: (e: ClientErrorLike) => toast({ variant: "destructive", title: "Send failed", description: e.message }),
  });

  const downloadNpExcel = () => {
    const url = `/api/reports/net-position-monthly-excel?startDate=${npStart}&endDate=${npEnd}`;
    window.open(url, "_blank");
  };

  return (
    <div className="space-y-6" data-testid="section-daily-export">
      <div>
        <h3 className="text-lg font-semibold">Daily Full Company Export</h3>
        <p className="text-sm text-muted-foreground mt-1">Export all data for every company bundled in a zip.</p>
      </div>

      {backupStatus && (
        <BackupStatusCard status={backupStatus} onRefresh={() => refetchBackup()} isRefreshing={backupFetching} />
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Companies ({companies.length})
          </CardTitle>
          <CardDescription>All companies will be included in the export.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {companies.map((c) => (
              <Badge key={c.id} variant="secondary" data-testid={`badge-company-${c.id}`}>
                {c.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Download className="h-4 w-4" />
            Export Now
          </CardTitle>
          <CardDescription>Leave dates blank to export full history. Set a range to scope the export.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                From Date
              </Label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-40"
                data-testid="input-export-from-date"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                To Date
              </Label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-40"
                data-testid="input-export-to-date"
              />
            </div>
            {(fromDate || toDate) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFromDate("");
                  setToDate("");
                }}
              >
                Clear (full history)
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={companies.length === 0} data-testid="button-export-now">
                  Export Now <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => startExport("download")} data-testid="menu-export-download">
                  <Download className="h-4 w-4 mr-2" />
                  Download ZIP
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => startExport("email")}
                  disabled={recipients.length === 0 || !settings?.gmailUser}
                  data-testid="menu-export-email"
                >
                  <Mail className="h-4 w-4 mr-2" />
                  Send by Email
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={sendViaWhatsApp}
                  disabled={!waReady || sendingWa}
                  data-testid="menu-export-whatsapp"
                >
                  <MessageSquare className="h-4 w-4 mr-2 text-green-600" />
                  {sendingWa ? "Sending…" : "Send via WhatsApp"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="text-xs text-muted-foreground">
              {fromDate || toDate ? `Filtered: ${fromDate || "—"} → ${toDate || "—"}` : "Full history (all dates)"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-green-600" />
            Net Position Report
          </CardTitle>
          <CardDescription>
            Download or send the monthly net position Excel via WhatsApp for any date range.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                From
              </Label>
              <Input
                type="date"
                value={npStart}
                onChange={(e) => setNpStart(e.target.value)}
                className="w-40"
                data-testid="input-np-start"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                To
              </Label>
              <Input
                type="date"
                value={npEnd}
                onChange={(e) => setNpEnd(e.target.value)}
                className="w-40"
                data-testid="input-np-end"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadNpExcel} data-testid="button-np-download">
              <Download className="h-4 w-4 mr-2" />
              Download Excel
            </Button>
            <Button
              onClick={() => sendNpToWa.mutate()}
              disabled={sendNpToWa.isPending}
              data-testid="button-np-send-whatsapp"
            >
              {sendNpToWa.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send via WhatsApp
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Scheduled Daily Export
          </CardTitle>
          <CardDescription>
            Automatically emails the export to all recipients every day at{" "}
            <strong>{fmt12h(scheduleHour ?? settings?.scheduleHour ?? 18)}</strong> —{" "}
            <strong>{tzLabel(scheduleTimezone ?? settings?.scheduleTimezone ?? "America/New_York")}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Enable daily schedule</p>
              <p className="text-xs text-muted-foreground">
                Runs at {fmt12h(scheduleHour ?? settings?.scheduleHour ?? 18)}, Monday–Sunday
              </p>
            </div>
            <Switch
              checked={settings?.scheduleEnabled ?? false}
              onCheckedChange={toggleSchedule}
              data-testid="switch-schedule-enabled"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Send time</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={String(scheduleHour ?? settings?.scheduleHour ?? 18)}
                onValueChange={(v) => setScheduleHour(Number(v))}
                data-testid="select-schedule-hour"
              >
                <SelectTrigger className="w-32" data-testid="trigger-schedule-hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={String(i)} data-testid={`option-hour-${i}`}>
                      {fmt12h(i)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={scheduleTimezone ?? settings?.scheduleTimezone ?? "America/New_York"}
                onValueChange={(v) => setScheduleTimezone(v)}
                data-testid="select-schedule-timezone"
              >
                <SelectTrigger className="flex-1 min-w-52" data-testid="trigger-schedule-timezone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value} data-testid={`option-tz-${tz.value}`}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={saveScheduleTime}
                disabled={savingScheduleTime}
                data-testid="button-save-schedule-time"
              >
                {savingScheduleTime ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
          </div>
          {settings?.lastRunAt && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-green-600" />
              Last run: {new Date(settings.lastRunAt).toLocaleString()}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Gmail Sender Credentials
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {settings?.gmailUser && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span>
                Currently configured: <span className="font-medium">{settings.gmailUser}</span>
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Gmail Address</Label>
              <Input
                type="email"
                placeholder={settings?.gmailUser || "sender@gmail.com"}
                value={gmailUser}
                onChange={(e) => setGmailUser(e.target.value)}
                data-testid="input-gmail-user"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">App Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="xxxx xxxx xxxx xxxx"
                  value={gmailPassword}
                  onChange={(e) => setGmailPassword(e.target.value)}
                  className="pr-10"
                  data-testid="input-gmail-password"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowPassword((p) => !p)}
                  type="button"
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
          <Button
            onClick={saveSettings}
            disabled={savingSettings || (!gmailUser && !gmailPassword)}
            data-testid="button-save-email-settings"
          >
            {savingSettings ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Credentials"
            )}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Email Recipients ({recipients.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="Add email address..."
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newEmail) addRecipient.mutate(newEmail);
              }}
              data-testid="input-new-recipient"
            />
            <Button
              onClick={() => newEmail && addRecipient.mutate(newEmail)}
              disabled={!newEmail || addRecipient.isPending}
              data-testid="button-add-recipient"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
          {recipients.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email Address</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((r) => (
                  <TableRow key={r.id} data-testid={`row-recipient-${r.id}`}>
                    <TableCell className="font-mono text-sm">{r.email}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeRecipient.mutate(r.id)}
                        data-testid={`button-remove-recipient-${r.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No recipients yet. Add an email address above.
            </p>
          )}
        </CardContent>
      </Card>

      <Separator />
      <DataCoverage />

      {activeJobId && (
        <ExportProgressDialog
          jobId={activeJobId}
          mode={activeMode}
          open={progressOpen}
          onClose={() => {
            setProgressOpen(false);
            setActiveJobId("");
            refetchBackup();
          }}
        />
      )}
    </div>
  );
}
