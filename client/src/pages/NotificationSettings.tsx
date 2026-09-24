import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import {
  Bell,
  Truck,
  FileText,
  ArrowLeftRight,
  CheckCircle2,
  X,
  Loader2,
  Shield,
  Search,
  UserPlus,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface NotifRule {
  id: number;
  eventType: string;
  recipientUserId: string;
  isEnabled: boolean;
}

interface UserItem {
  id: string;
  username: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  {
    id: "LOADING_STARTED",
    label: "Loading Started",
    description: "Triggered when a new loading order is created.",
    icon: Truck,
    group: "Loading",
    color: "text-blue-500",
    bg: "bg-blue-500/10",
  },
  {
    id: "LOADING_FINALIZED",
    label: "Loading Finalized",
    description: "Triggered when bales are submitted for verification.",
    icon: CheckCircle2,
    group: "Loading",
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
  },
  {
    id: "INVOICE_PENDING",
    label: "Invoice Pending",
    description: "Triggered when a loading is submitted and awaiting verification.",
    icon: FileText,
    group: "Invoice",
    color: "text-amber-500",
    bg: "bg-amber-500/10",
  },
  {
    id: "INVOICE_FINALIZED",
    label: "Invoice Finalized",
    description: "Triggered when an invoice is approved and posted.",
    icon: CheckCircle2,
    group: "Invoice",
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
  },
  {
    id: "INTERCOMPANY_REQUEST",
    label: "Intercompany Request",
    description: "Triggered when a new intercompany payment request is created.",
    icon: ArrowLeftRight,
    group: "Intercompany",
    color: "text-purple-500",
    bg: "bg-purple-500/10",
  },
] as const;

const GROUP_ICONS: Record<string, typeof Truck> = {
  Loading: Truck,
  Invoice: FileText,
  Intercompany: ArrowLeftRight,
};

const GROUP_COLORS: Record<string, string> = {
  Loading: "text-blue-500",
  Invoice: "text-amber-500",
  Intercompany: "text-purple-500",
};

// ── User initials helper ───────────────────────────────────────────────────────

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

// ── Searchable user picker ─────────────────────────────────────────────────────

function UserPicker({
  users,
  onAdd,
  disabled,
  eventId,
}: {
  users: UserItem[];
  onAdd: (userId: string) => void;
  disabled: boolean;
  eventId: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = users.filter((u) => searchAny(search, u.username));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (u: UserItem) => {
    onAdd(u.id);
    setSearch("");
    setOpen(false);
  };

  if (users.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setSearch("");
              }
              if (e.key === "Enter" && filtered.length === 1) {
                handleSelect(filtered[0]);
              }
            }}
            placeholder="Search user to add…"
            className="pl-8 h-8 text-sm"
            disabled={disabled}
            data-testid={`input-search-user-${eventId}`}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || filtered.length === 0 || !search.trim()}
          onClick={() => {
            if (filtered.length === 1) handleSelect(filtered[0]);
          }}
          className="h-8 px-3 gap-1.5 text-xs"
          data-testid={`button-add-user-${eventId}`}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {open && filtered.length > 0 && search.trim() !== "" && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-popover shadow-md overflow-hidden">
          {filtered.slice(0, 8).map((u) => (
            <button
              key={u.id}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover-elevate text-left"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(u);
              }}
              data-testid={`option-user-${u.id}`}
            >
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-muted text-[10px] font-semibold shrink-0">
                {initials(u.username)}
              </span>
              <span>{u.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function NotificationSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading: rulesLoading } = useQuery<NotifRule[]>({
    queryKey: ["/api/notification-rules"],
    queryFn: async () => {
      const r = await fetch("/api/notification-rules", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load rules");
      return r.json();
    },
  });

  const { data: allUsers = [], isLoading: usersLoading } = useQuery<UserItem[]>({
    queryKey: ["/api/notification-users"],
    queryFn: async () => {
      const r = await fetch("/api/notification-users", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load users");
      return r.json();
    },
  });

  const ruleMap: Record<string, string[]> = {};
  for (const rule of rules) {
    if (!ruleMap[rule.eventType]) ruleMap[rule.eventType] = [];
    ruleMap[rule.eventType].push(rule.recipientUserId);
  }

  const saveMutation = useMutation({
    mutationFn: ({ eventType, recipientUserIds }: { eventType: string; recipientUserIds: string[] }) =>
      apiRequest("PUT", "/api/notification-rules", { eventType, recipientUserIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notification-rules"] });
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const addRecipient = (eventType: string, userId: string) => {
    const current = ruleMap[eventType] ?? [];
    if (current.includes(userId)) return;
    saveMutation.mutate({ eventType, recipientUserIds: [...current, userId] });
  };

  const removeRecipient = (eventType: string, userId: string) => {
    const current = ruleMap[eventType] ?? [];
    saveMutation.mutate({ eventType, recipientUserIds: current.filter((id) => id !== userId) });
  };

  const getUserName = (uid: string) => allUsers.find((u) => u.id === uid)?.username ?? uid;

  const groups = Array.from(new Set(EVENT_TYPES.map((e) => e.group)));

  if (rulesLoading || usersLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary/10">
            <Bell className="h-4 w-4 text-primary" />
          </div>
          <h1 className="text-lg font-semibold">Notification Settings</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-10.5">
          Configure which users receive notifications for each system event.
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2 ml-10.5">
          <Shield className="h-3.5 w-3.5" />
          Admin and Developer only
        </div>
      </div>

      <Separator />

      {/* Groups */}
      {groups.map((group) => {
        const GroupIcon = GROUP_ICONS[group] ?? Bell;
        const groupColor = GROUP_COLORS[group] ?? "text-muted-foreground";
        const groupEvents = EVENT_TYPES.filter((e) => e.group === group);

        return (
          <section key={group} className="space-y-3">
            {/* Group label */}
            <div className="flex items-center gap-2">
              <GroupIcon className={`h-3.5 w-3.5 ${groupColor}`} />
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{group}</span>
            </div>

            <div className="space-y-2">
              {groupEvents.map((event) => {
                const EventIcon = event.icon;
                const recipients = ruleMap[event.id] ?? [];
                const unselected = allUsers.filter((u) => !recipients.includes(u.id));
                const isSaving = saveMutation.isPending;

                return (
                  <div key={event.id} className="rounded-lg border bg-card" data-testid={`card-event-${event.id}`}>
                    {/* Event header */}
                    <div className="flex items-start gap-3 px-4 pt-4 pb-3">
                      <div
                        className={`flex items-center justify-center h-7 w-7 rounded-md ${event.bg} shrink-0 mt-0.5`}
                      >
                        <EventIcon className={`h-3.5 w-3.5 ${event.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight">{event.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{event.description}</p>
                      </div>
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full shrink-0">
                        {recipients.length} {recipients.length === 1 ? "user" : "users"}
                      </span>
                    </div>

                    {/* Recipients row */}
                    <div className="px-4 pb-3 space-y-3">
                      {recipients.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {recipients.map((uid) => (
                            <span
                              key={uid}
                              className="inline-flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-full border bg-muted/60 text-xs font-medium"
                              data-testid={`badge-recipient-${event.id}-${uid}`}
                            >
                              <span className="flex items-center justify-center h-4 w-4 rounded-full bg-primary/20 text-[9px] font-bold text-primary">
                                {initials(getUserName(uid))}
                              </span>
                              {getUserName(uid)}
                              <button
                                onClick={() => removeRecipient(event.id, uid)}
                                disabled={isSaving}
                                className="flex items-center justify-center h-4 w-4 rounded-full hover:bg-destructive/20 hover:text-destructive transition-colors opacity-60 hover:opacity-100"
                                data-testid={`button-remove-${event.id}-${uid}`}
                                title="Remove"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">No recipients — nobody will be notified.</p>
                      )}

                      {/* Searchable add */}
                      {unselected.length > 0 && (
                        <UserPicker
                          users={unselected}
                          onAdd={(uid) => addRecipient(event.id, uid)}
                          disabled={isSaving}
                          eventId={event.id}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
