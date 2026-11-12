import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Loader2, MessageCircle, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequestPrivileged } from "@/lib/queryClient";

interface PropertiesWaSettings {
  chatId: string;
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  sendTime: string;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
  periodMode: "current_month" | "previous_month";
}
interface WhatsAppChat {
  id: string;
  name: string;
  type: string;
}
interface Delivery {
  mode: "manual" | "scheduled";
  chat_id: string;
  from_date: string | null;
  to_date: string | null;
  status: string;
  error: string | null;
  created_at: string;
}
const defaults: PropertiesWaSettings = {
  chatId: "",
  enabled: false,
  frequency: "monthly",
  sendTime: "09:00",
  dayOfWeek: 1,
  dayOfMonth: 1,
  timezone: "Asia/Beirut",
  periodMode: "previous_month",
};
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function jsonRequest(url: string, method = "GET", body?: unknown) {
  // All state-changing requests use the shared CSRF-aware transport and never
  // enter an offline write queue (WhatsApp sends must not replay later).
  const response =
    method === "GET" ? await fetch(url, { credentials: "include" }) : await apiRequestPrivileged(method, url, body);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || `WhatsApp request failed (${response.status})`);
  return data;
}

export function PropertiesWhatsAppStatement({
  accountId,
  accountName,
  fromDate,
  toDate,
  compact = false,
}: {
  accountId: number;
  accountName: string;
  fromDate?: string | null;
  toDate?: string | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PropertiesWaSettings>(defaults);
  const [filter, setFilter] = useState<"all" | "group" | "person">("all");
  const [search, setSearch] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const endpoint = `/api/properties/accounts/${accountId}/whatsapp-statement`;
  const settingsKey = ["properties-account-wa-statement", accountId];
  const historyKey = ["properties-account-wa-history", accountId];

  const {
    data: settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useQuery<PropertiesWaSettings>({
    queryKey: settingsKey,
    queryFn: () => jsonRequest(endpoint),
    enabled: open,
    staleTime: 0,
  });
  const { data: chats = [], isLoading: chatsLoading } = useQuery<WhatsAppChat[]>({
    queryKey: ["properties-wa-available-chats"],
    queryFn: () => jsonRequest("/api/whatsapp/chats/pos"),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const { data: history = [] } = useQuery<Delivery[]>({
    queryKey: historyKey,
    queryFn: () => jsonRequest(endpoint + "/history"),
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (open && settings) {
      setDraft(settings);
      setNewPhone("");
    }
  }, [open, settings, accountId]);

  const displayedChats = useMemo(
    () =>
      chats
        .filter((chat) => {
          const isGroup = chat.id.endsWith("@g.us");
          if ((filter === "group" && !isGroup) || (filter === "person" && isGroup)) return false;
          const q = search.trim().toLowerCase();
          return !q || chat.name.toLowerCase().includes(q) || chat.id.toLowerCase().includes(q);
        })
        .slice(0, 100),
    [chats, filter, search]
  );

  const saveMutation = useMutation({
    mutationFn: async (settingsToSave: PropertiesWaSettings) => jsonRequest(endpoint, "PUT", settingsToSave),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKey });
      toast({ title: "Properties WhatsApp settings saved" });
    },
    onError: (error: Error) =>
      toast({
        title: "Could not save WhatsApp settings",
        description: error.message,
        variant: "destructive",
      }),
  });
  const sendMutation = useMutation({
    mutationFn: async () => {
      // One-click manual delivery also saves the chosen recipient. The selected
      // automatic schedule is not silently enabled; it uses the checkbox below.
      await jsonRequest(endpoint, "PUT", draft);
      await queryClient.invalidateQueries({ queryKey: settingsKey });
      return jsonRequest(endpoint + "/send", "POST", {
        requestId: crypto.randomUUID(),
        startDate: fromDate || null,
        endDate: toDate || null,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: historyKey });
      toast({ title: "WhatsApp accepted the statement PDF", description: "Check the selected chat for delivery." });
    },
    onError: (error: Error) => {
      void queryClient.invalidateQueries({ queryKey: historyKey });
      toast({ title: "Statement not confirmed", description: error.message, variant: "destructive" });
    },
  });
  const busy = settingsLoading || saveMutation.isPending || sendMutation.isPending;
  const recipient = chats.find((chat) => chat.id === draft.chatId);
  const recipientLabel = recipient?.name || draft.chatId || "No recipient selected";
  const setField = <K extends keyof PropertiesWaSettings>(key: K, value: PropertiesWaSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
          setSearch("");
        }}
        data-testid="properties-account-whatsapp-statement"
        title="Send or schedule this Properties account statement on WhatsApp"
      >
        <MessageCircle className="h-4 w-4 text-green-500" />
        {!compact && <span className="ml-2">WhatsApp</span>}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-500" />
              WhatsApp Account Statements
            </DialogTitle>
            <DialogDescription>
              {accountName} · Send the selected ledger period now, or automatically deliver a PDF on a schedule.
            </DialogDescription>
          </DialogHeader>

          {settingsError && (
            <p className="text-sm text-destructive">
              {settingsError instanceof Error ? settingsError.message : "Unable to load account settings"}
            </p>
          )}

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Send to a WhatsApp group or person</Label>
              <div className="flex gap-2 flex-wrap">
                {(["all", "group", "person"] as const).map((item) => (
                  <Button
                    key={item}
                    type="button"
                    size="sm"
                    variant={filter === item ? "default" : "outline"}
                    onClick={() => setFilter(item)}
                  >
                    {item === "all" ? "All chats" : item === "group" ? "Groups" : "People"}
                  </Button>
                ))}
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search connected WhatsApp chats"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="max-h-36 overflow-y-auto rounded-md border">
                {chatsLoading && <p className="p-3 text-xs text-muted-foreground">Loading connected chats…</p>}
                {!chatsLoading && displayedChats.length === 0 && (
                  <p className="p-3 text-xs text-muted-foreground">No matching chats. Enter a phone number below.</p>
                )}
                {displayedChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => {
                      setField("chatId", chat.id);
                      setNewPhone("");
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted ${draft.chatId === chat.id ? "bg-primary/10" : ""}`}
                  >
                    <span className="truncate">
                      {chat.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {chat.id.endsWith("@g.us") ? "Group" : "Person"}
                      </span>
                    </span>
                    {draft.chatId === chat.id && <Check className="h-4 w-4 text-green-500 shrink-0" />}
                  </button>
                ))}
              </div>
              <Label htmlFor="properties-wa-phone">Or add a person's phone number (including country code)</Label>
              <Input
                id="properties-wa-phone"
                value={newPhone}
                placeholder="e.g. +96170123456"
                onChange={(event) => {
                  setNewPhone(event.target.value);
                  setField("chatId", event.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Selected: {recipientLabel}. Group chats must be available to your connected WhatsApp instance.
              </p>
            </div>

            <div className="rounded-lg border p-3 space-y-3">
              <div className="flex items-center gap-3">
                <Checkbox
                  id="properties-wa-auto"
                  checked={draft.enabled}
                  onCheckedChange={(value) => setField("enabled", value === true)}
                />
                <Label htmlFor="properties-wa-auto" className="flex items-center gap-2 cursor-pointer">
                  <CalendarClock className="w-4 h-4" /> Send automatically on a schedule
                </Label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Frequency</Label>
                  <Select
                    value={draft.frequency}
                    onValueChange={(value) => setField("frequency", value as PropertiesWaSettings["frequency"])}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Every day</SelectItem>
                      <SelectItem value="weekly">Every week</SelectItem>
                      <SelectItem value="monthly">Every month</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Send time</Label>
                  <Input
                    type="time"
                    value={draft.sendTime}
                    onChange={(event) => setField("sendTime", event.target.value)}
                  />
                </div>
                {draft.frequency === "weekly" && (
                  <div className="space-y-1.5">
                    <Label>Day of week</Label>
                    <Select
                      value={String(draft.dayOfWeek)}
                      onValueChange={(value) => setField("dayOfWeek", Number(value))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {days.map((day, index) => (
                          <SelectItem key={day} value={String(index)}>
                            {day}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {draft.frequency === "monthly" && (
                  <div className="space-y-1.5">
                    <Label>Day of month</Label>
                    <Select
                      value={String(draft.dayOfMonth)}
                      onValueChange={(value) => setField("dayOfMonth", Number(value))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                          <SelectItem key={day} value={String(day)}>
                            {day}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>PDF statement period</Label>
                  <Select
                    value={draft.periodMode}
                    onValueChange={(value) => setField("periodMode", value as PropertiesWaSettings["periodMode"])}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="previous_month">Previous full month</SelectItem>
                      <SelectItem value="current_month">Current month to date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>Time zone</Label>
                  <Input
                    value={draft.timezone}
                    onChange={(event) => setField("timezone", event.target.value)}
                    placeholder="Asia/Beirut"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Automatic sends are off until enabled and saved. A scheduled PDF is sent at most once per account per
                day.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Recent deliveries</Label>
              <div className="max-h-32 overflow-y-auto rounded-md border text-xs">
                {history.length === 0 && <p className="p-3 text-muted-foreground">No statement sends yet.</p>}
                {history.slice(0, 8).map((item, index) => (
                  <div key={index} className="flex items-center justify-between gap-3 border-b last:border-0 px-3 py-2">
                    <span>
                      {item.mode === "scheduled" ? "Auto" : "Manual"} · {new Date(item.created_at).toLocaleString()}
                    </span>
                    <span
                      title={item.error || ""}
                      className={item.status === "accepted" ? "text-green-600" : "text-amber-600"}
                    >
                      {item.status === "accepted" ? "Accepted by WhatsApp" : item.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <div className="flex gap-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !draft.chatId.trim()}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Save settings
              </Button>
              <Button type="button" disabled={busy || !draft.chatId.trim()} onClick={() => sendMutation.mutate()}>
                {sendMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Send className="w-4 h-4 mr-1" />
                )}
                Save &amp; Send Now
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
