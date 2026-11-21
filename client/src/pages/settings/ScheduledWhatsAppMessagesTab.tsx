import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, CheckCircle2, Clock, Pencil, Plus, Trash2, MessageSquare } from "lucide-react";
import { ScheduledWhatsAppGroupPicker } from "./ScheduledWhatsAppGroupPicker";
import { confirmAction } from "@/components/ConfirmHost";
import { days, formatDays } from "./ScheduledWhatsAppMessagesTabHelpers";
import { useScheduledWhatsAppMessagesTabState } from "./useScheduledWhatsAppMessagesTabState";

export function ScheduledWhatsAppMessagesTab() {
  const {
    companyId,
    editingId,
    form,
    setForm,
    editorOpen,
    setEditorOpen,
    loading,
    schedulesError,
    schedules,
    refetchSchedules,
    whatsappSettings,
    recipients,
    history,
    groups,
    save,
    remove,
    beginNew,
    beginEdit,
    setField,
    submit,
  } = useScheduledWhatsAppMessagesTabState();

  return (
    <div className="space-y-6 max-w-5xl" data-testid="scheduled-whatsapp-messages-settings">
      <div className="flex flex-wrap gap-3 items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold flex gap-2 items-center">
            <MessageSquare className="h-6 w-6" /> Scheduled WhatsApp Messages
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            Create custom text messages, choose different times for each day, and send automatically to multiple groups.
            Schedules follow the selected timezone, even when you are not logged in.
          </p>
        </div>
        <Button onClick={beginNew} data-testid="button-add-scheduled-whatsapp-message">
          <Plus className="w-4 h-4 mr-2" /> New message
        </Button>
      </div>

      {whatsappSettings && (!whatsappSettings.enabled || !whatsappSettings.hasCredentials) && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            Automatic messages require the main WhatsApp connection and its master switch to be enabled. Configure them
            in Settings → Export Center → WhatsApp Export.
          </CardContent>
        </Card>
      )}

      {!groups.length && !editorOpen && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            No WhatsApp groups are saved for this company yet. Click New message, then search your connected groups or
            add a group manually.
          </CardContent>
        </Card>
      )}

      {editorOpen && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit scheduled message" : "Create scheduled message"}</CardTitle>
            <CardDescription>
              Messages and changes are saved on the server. No group receives anything until its scheduled time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="wa-message-title">Schedule name</Label>
              <Input
                id="wa-message-title"
                maxLength={120}
                placeholder="Daily staff reminder"
                value={form.title}
                onChange={(e) => setField("title", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wa-message-body">WhatsApp message</Label>
              <Textarea
                id="wa-message-body"
                rows={5}
                maxLength={4000}
                placeholder="Type the message exactly as the groups should receive it..."
                value={form.message}
                onChange={(e) => setField("message", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{form.message.length} / 4000 characters · Edit anytime</p>
            </div>

            <div className="space-y-3">
              <h3 className="font-medium flex gap-2 items-center">
                <Clock className="w-4 h-4" /> Days and send times
              </h3>
              <p className="text-sm text-muted-foreground">
                Switch a day off to skip it. Each active day can have its own time.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {days.map((day, index) => {
                  const key = String(index);
                  const on = !!form.weeklyTimes[key];
                  return (
                    <div key={key} className="flex items-center gap-3 rounded-lg border p-3">
                      <Switch
                        checked={on}
                        aria-label={"Send on " + day}
                        onCheckedChange={(checked) =>
                          setForm((prev) => {
                            const times = { ...prev.weeklyTimes };
                            if (checked) times[key] = "09:00";
                            else delete times[key];
                            return { ...prev, weeklyTimes: times };
                          })
                        }
                      />
                      <span className="text-sm flex-1">{day}</span>
                      <Input
                        aria-label={day + " time"}
                        type="time"
                        className="w-32"
                        disabled={!on}
                        value={form.weeklyTimes[key] || "09:00"}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            weeklyTimes: { ...prev.weeklyTimes, [key]: e.target.value },
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="wa-timezone">Timezone</Label>
                <Input
                  id="wa-timezone"
                  placeholder="Asia/Beirut"
                  value={form.timezone}
                  onChange={(e) => setField("timezone", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wa-start-date">Start date (optional)</Label>
                <Input
                  id="wa-start-date"
                  type="date"
                  value={form.startDate || ""}
                  onChange={(e) => setField("startDate", e.target.value || null)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wa-end-date">End date (optional)</Label>
                <Input
                  id="wa-end-date"
                  type="date"
                  value={form.endDate || ""}
                  onChange={(e) => setField("endDate", e.target.value || null)}
                />
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="font-medium">Send to WhatsApp groups</h3>
              <p className="text-sm text-muted-foreground">
                Search saved groups, find groups from your connected WhatsApp, or add new groups manually. You can
                select as many groups as you need.
              </p>
              <ScheduledWhatsAppGroupPicker
                key={String(companyId ?? "no-company")}
                recipients={recipients}
                selectedIds={form.recipientIds}
                onChange={(ids) => setField("recipientIds", ids)}
              />
            </div>

            <div className="flex items-center justify-between gap-4 border rounded-lg p-3">
              <div>
                <p className="text-sm font-medium">Automatic sending enabled</p>
                <p className="text-xs text-muted-foreground">Switch off to pause this entire message schedule.</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(value) => setField("enabled", value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={save.isPending} onClick={submit}>
                {save.isPending ? "Saving..." : "Save schedule"}
              </Button>
              <Button variant="outline" onClick={() => setEditorOpen(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="w-5 h-5" /> Your scheduled messages
          </CardTitle>
          <CardDescription>Separate messages can have separate days, times, and group selections.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && <LoadingState title="Loading schedules..." />}
          {!loading && schedulesError && !schedules.length && (
            <ErrorState onAction={() => void refetchSchedules()} actionLabel="Try again" />
          )}
          {!loading && !schedulesError && !schedules.length && <EmptyState title="No scheduled messages yet." />}
          {schedules.map((item) => (
            <div key={item.id} className="rounded-lg border p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{item.title}</span>
                  <Badge variant={item.enabled ? "secondary" : "outline"}>{item.enabled ? "Active" : "Paused"}</Badge>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => beginEdit(item)}>
                    <Pencil className="w-3 h-3 mr-1" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={async () => {
                      const confirmed = await confirmAction({
                        title: "Delete this scheduled message?",
                        description: "The message and its history will be deleted.",
                        confirmText: "Delete",
                        tone: "destructive",
                      });
                      if (confirmed) remove.mutate(item.id);
                    }}
                    aria-label={"Delete " + item.title}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{item.message}</p>
              <p className="text-xs text-muted-foreground">
                {formatDays(item.weeklyTimes)} · {item.timezone}
              </p>
              <p className="text-xs text-muted-foreground">
                Groups:{" "}
                {item.recipientIds.map((id) => recipients.find((r) => r.id === id)?.name || "Removed group").join(", ")}
              </p>
              {(item.startDate || item.endDate) && (
                <p className="text-xs text-muted-foreground">
                  Date range: {item.startDate || "Any"} to {item.endDate || "Ongoing"}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex gap-2 items-center">
            <CheckCircle2 className="w-5 h-5" /> Send history
          </CardTitle>
          <CardDescription>Latest 100 delivery attempts. A separate result is recorded for each group.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!history.length && <EmptyState title="No messages have been sent yet." />}
          {history.map((entry) => (
            <div key={entry.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-sm">
              <div>
                <p className="font-medium">
                  {entry.title} → {entry.recipientName}
                </p>
                <p className="text-xs text-muted-foreground">{entry.localDate}</p>
                {entry.error && <p className="text-xs text-destructive break-words">{entry.error}</p>}
              </div>
              <Badge variant={entry.status === "failed" ? "destructive" : "outline"}>{entry.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
