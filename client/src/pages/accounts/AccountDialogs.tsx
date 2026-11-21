import { SearchField } from "@/components/ui/search-field";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { AccountDialogsProps } from "./accountTypes";
import { Checkbox } from "@/components/ui/checkbox";
import { EditAccountDialog } from "./EditAccountDialog";
import { AccountDialogsContent } from "./AccountDialogsContent";

export function AccountDialogs({
  bankToEdit,
  setBankToEdit,
  bankForm,
  onBankSubmit,
  updateBankMutation,
  deleteBankMutation,
  handleDeleteBankAccount,
  accountToEdit,
  setAccountToEdit,
  supplierToEdit,
  setSupplierToEdit,
  customerToEdit,
  setCustomerToEdit,
  employeeToEdit,
  setEmployeeToEdit,
  editForm,
  onEditSubmit,
  updateLedgerMutation,
  handleDeleteAccount,
  pendingDelete,
  setPendingDelete,
  waRuleDialogOpen,
  setWaRuleDialogOpen,
  waChatSearch,
  setWaChatSearch,
  waRuleDraft,
  setWaRuleDraft,
  filteredWaChats,
  saveWaRuleMutation,
  waChatsLoading,
}: AccountDialogsProps) {
  return (
    <>
      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            pendingDelete();
            setPendingDelete(null);
          }
        }}
        title="Delete Account"
        description="Are you sure you want to delete this account? This action cannot be undone."
      />

      <Dialog open={waRuleDialogOpen} onOpenChange={setWaRuleDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5" />
              WhatsApp Auto-Statement
            </DialogTitle>
            <DialogDescription>Automatically send statements to WhatsApp when vouchers are posted.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="wa-enabled">Enable Rule</Label>
              <Checkbox
                id="wa-enabled"
                checked={waRuleDraft.enabled}
                onCheckedChange={(c) => setWaRuleDraft({ ...waRuleDraft, enabled: !!c })}
              />
            </div>

            <div className="space-y-2">
              <Label>WhatsApp Chat</Label>
              <SearchField value={waChatSearch} onValueChange={setWaChatSearch} placeholder="Search chats..." />
              <div className="border rounded-md max-h-48 overflow-y-auto mt-2">
                {waChatsLoading ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">Loading chats...</div>
                ) : filteredWaChats.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">No chats found</div>
                ) : (
                  filteredWaChats.map((chat) => (
                    <button
                      key={chat.id}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center justify-between ${
                        waRuleDraft.whatsappChatId === chat.id ? "bg-primary/10" : ""
                      }`}
                      onClick={() => setWaRuleDraft({ ...waRuleDraft, whatsappChatId: chat.id })}
                    >
                      <span>{chat.name}</span>
                      {waRuleDraft.whatsappChatId === chat.id && <CheckCircle2 className="w-4 h-4 text-primary" />}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <Label>Trigger Events</Label>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="wa-payment"
                    checked={waRuleDraft.sendOnPayment}
                    onCheckedChange={(c) => setWaRuleDraft({ ...waRuleDraft, sendOnPayment: !!c })}
                  />
                  <Label htmlFor="wa-payment" className="font-normal">
                    Payment
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="wa-receipt"
                    checked={waRuleDraft.sendOnReceipt}
                    onCheckedChange={(c) => setWaRuleDraft({ ...waRuleDraft, sendOnReceipt: !!c })}
                  />
                  <Label htmlFor="wa-receipt" className="font-normal">
                    Receipt
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="wa-journal"
                    checked={waRuleDraft.sendOnJournal}
                    onCheckedChange={(c) => setWaRuleDraft({ ...waRuleDraft, sendOnJournal: !!c })}
                  />
                  <Label htmlFor="wa-journal" className="font-normal">
                    Journal
                  </Label>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setWaRuleDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={saveWaRuleMutation.isPending || (waRuleDraft.enabled && !waRuleDraft.whatsappChatId)}
              onClick={() => saveWaRuleMutation.mutate(waRuleDraft)}
            >
              {saveWaRuleMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save Rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AccountDialogsContent
        bankForm={bankForm}
        bankToEdit={bankToEdit}
        deleteBankMutation={deleteBankMutation}
        handleDeleteBankAccount={handleDeleteBankAccount}
        onBankSubmit={onBankSubmit}
        setBankToEdit={setBankToEdit}
        updateBankMutation={updateBankMutation}
      />

      <EditAccountDialog
        accountToEdit={accountToEdit}
        supplierToEdit={supplierToEdit}
        customerToEdit={customerToEdit}
        employeeToEdit={employeeToEdit}
        setAccountToEdit={setAccountToEdit}
        setSupplierToEdit={setSupplierToEdit}
        setCustomerToEdit={setCustomerToEdit}
        setEmployeeToEdit={setEmployeeToEdit}
        editForm={editForm}
        onEditSubmit={onEditSubmit}
        handleDeleteAccount={handleDeleteAccount}
        updateLedgerMutation={updateLedgerMutation}
      />
    </>
  );
}
