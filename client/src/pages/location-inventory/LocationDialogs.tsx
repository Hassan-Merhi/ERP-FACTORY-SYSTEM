import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Check, Loader2, MessageCircle, RefreshCw, Send } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { StockMovementDialog } from "./StockMovementDialog";
import type {
  InventoryLocation as Location,
  PendingMutation,
  RenameLocationVariables,
  StockGroupSummary,
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
  WhatsappGroup,
  WhatsappGroupVariables,
  WhatsappTestVariables,
} from "./locationInventoryTypes";

interface LocationDialogsProps {
  // Rename Dialog
  renameDialogOpen: boolean;
  setRenameDialogOpen: (o: boolean) => void;
  renamingLocation: Location | null;
  renameInput: string;
  setRenameInput: (s: string) => void;
  renameDeductionInput: string;
  setRenameDeductionInput: (s: string) => void;
  renameLocationMutation: PendingMutation<RenameLocationVariables>;

  // Delete Dialog
  deleteDialogOpen: boolean;
  setDeleteDialogOpen: (o: boolean) => void;
  isDeleting: boolean;
  handleDeleteLocation: () => void;
  selectedLocationLocal: Location | null;

  // Archive Dialog
  archiveDialogOpen: boolean;
  setArchiveDialogOpen: (o: boolean) => void;
  isArchiving: boolean;
  handleArchiveStockGroup: () => void;
  selectedGroup: StockGroupSummary | null;

  // WhatsApp Dialog
  waGroupDialogOpen: boolean;
  setWaGroupDialogOpen: (o: boolean) => void;
  waChats: WhatsappGroup[];
  waChatsLoading: boolean;
  waGroupSearch: string;
  setWaGroupSearch: (s: string) => void;
  waGroupSelectedId: string;
  setWaGroupSelectedId: (s: string) => void;
  waGroupMutation: PendingMutation<WhatsappGroupVariables>;
  waTestMutation: PendingMutation<WhatsappTestVariables>;
  waGroupLocation: Location | null;

  // Stock Movement Dialog
  stockMovementOpen: boolean;
  setStockMovementOpen: (o: boolean) => void;
  stockMovementItem: StockMovementItem | null;
  setStockMovementItem: (item: StockMovementItem | null) => void;
  stockMovementPeriod: StockMovementPeriod;
  setStockMovementPeriod: (period: StockMovementPeriod) => void;
  drillMonth: StockMovementMonth | null;
  setDrillMonth: (month: StockMovementMonth | null) => void;
  formatAmount: (amt: number) => string;
  navigate: (path: string) => void;
}

export function LocationDialogs({
  renameDialogOpen,
  setRenameDialogOpen,
  renamingLocation,
  renameInput,
  setRenameInput,
  renameDeductionInput,
  setRenameDeductionInput,
  renameLocationMutation,
  deleteDialogOpen,
  setDeleteDialogOpen,
  isDeleting,
  handleDeleteLocation,
  selectedLocationLocal,
  archiveDialogOpen,
  setArchiveDialogOpen,
  isArchiving,
  handleArchiveStockGroup,
  selectedGroup,
  waGroupDialogOpen,
  setWaGroupDialogOpen,
  waChats,
  waChatsLoading,
  waGroupSearch,
  setWaGroupSearch,
  waGroupSelectedId,
  setWaGroupSelectedId,
  waGroupMutation,
  waTestMutation,
  waGroupLocation,
  stockMovementOpen,
  setStockMovementOpen,
  stockMovementItem,
  setStockMovementItem,
  stockMovementPeriod,
  setStockMovementPeriod,
  drillMonth,
  setDrillMonth,
  formatAmount,
  navigate,
}: LocationDialogsProps) {
  const [waEnabled, setWaEnabled] = useState(false);

  // Subscribe to the exact same React Query cache entry used by the page-level
  // group loader. This adds no duplicate request, but it lets the dialog surface
  // the actual disconnected/credentials/API failure and provide an explicit retry.
  const {
    error: waChatsError,
    refetch: refetchWaChats,
    isFetching: waChatsRefreshing,
  } = useQuery<{ id: string; name: string; type: string }[]>({
    queryKey: ["/api/location-inventory/whatsapp/groups"],
    queryFn: async () => {
      const res = await fetch("/api/location-inventory/whatsapp/groups", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to fetch WhatsApp groups: ${res.status}`);
      }
      return res.json();
    },
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!waGroupDialogOpen) return;
    setWaEnabled(Boolean(waGroupLocation?.whatsappStockReportsEnabled ?? waGroupLocation?.whatsappGroupChatId));
  }, [waGroupDialogOpen, waGroupLocation]);

  const filteredWaChats = useMemo(() => {
    const search = waGroupSearch.trim().toLowerCase();
    if (!search) return waChats;
    return waChats.filter((chat) =>
      String(chat.name ?? "")
        .toLowerCase()
        .includes(search)
    );
  }, [waChats, waGroupSearch]);

  const selectedWaGroup = useMemo(
    () => waChats.find((chat) => chat.id === waGroupSelectedId),
    [waChats, waGroupSelectedId]
  );
  const selectedWaGroupName =
    selectedWaGroup?.name ||
    (waGroupSelectedId === waGroupLocation?.whatsappGroupChatId ? waGroupLocation?.whatsappGroupName : null) ||
    null;
  const waConnectionError =
    waChatsError instanceof Error
      ? waChatsError.message
      : waChatsError
        ? "Could not load WhatsApp groups from the connected account."
        : null;

  return (
    <>
      {/* Rename Location Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{releaseDebtEnglish("Rename Location")}</DialogTitle>
            <DialogDescription>Update the name and settings for this location.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="rename-input">{releaseDebtEnglish("Location Name")}</Label>
              <Input
                id="rename-input"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                placeholder={releaseDebtEnglish("Enter new name")}
                data-testid="input-rename-location"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="deduction-input">{releaseDebtEnglish("Supplier Partner Deduction (per BL)")}</Label>
              <Input
                id="deduction-input"
                type="number"
                step="0.01"
                value={renameDeductionInput}
                onChange={(e) => setRenameDeductionInput(e.target.value)}
                placeholder="0.00"
                data-testid="input-rename-deduction"
              />
              <p className="text-[10px] text-muted-foreground">
                {releaseDebtEnglish("Amount automatically deducted from SP payables for this location.")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                renameLocationMutation.mutate({
                  id: renamingLocation!.id,
                  name: renameInput,
                  supplierPartnerPayableDeductionPerQty: parseFloat(renameDeductionInput),
                })
              }
              disabled={renameLocationMutation.isPending || !renameInput.trim()}
              data-testid="button-confirm-rename"
            >
              {renameLocationMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Location Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Location</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{selectedLocationLocal?.name}</strong>? This will also delete all
              associated inventory records. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeleteLocation();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-location"
            >
              {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete Location
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive Stock Group Dialog */}
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{releaseDebtEnglish("Archive Stock Group")}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to archive the group <strong>{selectedGroup?.groupName}</strong> from{" "}
              <strong>{selectedLocationLocal?.name}</strong>? This will remove all items in this group from this godown.
              You can restore them later from the Orphaned Records page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isArchiving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleArchiveStockGroup();
              }}
              disabled={isArchiving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-archive-group"
            >
              {isArchiving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Archive Group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* WhatsApp Stock Report Configuration */}
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
                    <p className="text-xs text-muted-foreground mt-1 break-words">{waConnectionError}</p>
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
                    {waChatsRefreshing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
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
                          "block text-[10px] font-mono truncate",
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
                    <p className="text-[10px] font-mono text-muted-foreground break-all">{waGroupSelectedId}</p>
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

      {/* Stock Movement Dialog */}
      <StockMovementDialog
        stockMovementOpen={stockMovementOpen}
        setStockMovementOpen={setStockMovementOpen}
        stockMovementItem={stockMovementItem}
        setStockMovementItem={setStockMovementItem}
        stockMovementPeriod={stockMovementPeriod}
        setStockMovementPeriod={setStockMovementPeriod}
        drillMonth={drillMonth}
        setDrillMonth={setDrillMonth}
        formatAmount={formatAmount}
        navigate={navigate}
      />
    </>
  );
}

function _fmtQ(n: number) {
  return n === 0 ? (
    <span className="opacity-30">—</span>
  ) : (
    <>{n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</>
  );
}
function _fmtR(n: number) {
  return n === 0 ? (
    <span className="opacity-30">—</span>
  ) : (
    <>{n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
  );
}
