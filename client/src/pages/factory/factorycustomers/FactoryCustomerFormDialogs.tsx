import { useId } from "react";
import { Clock, Pencil, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { MoneyInput } from "@/components/ui/decimal-input";
import type { Customer, CustomerFormData } from "./types";

interface FactoryCustomerFormDialogsProps {
  isCreateOpen: boolean;
  editingCustomer: Customer | null;
  formData: CustomerFormData;
  setFormData: (data: CustomerFormData) => void;
  saving: boolean;
  createPending: boolean;
  updatePending: boolean;
  onCloseCreate: () => void;
  onCloseEdit: () => void;
  onCreate: () => void;
  onUpdate: () => void;
}

/** "Add Customer" and "Edit Customer" dialogs of the Factory customers directory (split out of FactoryCustomers.tsx). */
export function FactoryCustomerFormDialogs({
  isCreateOpen,
  editingCustomer,
  formData,
  setFormData,
  saving,
  createPending,
  updatePending,
  onCloseCreate,
  onCloseEdit,
  onCreate,
  onUpdate,
}: FactoryCustomerFormDialogsProps) {
  const createFormId = useId();
  const editFormId = useId();

  return (
    <>
      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (createPending || saving) return;
          if (!open) {
            onCloseCreate();
          }
        }}
      >
        <DialogContent aria-busy={createPending || saving}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Add Customer
            </DialogTitle>
            <DialogDescription>A unique customer code will be generated automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label htmlFor={`${createFormId}-name`} className="text-sm font-medium mb-1 block">
                Name
              </label>
              <Input
                value={formData.legalName}
                onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                placeholder="Customer name"
                id={`${createFormId}-name`}
                data-testid="input-customer-name"
              />
            </div>
            <div>
              <label htmlFor={`${createFormId}-phone`} className="text-sm font-medium mb-1 block">
                Phone
              </label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Phone number"
                id={`${createFormId}-phone`}
                data-testid="input-customer-phone"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${createFormId}-balance`} className="text-sm font-medium mb-1 block">
                  Opening Balance
                </label>
                <MoneyInput
                  step="0.01"
                  value={formData.openingBalance}
                  onChange={(e) => setFormData({ ...formData, openingBalance: e.target.value })}
                  placeholder="0.00"
                  id={`${createFormId}-balance`}
                  data-testid="input-customer-opening-balance"
                />
              </div>
              <div>
                <label htmlFor={`${createFormId}-side`} className="text-sm font-medium mb-1 block">
                  Side
                </label>
                <Select
                  value={formData.openingBalanceSide}
                  onValueChange={(v) => setFormData({ ...formData, openingBalanceSide: v })}
                >
                  <SelectTrigger id={`${createFormId}-side`} data-testid="select-balance-side">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Dr">Debit</SelectItem>
                    <SelectItem value="Cr">Credit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label
                htmlFor={`${createFormId}-terms`}
                className="text-sm font-medium mb-1 block flex items-center gap-1"
              >
                <Clock className="h-3.5 w-3.5" />
                Payment Terms
              </label>
              <Select
                value={formData.paymentTermsDays || "none"}
                onValueChange={(v) =>
                  setFormData({ ...formData, paymentTermsDays: v === "none" ? "" : v === "custom" ? "" : v })
                }
              >
                <SelectTrigger id={`${createFormId}-terms`} data-testid="select-payment-terms">
                  <SelectValue placeholder="No payment terms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No payment terms</SelectItem>
                  <SelectItem value="30">Net 30 days</SelectItem>
                  <SelectItem value="45">Net 45 days</SelectItem>
                  <SelectItem value="60">Net 60 days</SelectItem>
                  <SelectItem value="90">Net 90 days</SelectItem>
                </SelectContent>
              </Select>
              {formData.paymentTermsDays && !["30", "45", "60", "90"].includes(formData.paymentTermsDays) && (
                <Input
                  type="number"
                  min={1}
                  value={formData.paymentTermsDays}
                  onChange={(e) => setFormData({ ...formData, paymentTermsDays: e.target.value })}
                  placeholder="Days"
                  className="mt-2"
                  aria-label="Custom payment terms in days"
                  data-testid="input-custom-payment-terms"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                A WhatsApp reminder will be sent when this customer has an outstanding balance past their due date.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  onCloseCreate();
                }}
                data-testid="button-cancel-create"
              >
                Cancel
              </Button>
              <FormSubmitButton
                type="button"
                onClick={onCreate}
                pending={createPending || saving}
                pendingLabel="Creating…"
                disabled={!formData.legalName.trim()}
                data-testid="button-submit-customer"
              >
                Create Customer
              </FormSubmitButton>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingCustomer}
        onOpenChange={(open) => {
          if (updatePending || saving) return;
          if (!open) {
            onCloseEdit();
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto" aria-busy={updatePending || saving}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Customer
            </DialogTitle>
            <DialogDescription>{editingCustomer ? `Editing ${editingCustomer.legalName}` : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label htmlFor={`${editFormId}-name`} className="text-sm font-medium mb-1 block">
                Name
              </label>
              <Input
                value={formData.legalName}
                onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                placeholder="Customer name"
                id={`${editFormId}-name`}
                data-testid="input-edit-customer-name"
              />
            </div>
            <div>
              <label htmlFor={`${editFormId}-phone`} className="text-sm font-medium mb-1 block">
                Phone
              </label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Phone number"
                id={`${editFormId}-phone`}
                data-testid="input-edit-customer-phone"
              />
            </div>
            <div>
              <label htmlFor={`${editFormId}-terms`} className="text-sm font-medium mb-1 block flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Payment Terms
              </label>
              <Select
                value={
                  formData.paymentTermsDays && ["30", "45", "60", "90"].includes(formData.paymentTermsDays)
                    ? formData.paymentTermsDays
                    : formData.paymentTermsDays
                      ? "custom"
                      : "none"
                }
                onValueChange={(v) => {
                  if (v === "none") setFormData({ ...formData, paymentTermsDays: "" });
                  else if (v === "custom") setFormData({ ...formData, paymentTermsDays: "" });
                  else setFormData({ ...formData, paymentTermsDays: v });
                }}
              >
                <SelectTrigger id={`${editFormId}-terms`} data-testid="select-edit-payment-terms">
                  <SelectValue placeholder="No payment terms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No payment terms</SelectItem>
                  <SelectItem value="30">Net 30 days</SelectItem>
                  <SelectItem value="45">Net 45 days</SelectItem>
                  <SelectItem value="60">Net 60 days</SelectItem>
                  <SelectItem value="90">Net 90 days</SelectItem>
                  <SelectItem value="custom">Custom...</SelectItem>
                </SelectContent>
              </Select>
              {formData.paymentTermsDays && !["30", "45", "60", "90"].includes(formData.paymentTermsDays) && (
                <Input
                  type="number"
                  min={1}
                  value={formData.paymentTermsDays}
                  onChange={(e) => setFormData({ ...formData, paymentTermsDays: e.target.value })}
                  placeholder="Number of days"
                  className="mt-2"
                  aria-label="Custom payment terms in days"
                  data-testid="input-edit-custom-payment-terms"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                A WhatsApp reminder is sent at 9 AM when this customer has an outstanding balance past their due date.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  onCloseEdit();
                }}
                data-testid="button-cancel-edit"
              >
                Cancel
              </Button>
              <FormSubmitButton
                type="button"
                onClick={onUpdate}
                pending={updatePending || saving}
                pendingLabel="Saving…"
                disabled={!formData.legalName.trim()}
                data-testid="button-submit-edit-customer"
              >
                Save Changes
              </FormSubmitButton>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
