import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { EmployeeCrudDialogsForm, type EmployeeCrudDialogsProps } from "./EmployeeCrudDialogsForm";

export function EmployeeCrudDialogs({
  createEmployeeDialogOpen,
  setCreateEmployeeDialogOpen,
  createEmployeeForm,
  createEmployeeMutation,
  employeeGroups,
  deleteConflict,
  setDeleteConflict,
  handleForceDeleteEmployee,
  createGroupDialogOpen,
  setCreateGroupDialogOpen,
  newGroupName,
  setNewGroupName,
  newGroupDescription,
  setNewGroupDescription,
  createGroupMutation,
  groupMembersDialogOpen,
  setGroupMembersDialogOpen,
  selectedGroupForMembers,
  employeeStaff,
  groupMembers,
  addWorkerToGroupMutation,
  removeWorkerFromGroupMutation,
}: EmployeeCrudDialogsProps) {
  const { formatAmount } = useCurrencyContext();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateGroup = recordChanges.canCreate("POST", "/api/employee-groups");

  return (
    <>
      {/* Create Employee Dialog */}
      <Dialog open={createEmployeeDialogOpen} onOpenChange={setCreateEmployeeDialogOpen}>
        <DialogContent data-testid="dialog-create-employee">
          <DialogHeader>
            <DialogTitle>Create New Employee</DialogTitle>
            <DialogDescription>Add a new warehouse staff employee to the payroll system</DialogDescription>
          </DialogHeader>

          <EmployeeCrudDialogsForm
            createEmployeeForm={createEmployeeForm}
            createEmployeeMutation={createEmployeeMutation}
            employeeGroups={employeeGroups}
            setCreateEmployeeDialogOpen={setCreateEmployeeDialogOpen}
          />
        </DialogContent>
      </Dialog>

      {/* Balance Conflict Warning */}
      <AlertDialog open={!!deleteConflict} onOpenChange={(open) => !open && setDeleteConflict(null)}>
        <AlertDialogContent data-testid="dialog-delete-conflict">
          <AlertDialogHeader>
            <AlertDialogTitle>Employee Has Non-Zero Balance</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConflict && (
                <>
                  <span className="font-semibold">
                    {deleteConflict.employee.firstName} {deleteConflict.employee.lastName}
                  </span>{" "}
                  has a non-zero balance:
                  <div className="mt-2 space-y-1 font-mono text-sm">
                    <div>Employee Balance: {formatAmount(deleteConflict.employeeBalance)}</div>
                    <div>Ledger Balance: {formatAmount(deleteConflict.ledgerBalance)}</div>
                  </div>
                  <p className="mt-3">
                    Deleting this employee will also delete their linked ledger account. This action cannot be undone.
                  </p>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConflict(null)} data-testid="button-cancel-force-delete">
              Cancel
            </AlertDialogCancel>
            {recordChanges.allowed && (
              <AlertDialogAction
                onClick={handleForceDeleteEmployee}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-force-delete"
              >
                Delete Anyway
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Group Dialog */}
      <Dialog open={createGroupDialogOpen} onOpenChange={setCreateGroupDialogOpen}>
        <DialogContent data-testid="dialog-create-group">
          <DialogHeader>
            <DialogTitle>Create Employee Group</DialogTitle>
            <DialogDescription>Create a new group to organize employees</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Group Name</label>
              <Input
                placeholder="e.g., Warehouse Team"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                data-testid="input-group-name"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description (Optional)</label>
              <Textarea
                placeholder="Brief description of the group"
                value={newGroupDescription}
                onChange={(e) => setNewGroupDescription(e.target.value)}
                data-testid="input-group-description"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateGroupDialogOpen(false);
                  setNewGroupName("");
                  setNewGroupDescription("");
                }}
                data-testid="button-cancel-group"
              >
                Cancel
              </Button>
              {canCreateGroup && (
                <Button
                  onClick={() => createGroupMutation.mutate()}
                  disabled={!newGroupName.trim() || createGroupMutation.isPending}
                  data-testid="button-submit-group"
                >
                  {createGroupMutation.isPending ? "Creating..." : "Create Group"}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Manage Group Members Dialog */}
      <Dialog open={groupMembersDialogOpen} onOpenChange={setGroupMembersDialogOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-manage-group-members">
          <DialogHeader>
            <DialogTitle>Manage Group Members: {selectedGroupForMembers?.name}</DialogTitle>
            <DialogDescription>Select workers to add or remove from this group</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {(employeeStaff || []).map((worker) => {
              const isMember = groupMembers.some((m) => m.id === worker.id);
              return (
                <div key={worker.id} className="flex items-center gap-2 p-2 rounded-sm border">
                  <Checkbox
                    id={`worker-${worker.id}`}
                    checked={isMember}
                    disabled={!recordChanges.allowed}
                    title={recordChanges.reason ?? undefined}
                    onCheckedChange={(checked) => {
                      if (!recordChanges.allowed) return;
                      if (checked && selectedGroupForMembers) {
                        addWorkerToGroupMutation.mutate({ groupId: selectedGroupForMembers.id, employeeId: worker.id });
                      } else if (!checked && selectedGroupForMembers) {
                        removeWorkerFromGroupMutation.mutate({
                          groupId: selectedGroupForMembers.id,
                          employeeId: worker.id,
                        });
                      }
                    }}
                    data-testid={`checkbox-worker-${worker.id}`}
                  />
                  <label htmlFor={`worker-${worker.id}`} className="cursor-pointer flex-1">
                    {worker.firstName} {worker.lastName}
                  </label>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() => setGroupMembersDialogOpen(false)}
              data-testid="button-close-members-dialog"
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
