import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ContainerFormBody } from "./ContainerFormBody";
import type { ContainerFormDialogProps } from "./ContainerFormDialogEnsureDatedAutoFxRate";
import { useContainerFormDialogState } from "./useContainerFormDialogState";
export { ensureDatedAutoFxRate } from "./ContainerFormDialogEnsureDatedAutoFxRate";

export function ContainerFormDialog(props: ContainerFormDialogProps) {
  const {
    AdminDialog,
    activeSuppliers,
    brokerMismatch,
    createMutation,
    currency,
    editingContainer,
    filteredSupplierList,
    formData,
    fxEffectiveDate,
    fxIsSuggestion,
    fxRate,
    fxRateSource,
    handleSubmit,
    ledgerAccounts,
    onClose,
    open,
    otherChargeLines,
    resetForm,
    selectedSupplier,
    setCurrency,
    setFormData,
    setFxRate,
    setFxRateSource,
    setOtherChargeLines,
    updateMutation,
  } = useContainerFormDialogState(props);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            resetForm();
            onClose();
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingContainer ? "Edit Container" : "Add Factory Container"}</DialogTitle>
            <DialogDescription>
              {editingContainer ? "Update container details" : "Track a new incoming factory container"}
            </DialogDescription>
          </DialogHeader>

          <ContainerFormBody
            formData={formData}
            setFormData={setFormData}
            currency={currency}
            setCurrency={setCurrency}
            fxRate={fxRate}
            setFxRate={setFxRate}
            fxRateSource={fxRateSource}
            setFxRateSource={setFxRateSource}
            fxEffectiveDate={fxEffectiveDate}
            fxIsSuggestion={fxIsSuggestion}
            otherChargeLines={otherChargeLines}
            setOtherChargeLines={setOtherChargeLines}
            activeSuppliers={activeSuppliers}
            filteredSupplierList={filteredSupplierList}
            selectedSupplier={selectedSupplier}
            brokerMismatch={brokerMismatch}
            ledgerAccounts={ledgerAccounts}
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                resetForm();
                onClose();
              }}
            >
              Cancel
            </Button>
            <FormSubmitButton
              type="button"
              onClick={handleSubmit}
              disabled={!formData.containerNumber || brokerMismatch}
              pending={createMutation.isPending || updateMutation.isPending}
              pendingLabel="Saving…"
              data-testid="button-save-container"
            >
              {editingContainer ? "Update" : "Create"}
            </FormSubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}
