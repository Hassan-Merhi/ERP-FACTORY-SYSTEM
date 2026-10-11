import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface EmployeeCrudDialogsProps {
  createEmployeeDialogOpen: boolean;
  setCreateEmployeeDialogOpen: (open: boolean) => void;
  createEmployeeForm: PayrollModel["createEmployeeForm"];
  createEmployeeMutation: PayrollModel["createEmployeeMutation"];
  employeeGroups: PayrollModel["employeeGroups"];
  deleteConflict: PayrollModel["deleteConflict"];
  setDeleteConflict: PayrollModel["setDeleteConflict"];
  handleForceDeleteEmployee: () => void;
  createGroupDialogOpen: boolean;
  setCreateGroupDialogOpen: (open: boolean) => void;
  newGroupName: string;
  setNewGroupName: (v: string) => void;
  newGroupDescription: string;
  setNewGroupDescription: (v: string) => void;
  createGroupMutation: PayrollModel["createGroupMutation"];
  groupMembersDialogOpen: boolean;
  setGroupMembersDialogOpen: (open: boolean) => void;
  selectedGroupForMembers: PayrollModel["selectedGroupForMembers"];
  employeeStaff: PayrollModel["employeeStaff"];
  groupMembers: PayrollModel["groupMembers"];
  addWorkerToGroupMutation: PayrollModel["addWorkerToGroupMutation"];
  removeWorkerFromGroupMutation: PayrollModel["removeWorkerFromGroupMutation"];
}

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

  return (
    <>
      {/* Create Employee Dialog */}
      <Dialog open={createEmployeeDialogOpen} onOpenChange={setCreateEmployeeDialogOpen}>
        <DialogContent data-testid="dialog-create-employee">
          <DialogHeader>
            <DialogTitle>Create New Employee</DialogTitle>
            <DialogDescription>Add a new warehouse staff employee to the payroll system</DialogDescription>
          </DialogHeader>

          <Form {...createEmployeeForm}>
            <form
              noValidate
              onSubmit={createEmployeeForm.handleSubmit((data) => createEmployeeMutation.mutate(data))}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                  control={createEmployeeForm.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name</FormLabel>
                      <FormControl>
                        <Input placeholder="John" {...field} data-testid="input-first-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createEmployeeForm.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Doe" {...field} data-testid="input-last-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={createEmployeeForm.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employee Code (Optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="Auto-generated if left blank" {...field} data-testid="input-code" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={createEmployeeForm.control}
                name="monthlySalary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Salary</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        {...field}
                        data-testid="input-monthly-salary"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={createEmployeeForm.control}
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department (Optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., Warehouse"
                        {...field}
                        value={field.value || ""}
                        data-testid="input-department"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={createEmployeeForm.control}
                name="joinDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Starting Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} data-testid="input-join-date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={createEmployeeForm.control}
                name="openingBalance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Opening Balance (Optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        {...field}
                        data-testid="input-opening-balance"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={createEmployeeForm.control}
                name="employeeGroupId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employee Group (Optional)</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-employee-group">
                          <SelectValue placeholder="Select a group" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none" data-testid="option-no-group">
                          No Group
                        </SelectItem>
                        {employeeGroups.map((group) => (
                          <SelectItem
                            key={group.id}
                            value={group.id.toString()}
                            data-testid={`option-group-${group.id}`}
                          >
                            {group.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="border-t pt-4 space-y-3">
                <p className="text-sm font-medium text-muted-foreground">Bonus Configuration (Optional)</p>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={createEmployeeForm.control}
                    name="salesBonusPct"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sales Bonus %</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.0001"
                            placeholder="e.g. 0.2"
                            {...field}
                            value={field.value || ""}
                            data-testid="input-sales-bonus-pct-create"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createEmployeeForm.control}
                    name="balesBonusRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Bales Rate ($/unit)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="e.g. 2.00"
                            {...field}
                            value={field.value || ""}
                            data-testid="input-bales-bonus-rate-create"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateEmployeeDialogOpen(false)}
                  data-testid="button-cancel-create"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createEmployeeMutation.isPending} data-testid="button-submit-create">
                  {createEmployeeMutation.isPending ? "Creating..." : "Create Employee"}
                </Button>
              </div>
            </form>
          </Form>
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
            <AlertDialogAction
              onClick={handleForceDeleteEmployee}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-force-delete"
            >
              Delete Anyway
            </AlertDialogAction>
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
              <Button
                onClick={() => createGroupMutation.mutate()}
                disabled={!newGroupName.trim() || createGroupMutation.isPending}
                data-testid="button-submit-group"
              >
                {createGroupMutation.isPending ? "Creating..." : "Create Group"}
              </Button>
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
                    onCheckedChange={(checked) => {
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
