import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { MessageCircle, Search, Check, X, Loader2, Users, RefreshCw, CheckCircle, XCircle } from "lucide-react";
import { InstanceStateBadge } from "./PosWhatsAppSectionInstanceStateBadge";
import { PosWhatsAppSectionCardContentSection, usePosWhatsAppSectionState } from "./usePosWhatsAppSectionState";
import { PosWhatsAppSectionSection } from "./PosWhatsAppSectionSection";

export function PosWhatsAppSection() {
  const {
    apiToken,
    chatSearch,
    chatsError,
    chatsErrorDetail,
    chatsLoading,
    checkStateEnabled,
    credsDirty,
    dialogOpen,
    editingLocation,
    enabled,
    instanceId,
    instanceStateData,
    instanceStateLoading,
    locLoading,
    locations,
    openDialog,
    posSettings,
    refetchChats,
    refetchInstanceState,
    saveCredsMutation,
    saveGroupMutation,
    selectedChatId,
    setApiToken,
    setChatSearch,
    setCheckStateEnabled,
    setCredsDirty,
    setDialogOpen,
    setEnabled,
    setInstanceId,
    setSelectedChatId,
    setShowToken,
    settingsLoading,
    showToken,
    waChats,
  } = usePosWhatsAppSectionState();

  function handleSaveGroup() {
    if (!editingLocation) return;
    saveGroupMutation.mutate({
      id: editingLocation.id,
      name: editingLocation.name,
      whatsappGroupChatId: selectedChatId || null,
    });
  }

  const filteredChats = waChats
    .filter((c) => c.type === "group")
    .filter((c) => c.name.toLowerCase().includes(chatSearch.toLowerCase()));

  const configuredCount = locations.filter((l) => l.whatsappGroupChatId).length;
  const isConfigured = posSettings?.hasCredentials;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            <h2 className="text-2xl font-semibold">POS WhatsApp Groups</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            Configure a dedicated Green API instance for POS shift reports, then assign a group to each location.
          </p>
        </div>
        {configuredCount > 0 && (
          <Badge variant="secondary" data-testid="badge-configured-count">
            <Users className="h-3 w-3 mr-1" />
            {configuredCount} of {locations.length} configured
          </Badge>
        )}
      </div>

      {/* ── API Credentials card ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base">POS Green API Instance</CardTitle>
              <CardDescription className="mt-0.5">
                This is a separate API instance used only for POS shift report messages. If left blank, the main
                WhatsApp API instance will be used as a fallback.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {instanceStateData ? (
                <InstanceStateBadge state={instanceStateData.state} loading={instanceStateLoading} />
              ) : settingsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : isConfigured ? (
                <Badge variant="secondary" className="gap-1" data-testid="badge-pos-api-status">
                  <CheckCircle className="h-3 w-3 text-muted-foreground" />
                  Credentials saved
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1" data-testid="badge-pos-api-status">
                  <XCircle className="h-3 w-3 text-muted-foreground" />
                  Not configured
                </Badge>
              )}
              {isConfigured && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (checkStateEnabled) void refetchInstanceState();
                    else setCheckStateEnabled(true);
                  }}
                  disabled={instanceStateLoading}
                  data-testid="button-check-instance-state"
                >
                  {instanceStateLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Check Status
                </Button>
              )}
            </div>
          </div>
          {instanceStateData?.state === "sleepMode" && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 bg-amber-50 dark:bg-amber-950/40 rounded-sm px-2 py-1.5">
              Your Green API instance is in sleep mode. Log in to{" "}
              <a
                href="https://console.green-api.com"
                target="_blank"
                rel="noreferrer"
                className="underline font-medium"
              >
                console.green-api.com
              </a>{" "}
              and wake up your instance — messages are queued but not delivered while asleep.
            </p>
          )}
          {instanceStateData?.state === "notAuthorized" && (
            <p className="text-xs text-red-700 dark:text-red-400 mt-2 bg-red-50 dark:bg-red-950/40 rounded-sm px-2 py-1.5">
              Your WhatsApp session has expired. Go to{" "}
              <a
                href="https://console.green-api.com"
                target="_blank"
                rel="noreferrer"
                className="underline font-medium"
              >
                console.green-api.com
              </a>{" "}
              and scan the QR code to reconnect.
            </p>
          )}
        </CardHeader>
        <PosWhatsAppSectionCardContentSection
          apiToken={apiToken}
          credsDirty={credsDirty}
          enabled={enabled}
          instanceId={instanceId}
          saveCredsMutation={saveCredsMutation}
          setApiToken={setApiToken}
          setCredsDirty={setCredsDirty}
          setEnabled={setEnabled}
          setInstanceId={setInstanceId}
          setShowToken={setShowToken}
          showToken={showToken}
        />
      </Card>

      <Separator />

      {/* ── Location group assignments ── */}
      <PosWhatsAppSectionSection
        locLoading={locLoading}
        locations={locations}
        openDialog={openDialog}
        saveGroupMutation={saveGroupMutation}
      />

      {/* ── Group picker dialog ── */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) setDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set WhatsApp Group</DialogTitle>
            <DialogDescription>
              Choose the group for <strong>{editingLocation?.name}</strong>. Stock reports will be sent here when a
              shift ends with low stock.
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
                data-testid="input-chat-search"
              />
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => refetchChats()}
              disabled={chatsLoading}
              data-testid="button-refresh-chats"
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
                  data-testid="option-no-group"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                  No group (disabled)
                  {!selectedChatId && <Check className="h-4 w-4 ml-auto text-green-600 dark:text-green-400" />}
                </button>
                {chatsError && (
                  <p className="text-center text-destructive text-sm py-3 px-3">
                    Could not load WhatsApp groups:{" "}
                    {chatsErrorDetail instanceof Error ? chatsErrorDetail.message : "Connection failed"}. Please
                    refresh.
                  </p>
                )}
                {!chatsError && filteredChats.length === 0 && (
                  <p className="text-center text-muted-foreground text-sm py-4 px-3">
                    {waChats.filter((c) => c.type === "group").length === 0
                      ? "No WhatsApp groups found. Make sure the POS API instance is connected and has groups."
                      : "No groups match your search."}
                  </p>
                )}
                {filteredChats.map((chat) => (
                  <button
                    key={chat.id}
                    className={`w-full text-left px-3 py-2 text-sm hover-elevate flex items-center gap-2 ${selectedChatId === chat.id ? "bg-muted font-medium" : ""}`}
                    onClick={() => setSelectedChatId(chat.id)}
                    data-testid={`option-chat-${chat.id}`}
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
              Selected ID: <code className="font-mono">{selectedChatId}</code>
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel-wa-group">
              Cancel
            </Button>
            <Button onClick={handleSaveGroup} disabled={saveGroupMutation.isPending} data-testid="button-save-wa-group">
              {saveGroupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
