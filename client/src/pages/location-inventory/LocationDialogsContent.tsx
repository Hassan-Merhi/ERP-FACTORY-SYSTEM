// Extracted from ./LocationDialogsView.tsx
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Check, Loader2, MessageCircle, RefreshCw, Send } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LocationDialogsProps } from "./LocationDialogsTypes";
import { useLocationDialogsState } from "./useLocationDialogsState";

export function LocationDialogsContent({
  filteredWaChats,
  refetchWaChats,
  selectedWaGroupName,
  setWaEnabled,
  setWaGroupDialogOpen,
  setWaGroupSearch,
  setWaGroupSelectedId,
  waChatsLoading,
  waChatsRefreshing,
  waConnectionError,
  waEnabled,
  waGroupDialogOpen,
  waGroupLocation,
  waGroupMutation,
  waGroupSearch,
  waGroupSelectedId,
  waTestMutation,
}: Pick<
  ReturnType<typeof useLocationDialogsState>,
  | "filteredWaChats"
  | "refetchWaChats"
  | "selectedWaGroupName"
  | "setWaEnabled"
  | "waChatsRefreshing"
  | "waConnectionError"
  | "waEnabled"
> &
  Pick<
    LocationDialogsProps,
    | "setWaGroupDialogOpen"
    | "setWaGroupSearch"
    | "setWaGroupSelectedId"
    | "waChatsLoading"
    | "waGroupDialogOpen"
    | "waGroupLocation"
    | "waGroupMutation"
    | "waGroupSearch"
    | "waGroupSelectedId"
    | "waTestMutation"
  >) {
  return (
    <Dialog open={waGroupDialogOpen} onOpenChange={setWaGroupDialogOpen}>
      <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            <span>{releaseDebtEnglish("Location WhatsApp Stock Reports")}</span>
          </DialogTitle>
          <DialogDescription>
            Link the WhatsApp group for <strong>{waGroupLocation?.name}</strong>. This destination is used by Location
            Inventory WhatsApp stock reporting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="wa-location-group-search">{releaseDebtEnglish("WhatsApp Group")}</Label>
            <Input
              id="wa-location-group-search"
              placeholder={releaseDebtEnglish("Search groups...")}
              value={waGroupSearch}
              onChange={(e) => setWaGroupSearch(e.target.value)}
              data-testid="input-location-wa-group-search"
            />
            <p className="text-xs text-muted-foreground">
              {releaseDebtEnglish(
                "Only groups from the connected WhatsApp account are shown. Individual contacts cannot be selected."
              )}
            </p>
          </div>

          <div className="max-h-60 overflow-y-auto border rounded-md p-1 space-y-1">
            {waChatsLoading || (waChatsRefreshing && !waConnectionError) ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : waConnectionError ? (
              <div className="p-4 text-center space-y-3" data-testid="location-wa-groups-error">
                <AlertTriangle className="h-5 w-5 text-amber-500 mx-auto" />
                <div>
                  <p className="text-sm font-medium">{releaseDebtEnglish("WhatsApp groups could not be loaded")}</p>
                  <p className="text-xs text-muted-foreground mt-1 wrap-break-word">{waConnectionError}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void refetchWaChats()}
                  disabled={waChatsRefreshing}
                  data-testid="button-retry-location-wa-groups"
                >
                  {waChatsRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Retry connection
                </Button>
              </div>
            ) : filteredWaChats.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {releaseDebtEnglish("No WhatsApp groups found")}
              </div>
            ) : (
              filteredWaChats.map((chat) => (
                <button
                  type="button"
                  key={chat.id}
                  onClick={() => setWaGroupSelectedId(chat.id)}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md text-left transition-colors",
                    waGroupSelectedId === chat.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  )}
                  data-testid={`option-location-wa-group-${chat.id}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{chat.name}</span>
                    <span
                      className={cn(
                        "block text-[11px] font-mono truncate",
                        waGroupSelectedId === chat.id ? "text-primary-foreground/70" : "text-muted-foreground"
                      )}
                    >
                      {chat.id}
                    </span>
                  </span>
                  {waGroupSelectedId === chat.id && <Check className="h-4 w-4 shrink-0" />}
                </button>
              ))
            )}
          </div>

          {waGroupSelectedId ? (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Linked destination")}</p>
                  <p className="text-sm font-medium truncate">{selectedWaGroupName || "Selected WhatsApp group"}</p>
                  <p className="text-[11px] font-mono text-muted-foreground break-all">{waGroupSelectedId}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => {
                    setWaGroupSelectedId("");
                    setWaEnabled(false);
                  }}
                  data-testid="button-unlink-location-wa-group"
                >
                  {releaseDebtEnglish("Unlink")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {releaseDebtEnglish("No WhatsApp group is linked to this location.")}
            </div>
          )}

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="location-wa-enabled">{releaseDebtEnglish("Enable stock reports")}</Label>
              <p className="text-xs text-muted-foreground">
                {releaseDebtEnglish(
                  "Allows this linked group to be used by the Location Inventory stock-report feature."
                )}
              </p>
            </div>
            <Switch
              id="location-wa-enabled"
              checked={Boolean(waGroupSelectedId) && waEnabled}
              onCheckedChange={setWaEnabled}
              disabled={!waGroupSelectedId}
              data-testid="switch-location-wa-enabled"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              waTestMutation.mutate({
                id: waGroupLocation!.id,
                whatsappGroupChatId: waGroupSelectedId || null,
              })
            }
            disabled={!waGroupSelectedId || waTestMutation.isPending || waGroupMutation.isPending}
            data-testid="button-test-location-wa-group"
          >
            {waTestMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Send Test
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setWaGroupDialogOpen(false)}
              disabled={waGroupMutation.isPending || waTestMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                waGroupMutation.mutate({
                  id: waGroupLocation!.id,
                  whatsappGroupChatId: waGroupSelectedId || null,
                  enabled: Boolean(waGroupSelectedId) && waEnabled,
                })
              }
              disabled={waGroupMutation.isPending || waTestMutation.isPending}
              data-testid="button-confirm-wa-group"
            >
              {waGroupMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Settings
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
