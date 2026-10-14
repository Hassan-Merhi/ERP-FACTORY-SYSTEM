import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Users,
  CheckCircle,
  XCircle,
  Loader2,
  MapPin,
  Search,
  RefreshCw,
  Check,
  X,
} from "lucide-react";

interface CompanyWaSetting {
  companyId: number;
  companyName: string;
  groupChatId: string;
}

interface TransferWaSettings {
  companies: CompanyWaSetting[];
  hasCredentials: boolean;
  waEnabled: boolean;
}

interface GreenChat {
  id: string;
  name: string;
  type: string;
}

interface LocationItem {
  id: number;
  name: string;
  transferWaGroupChatId?: string | null;
}

import { CompanyRow } from "./CompanyRow";

export function TransferWhatsAppSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chats, setChats] = useState<GreenChat[]>([]);
  const [savingCompany, setSavingCompany] = useState<number | null>(null);

  // Per-location dialog state
  const [locDialogOpen, setLocDialogOpen] = useState(false);
  const [editingLoc, setEditingLoc] = useState<LocationItem | null>(null);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [chatSearch, setChatSearch] = useState("");

  const { data: settings, isLoading } = useQuery<TransferWaSettings>({
    queryKey: ["/api/git/transfer-wa-settings"],
    enabled: expanded,
  });

  const { data: locations = [], isLoading: locLoading } = useQuery<LocationItem[]>({
    queryKey: ["/api/locations"],
    enabled: expanded,
  });

  async function loadChats() {
    if (chats.length > 0) return;
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

  async function saveCompany(companyId: number, groupChatId: string) {
    setSavingCompany(companyId);
    try {
      const res = await apiRequest("PATCH", `/api/git/transfer-wa-settings/${companyId}`, { groupChatId });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to save" }));
        throw new Error(err.message);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/git/transfer-wa-settings"] });
      toast({ title: "Saved", description: `Transfer WA group updated for company.` });
    } catch (e) {
      toast({ title: "Error", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setSavingCompany(null);
    }
  }

  const saveLocGroupMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      transferWaGroupChatId,
    }: {
      id: number;
      name: string;
      transferWaGroupChatId: string | null;
    }) => {
      const res = await apiRequest("PATCH", `/api/locations/${id}`, { name, transferWaGroupChatId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({ title: "Saved", description: `Transfer group updated for location.` });
      setLocDialogOpen(false);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function openLocDialog(loc: LocationItem) {
    setEditingLoc(loc);
    setSelectedChatId(loc.transferWaGroupChatId ?? "");
    setChatSearch("");
    loadChats();
    setLocDialogOpen(true);
  }

  function handleSaveLocGroup() {
    if (!editingLoc) return;
    saveLocGroupMutation.mutate({
      id: editingLoc.id,
      name: editingLoc.name,
      transferWaGroupChatId: selectedChatId || null,
    });
  }

  const filteredChats = chats.filter((c) => c.name.toLowerCase().includes(chatSearch.toLowerCase()));

  const locConfiguredCount = locations.filter((l) => l.transferWaGroupChatId).length;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 hover-elevate"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-toggle-transfer-wa"
      >
        <div className="flex items-center gap-3">
          <ArrowLeftRight className="h-4 w-4 text-blue-500" />
          <div className="text-left">
            <p className="text-sm font-medium">Stock Transfers — WhatsApp</p>
            <p className="text-xs text-muted-foreground">
              Send a transfer image to a specific group per destination location, or fall back to a company-wide group.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {locConfiguredCount > 0 && (
            <Badge variant="secondary" className="text-xs">
              {locConfiguredCount} location{locConfiguredCount !== 1 ? "s" : ""} configured
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

              {/* ── Per-location groups ── */}
              <div className="space-y-2">
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" /> Group per Destination Location
                </Label>
                <p className="text-xs text-muted-foreground">
                  When a transfer arrives at a location, the image is sent to that location's group. If a location has
                  no group set, it falls back to the company-wide group below.
                </p>
              </div>

              {locLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading locations…
                </div>
              ) : locations.length === 0 ? (
                <p className="text-xs text-muted-foreground">No locations found.</p>
              ) : (
                <div className="space-y-2">
                  {locations.map((loc) => {
                    const chatId = loc.transferWaGroupChatId;
                    const matchedChat = chats.find((c) => c.id === chatId);
                    return (
                      <div
                        key={loc.id}
                        className="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-2.5 flex-wrap"
                        data-testid={`row-transfer-loc-${loc.id}`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`h-2 w-2 rounded-full shrink-0 ${chatId ? "bg-green-500" : "bg-muted-foreground/30"}`}
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium leading-tight">{loc.name}</p>
                            {chatId ? (
                              <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                                {matchedChat?.name ?? chatId}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground mt-0.5">Uses company fallback</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {chatId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={saveLocGroupMutation.isPending}
                              onClick={() =>
                                saveLocGroupMutation.mutate({ id: loc.id, name: loc.name, transferWaGroupChatId: null })
                              }
                              data-testid={`button-clear-loc-transfer-wa-${loc.id}`}
                            >
                              <X className="h-3.5 w-3.5 mr-1" />
                              Clear
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openLocDialog(loc)}
                            data-testid={`button-set-loc-transfer-wa-${loc.id}`}
                          >
                            <MapPin
                              className={`h-3.5 w-3.5 mr-1.5 ${chatId ? "text-green-600 dark:text-green-400" : ""}`}
                            />
                            {chatId ? "Change" : "Set Group"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <Separator />

              {/* ── Company fallback groups ── */}
              <div className="space-y-2">
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Company Fallback Group
                </Label>
                <p className="text-xs text-muted-foreground">
                  Used for any destination location that doesn't have its own group set above.
                </p>
              </div>

              <div className="space-y-2">
                {(settings?.companies ?? []).map((company) => (
                  <CompanyRow
                    key={company.companyId}
                    company={company}
                    chats={chats}
                    chatsLoading={chatsLoading}
                    hasCredentials={settings?.hasCredentials ?? false}
                    onLoadChats={loadChats}
                    onSave={saveCompany}
                    isSaving={savingCompany === company.companyId}
                  />
                ))}
              </div>

              <Separator />

              <div className="rounded-md bg-muted/40 p-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">What gets sent:</p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                  <li>A PNG image card with the transfer date</li>
                  <li>From and To location names</li>
                  <li>Table of all items with quantity and unit of measure</li>
                  <li>No costs or pricing — quantities only</li>
                </ul>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Location group picker dialog ── */}
      <Dialog
        open={locDialogOpen}
        onOpenChange={(o) => {
          if (!o) setLocDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set Transfer Group</DialogTitle>
            <DialogDescription>
              Choose the WhatsApp group for transfers arriving at <strong>{editingLoc?.name}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search groups…"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                className="pl-8"
                data-testid="input-loc-transfer-chat-search"
              />
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                setChats([]);
                loadChats();
              }}
              disabled={chatsLoading}
              data-testid="button-refresh-loc-transfer-chats"
              title="Refresh groups"
            >
              <RefreshCw className={`h-4 w-4 ${chatsLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="border rounded-md overflow-y-auto max-h-64">
            {chatsLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading groups…
              </div>
            ) : (
              <>
                <button
                  className={`w-full text-left px-3 py-2 text-sm hover-elevate flex items-center gap-2 ${!selectedChatId ? "bg-muted font-medium" : ""}`}
                  onClick={() => setSelectedChatId("")}
                  data-testid="option-loc-transfer-no-group"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                  Use company fallback
                  {!selectedChatId && <Check className="h-4 w-4 ml-auto text-green-600 dark:text-green-400" />}
                </button>
                {filteredChats.length === 0 && (
                  <p className="text-center text-muted-foreground text-sm py-4 px-3">
                    {chats.length === 0
                      ? "No WhatsApp groups found. Make sure the API instance is connected."
                      : "No groups match your search."}
                  </p>
                )}
                {filteredChats.map((chat) => (
                  <button
                    key={chat.id}
                    className={`w-full text-left px-3 py-2 text-sm hover-elevate flex items-center gap-2 ${selectedChatId === chat.id ? "bg-muted font-medium" : ""}`}
                    onClick={() => setSelectedChatId(chat.id)}
                    data-testid={`option-loc-transfer-chat-${chat.id}`}
                  >
                    <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{chat.name}</span>
                    {selectedChatId === chat.id && (
                      <Check className="h-4 w-4 ml-auto shrink-0 text-green-600 dark:text-green-400" />
                    )}
                  </button>
                ))}
              </>
            )}
          </div>

          {selectedChatId && (
            <p className="text-xs text-muted-foreground">
              Selected: <code className="font-mono">{selectedChatId}</code>
            </p>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLocDialogOpen(false)}
              data-testid="button-cancel-loc-transfer-wa"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveLocGroup}
              disabled={saveLocGroupMutation.isPending}
              data-testid="button-save-loc-transfer-wa"
            >
              {saveLocGroupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
