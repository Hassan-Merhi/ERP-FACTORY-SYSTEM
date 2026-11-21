// Extracted from ./WhatsAppExportSection.tsx
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Plus, Trash2, Users, CheckCircle, XCircle } from "lucide-react";
import { useWhatsAppExportSectionState } from "./useWhatsAppExportSectionState";

export function WhatsAppExportSectionContent({
  addFromChat,
  addRecipient,
  deleteRecipient,
  groups,
  handleFetchChats,
  loadingChats,
  loadingRecipients,
  newChatId,
  newName,
  recipients,
  recipientsError,
  refetchRecipients,
  setNewChatId,
  setNewName,
  settings,
  showGroupPicker,
  toggleActive,
}: Pick<
  ReturnType<typeof useWhatsAppExportSectionState>,
  | "addFromChat"
  | "addRecipient"
  | "deleteRecipient"
  | "groups"
  | "handleFetchChats"
  | "loadingChats"
  | "loadingRecipients"
  | "newChatId"
  | "newName"
  | "recipients"
  | "recipientsError"
  | "refetchRecipients"
  | "setNewChatId"
  | "setNewName"
  | "settings"
  | "showGroupPicker"
  | "toggleActive"
>) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-medium">Recipients</p>
        <Button
          size="default"
          variant="outline"
          onClick={handleFetchChats}
          disabled={!settings?.hasCredentials || loadingChats}
          data-testid="button-wa-fetch-groups"
        >
          <Users className="h-4 w-4 mr-2" />
          {loadingChats ? "Loading…" : "Pick from WhatsApp Groups"}
        </Button>
      </div>

      {/* Group picker from Green API */}
      {showGroupPicker && (
        <div className="border rounded-md p-3 space-y-2 bg-muted/40">
          <p className="text-xs font-medium text-muted-foreground">
            {groups.length === 0 && !loadingChats
              ? "No groups found. Make sure the WhatsApp number is connected."
              : `${groups.length} group(s) found — click to add:`}
          </p>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {groups.map((g) => {
              const already = recipients.some((r) => r.chatId === g.id);
              return (
                <div
                  key={g.id}
                  className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-background text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{g.name}</span>
                    <span className="text-xs text-muted-foreground truncate hidden sm:block">{g.id}</span>
                  </div>
                  {already ? (
                    <Badge variant="secondary">Added</Badge>
                  ) : (
                    <Button
                      size="default"
                      variant="outline"
                      onClick={() => addFromChat.mutate(g)}
                      disabled={addFromChat.isPending}
                      data-testid={`button-add-group-${g.id}`}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Manual entry */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Or enter a chatId manually. For DRC use <code className="bg-muted px-1 rounded-sm">243XXXXXXXXX@c.us</code>{" "}
          (individual) or paste a group chatId ending in <code className="bg-muted px-1 rounded-sm">@g.us</code>.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Input
            className="flex-1 min-w-0"
            placeholder="243XXXXXXXXX@c.us or group@g.us"
            value={newChatId}
            onChange={(e) => setNewChatId(e.target.value)}
            data-testid="input-wa-new-chat-id"
          />
          <Input
            className="w-40"
            placeholder="Label (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            data-testid="input-wa-new-name"
          />
          <Button
            size="default"
            onClick={() => addRecipient.mutate()}
            disabled={!newChatId.trim() || addRecipient.isPending}
            data-testid="button-wa-add-recipient"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </div>
      </div>

      {/* Recipient list */}
      {loadingRecipients ? (
        <LoadingState title="Loading recipients…" />
      ) : recipientsError && recipients.length === 0 ? (
        <ErrorState onAction={() => void refetchRecipients()} actionLabel="Try again" />
      ) : recipients.length === 0 ? (
        <EmptyState title="No recipients yet." />
      ) : (
        <div className="space-y-2">
          {recipients.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border bg-card"
              data-testid={`row-wa-recipient-${r.id}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {r.isGroup ? (
                  <Users className="h-4 w-4 shrink-0 text-blue-500" />
                ) : (
                  <MessageSquare className="h-4 w-4 shrink-0 text-green-500" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.chatId}</p>
                </div>
                {r.isGroup && (
                  <Badge variant="secondary" className="shrink-0">
                    Group
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.active ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-muted-foreground" />
                )}
                <Switch
                  checked={r.active}
                  onCheckedChange={(v) => toggleActive.mutate({ id: r.id, active: v })}
                  data-testid={`switch-wa-recipient-${r.id}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => deleteRecipient.mutate(r.id)}
                  disabled={deleteRecipient.isPending}
                  data-testid={`button-delete-wa-recipient-${r.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
