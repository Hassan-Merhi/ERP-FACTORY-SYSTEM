import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  MessageSquare,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Moon,
} from "lucide-react";
import { useWhatsAppExportSectionState } from "./useWhatsAppExportSectionState";
import { WhatsAppExportSectionContent } from "./WhatsAppExportSectionContent";

export function WhatsAppExportSection() {
  const {
    setExpanded,
    expanded,
    instanceId,
    setInstanceId,
    apiToken,
    setApiToken,
    showGroupPicker,
    newChatId,
    setNewChatId,
    newName,
    setNewName,
    setCheckStateEnabled,
    settings,
    refetchInstanceState,
    instanceStateLoading,
    instanceStateData,
    recipients,
    loadingRecipients,
    recipientsError,
    refetchRecipients,
    loadingChats,
    saveSettings,
    toggleEnabled,
    addRecipient,
    addFromChat,
    toggleActive,
    deleteRecipient,
    handleFetchChats,
    groups,
  } = useWhatsAppExportSectionState();

  return (
    <div className="border rounded-md">
      <button
        className="w-full flex items-center justify-between p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid="button-whatsapp-section-toggle"
      >
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-green-600" />
          <div>
            <p className="font-semibold">WhatsApp Export</p>
            <p className="text-sm text-muted-foreground">Green API credentials, recipients, and master on/off switch</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {settings?.enabled && (
            <Badge variant="secondary" className="text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300">
              Active
            </Badge>
          )}
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-6">
          {/* ── Credentials ─────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-sm font-medium">Green API Credentials</p>
            <p className="text-xs text-muted-foreground">
              Create a free account at{" "}
              <a href="https://green-api.com" target="_blank" rel="noreferrer" className="underline">
                green-api.com
              </a>
              , connect your WhatsApp number, then copy your Instance ID and API Token here.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wa-instance">Instance ID</Label>
                <Input
                  id="wa-instance"
                  data-testid="input-wa-instance-id"
                  placeholder="e.g. 1101234567"
                  value={instanceId || settings?.instanceId || ""}
                  onChange={(e) => setInstanceId(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wa-token">API Token</Label>
                <Input
                  id="wa-token"
                  data-testid="input-wa-api-token"
                  type="password"
                  placeholder="Paste your API token"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="default"
                onClick={() => saveSettings.mutate()}
                disabled={saveSettings.isPending}
                data-testid="button-wa-save-credentials"
              >
                {saveSettings.isPending ? "Saving…" : "Save Credentials"}
              </Button>
              {settings?.hasCredentials && (
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => {
                    setCheckStateEnabled(true);
                    refetchInstanceState();
                  }}
                  disabled={instanceStateLoading}
                  data-testid="button-check-main-instance-state"
                >
                  {instanceStateLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Check Status
                </Button>
              )}
              {instanceStateData &&
                (instanceStateData.state === "authorized" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300"
                  >
                    <CheckCircle className="h-3 w-3" />
                    Authorized
                  </Badge>
                ) : instanceStateData.state === "sleepMode" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300"
                  >
                    <Moon className="h-3 w-3" />
                    Sleeping
                  </Badge>
                ) : instanceStateData.state === "notAuthorized" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300"
                  >
                    <XCircle className="h-3 w-3" />
                    Not authorized
                  </Badge>
                ) : instanceStateData.state === "yellowCard" ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 text-orange-700 bg-orange-100 dark:bg-orange-950 dark:text-orange-300"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Warning
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <XCircle className="h-3 w-3 text-muted-foreground" />
                    Unknown
                  </Badge>
                ))}
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
                and wake up your instance — messages won't be delivered while asleep.
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
          </div>

          <Separator />

          {/* ── Enable toggle ────────────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable WhatsApp Sending</p>
              <p className="text-xs text-muted-foreground">
                Master switch — enables all WhatsApp auto-send features and the "Send" buttons
              </p>
            </div>
            <Switch
              data-testid="switch-wa-enabled"
              checked={settings?.enabled ?? false}
              onCheckedChange={(v) => toggleEnabled.mutate(v)}
              disabled={!settings?.hasCredentials}
            />
          </div>

          <Separator />

          {/* ── Recipients ──────────────────────────────────────────── */}
          <WhatsAppExportSectionContent
            addFromChat={addFromChat}
            addRecipient={addRecipient}
            deleteRecipient={deleteRecipient}
            groups={groups}
            handleFetchChats={handleFetchChats}
            loadingChats={loadingChats}
            loadingRecipients={loadingRecipients}
            newChatId={newChatId}
            newName={newName}
            recipients={recipients}
            recipientsError={recipientsError}
            refetchRecipients={refetchRecipients}
            setNewChatId={setNewChatId}
            setNewName={setNewName}
            settings={settings}
            showGroupPicker={showGroupPicker}
            toggleActive={toggleActive}
          />
        </div>
      )}
    </div>
  );
}
