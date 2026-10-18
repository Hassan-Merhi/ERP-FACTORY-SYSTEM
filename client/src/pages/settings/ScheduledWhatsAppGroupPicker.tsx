import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, RefreshCw, Search, Users } from "lucide-react";
import type { ClientErrorLike } from "@/lib/clientError";

export interface ScheduledGroup {
  id: number;
  name: string;
  chatId: string;
  active: boolean;
  isGroup: boolean;
}

interface WhatsAppChat {
  id: string;
  name: string;
  type: string;
}

interface Props {
  recipients: ScheduledGroup[];
  selectedIds: number[];
  onChange: (next: number[]) => void;
}

function matches(text: string, search: string): boolean {
  return text.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

/**
 * Uses the same company-scoped recipient endpoints as WhatsApp Export.
 * A discovered group is not saved or subscribed until the user clicks Add.
 */
export function ScheduledWhatsAppGroupPicker({ recipients, selectedIds, onChange }: Props) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [showFinder, setShowFinder] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualChatId, setManualChatId] = useState("");

  const {
    data: chats = [],
    refetch: loadChats,
    isFetching: loadingChats,
    isError: chatsFailed,
    error: chatsError,
    isFetched: chatsFetched,
  } = useQuery<WhatsAppChat[]>({
    queryKey: ["/api/whatsapp/chats"],
    enabled: false,
    retry: false,
    staleTime: 30000,
  });

  const addRecipient = useMutation({
    mutationFn: async (group: { name: string; chatId: string }) => {
      const response = await apiRequest("POST", "/api/whatsapp/recipients", group);
      return (await response.json()) as ScheduledGroup;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      // An added group becomes selected for THIS message; saving the message itself is separate.
      onChange([...new Set([...selectedIds, saved.id])]);
      setManualName("");
      setManualChatId("");
      toast({ title: "Group added and selected", description: saved.name });
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Could not add WhatsApp group",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const activeGroups = recipients.filter((r) => r.active && r.isGroup);
  const visibleSaved = activeGroups.filter((r) => matches(r.name, search) || matches(r.chatId, search));
  const savedChatIds = new Set(activeGroups.map((r) => r.chatId));
  const providerGroups = chats
    .filter((c) => c.type === "group" || c.id.endsWith("@g.us"))
    .filter((c) => matches(c.name, search) || matches(c.id, search))
    .filter((c) => !savedChatIds.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggleGroup = (id: number, checked: boolean) => {
    onChange(checked ? [...new Set([...selectedIds, id])] : selectedIds.filter((selected) => selected !== id));
  };

  const saveManualGroup = () => {
    const chatId = manualChatId.trim();
    const name = manualName.trim();
    if (!name) {
      toast({ title: "Enter a group name", variant: "destructive" });
      return;
    }
    // Names alone cannot route a WhatsApp message. A valid group chat ID is required.
    if (!/^[0-9-]+@g\.us$/i.test(chatId)) {
      toast({
        title: "Invalid group chat ID",
        description: "Use the WhatsApp group ID, for example 120363012345678901@g.us.",
        variant: "destructive",
      });
      return;
    }
    const existing = activeGroups.find((r) => r.chatId === chatId);
    if (existing) {
      toggleGroup(existing.id, true);
      setManualName("");
      setManualChatId("");
      toast({ title: "Existing group selected", description: existing.name });
      return;
    }
    addRecipient.mutate({ name, chatId });
  };

  return (
    <div className="space-y-4" data-testid="scheduled-whatsapp-group-picker">
      <div>
        <Label htmlFor="scheduled-wa-search">Search WhatsApp groups</Label>
        <div className="relative mt-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="scheduled-wa-search"
            className="pl-9"
            placeholder="Search group name or chat ID..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="input-scheduled-wa-group-search"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-medium">
          Saved groups ({activeGroups.length}) · Selected ({selectedIds.length})
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setShowFinder(true);
            void loadChats();
          }}
          disabled={loadingChats}
          data-testid="button-scheduled-wa-find-groups"
        >
          {loadingChats ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          {loadingChats ? "Loading groups..." : "Find groups from WhatsApp"}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 max-h-64 overflow-y-auto">
        {visibleSaved.map((group) => (
          <label key={group.id} className="flex items-center gap-3 border rounded-lg p-3 cursor-pointer min-w-0">
            <Checkbox
              checked={selectedIds.includes(group.id)}
              onCheckedChange={(checked) => toggleGroup(group.id, checked === true)}
              aria-label={"Select " + group.name}
            />
            <span className="min-w-0 flex-1 text-sm truncate" title={group.name}>
              {group.name}
            </span>
          </label>
        ))}
      </div>
      {!visibleSaved.length && (
        <p className="text-sm text-muted-foreground">
          {search ? "No saved groups match your search." : "No saved groups yet. Find or add one below."}
        </p>
      )}

      {showFinder && (
        <div className="space-y-2 rounded-lg border p-3" data-testid="scheduled-wa-available-groups">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4" />
            <p className="text-sm font-medium">Groups from your connected WhatsApp</p>
            {chatsFetched && !chatsFailed && <Badge variant="outline">{providerGroups.length} to add</Badge>}
          </div>
          {chatsFailed && (
            <p className="text-sm text-destructive">
              Unable to load WhatsApp groups:{" "}
              {chatsError instanceof Error ? chatsError.message : "Check your Green API connection."} You can still add
              a group by chat ID below.
            </p>
          )}
          {!loadingChats && !chatsFailed && chatsFetched && !providerGroups.length && (
            <p className="text-sm text-muted-foreground">
              {search
                ? "No additional connected WhatsApp groups match the search."
                : "No additional groups were returned. You can add a group manually below."}
            </p>
          )}
          <div className="max-h-60 overflow-y-auto space-y-2">
            {providerGroups.map((group) => (
              <div key={group.id} className="flex items-center justify-between gap-3 p-2 border rounded-lg">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{group.name}</p>
                  <p className="text-xs text-muted-foreground break-all">{group.id}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={addRecipient.isPending}
                  onClick={() => addRecipient.mutate({ name: group.name, chatId: group.id })}
                  aria-label={"Add " + group.name}
                >
                  <Plus className="w-3 h-3 mr-1" /> Add
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <h4 className="text-sm font-medium">Add group manually</h4>
        <p className="text-xs text-muted-foreground">
          Enter a group name and its WhatsApp group chat ID (ending in @g.us). A group name by itself cannot be used to
          deliver messages.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="scheduled-wa-manual-name">Group name</Label>
            <Input
              id="scheduled-wa-manual-name"
              value={manualName}
              onChange={(event) => setManualName(event.target.value)}
              placeholder="e.g. Factory Staff"
              maxLength={255}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="scheduled-wa-manual-id">Group chat ID</Label>
            <Input
              id="scheduled-wa-manual-id"
              value={manualChatId}
              onChange={(event) => setManualChatId(event.target.value)}
              placeholder="120363012345678901@g.us"
              maxLength={255}
            />
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={addRecipient.isPending || !manualName.trim() || !manualChatId.trim()}
          onClick={saveManualGroup}
          data-testid="button-scheduled-wa-add-manual-group"
        >
          {addRecipient.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 mr-2" />
          )}
          Save group & select it
        </Button>
        <p className="text-xs text-muted-foreground">
          Group changes are saved to the company's WhatsApp recipients. Click Save schedule afterward to apply the
          selected groups to this daily message.
        </p>
      </div>
    </div>
  );
}
