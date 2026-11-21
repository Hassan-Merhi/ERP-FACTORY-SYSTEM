// Extracted from ./LocationDialogs.tsx to keep that module under the source-size cap.
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Loader2 } from "lucide-react";
import { StockMovementDialog } from "./StockMovementDialog";
import type { LocationDialogsProps } from "./LocationDialogsTypes";
import { useLocationDialogsState } from "./useLocationDialogsState";
import { LocationDialogsContent } from "./LocationDialogsContent";

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
  const {
    setWaEnabled,
    waEnabled,
    waChatsRefreshing,
    refetchWaChats,
    filteredWaChats,
    selectedWaGroupName,
    waConnectionError,
  } = useLocationDialogsState({ waGroupDialogOpen, waChats, waGroupSearch, waGroupSelectedId, waGroupLocation });

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
              <p className="text-[11px] text-muted-foreground">
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
              Save
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
      <LocationDialogsContent
        filteredWaChats={filteredWaChats}
        refetchWaChats={refetchWaChats}
        selectedWaGroupName={selectedWaGroupName}
        setWaEnabled={setWaEnabled}
        setWaGroupDialogOpen={setWaGroupDialogOpen}
        setWaGroupSearch={setWaGroupSearch}
        setWaGroupSelectedId={setWaGroupSelectedId}
        waChatsLoading={waChatsLoading}
        waChatsRefreshing={waChatsRefreshing}
        waConnectionError={waConnectionError}
        waEnabled={waEnabled}
        waGroupDialogOpen={waGroupDialogOpen}
        waGroupLocation={waGroupLocation}
        waGroupMutation={waGroupMutation}
        waGroupSearch={waGroupSearch}
        waGroupSelectedId={waGroupSelectedId}
        waTestMutation={waTestMutation}
      />

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
