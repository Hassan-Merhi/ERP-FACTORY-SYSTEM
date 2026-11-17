// Extracted from ./PosWhatsAppSection.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { MessageCircle, X } from "lucide-react";
import { usePosWhatsAppSectionState } from "./usePosWhatsAppSectionState";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";

export function PosWhatsAppSectionSection({
  refetchLocations,
  locError,
  locLoading,
  locations,
  openDialog,
  saveGroupMutation,
}: Pick<
  ReturnType<typeof usePosWhatsAppSectionState>,
  "locLoading" | "locations" | "openDialog" | "saveGroupMutation" | "locError" | "refetchLocations"
>) {
  return (
    <div>
      <h3 className="text-base font-semibold mb-1">Location Group Assignments</h3>
      <p className="text-sm text-muted-foreground mb-4">
        Assign a WhatsApp group to each POS location. Reports are sent when a shift ends with low stock.
      </p>

      {locLoading ? (
        <LoadingState title="Loading locations…" className="py-8" />
      ) : locError && locations.length === 0 ? (
        <ErrorState onAction={() => void refetchLocations()} actionLabel="Try again" className="py-8" />
      ) : locations.length === 0 ? (
        <EmptyState title="No POS locations found." className="py-8" />
      ) : (
        <div className="space-y-2">
          {locations.map((loc) => {
            const chatId = loc.whatsappGroupChatId;
            return (
              <div
                key={loc.id}
                className="flex items-center justify-between gap-4 rounded-md border bg-card px-4 py-3 flex-wrap"
                data-testid={`row-location-${loc.id}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`h-2 w-2 rounded-full shrink-0 ${chatId ? "bg-green-500" : "bg-muted-foreground/40"}`}
                  />
                  <div className="min-w-0">
                    <p className="font-medium text-sm leading-tight" data-testid={`text-location-name-${loc.id}`}>
                      {loc.name}
                    </p>
                    {chatId ? (
                      <p
                        className="text-xs text-muted-foreground font-mono truncate mt-0.5"
                        data-testid={`text-chat-id-${loc.id}`}
                      >
                        {chatId}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-0.5">No group configured</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {chatId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saveGroupMutation.isPending}
                      onClick={() =>
                        saveGroupMutation.mutate({ id: loc.id, name: loc.name, whatsappGroupChatId: null })
                      }
                      data-testid={`button-remove-group-${loc.id}`}
                    >
                      <X className="h-3.5 w-3.5 mr-1" />
                      Remove
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openDialog(loc)}
                    data-testid={`button-set-group-${loc.id}`}
                  >
                    <MessageCircle
                      className={`h-3.5 w-3.5 mr-1.5 ${chatId ? "text-green-600 dark:text-green-400" : ""}`}
                    />
                    {chatId ? "Change Group" : "Set Group"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
