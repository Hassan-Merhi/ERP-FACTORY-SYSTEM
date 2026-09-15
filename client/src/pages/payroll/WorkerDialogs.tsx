import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ClientErrorLike } from "@/lib/clientError";
import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { Employee } from "@shared/schema";

interface WorkerDialogsProps {
  newWorkerDialogOpen: boolean;
  setNewWorkerDialogOpen: (open: boolean) => void;
  newWorkerForm: PayrollModel["newWorkerForm"];
  createWorkerMutation: PayrollModel["createWorkerMutation"];
  editWorkerDialogOpen: boolean;
  setEditWorkerDialogOpen: (open: boolean) => void;
  selectedWorkerForEdit: PayrollModel["selectedWorkerForEdit"];
  editWorkerForm: PayrollModel["editWorkerForm"];
  updateWorkerMutation: PayrollModel["updateWorkerMutation"];
  deleteWorkerConflict: PayrollModel["deleteWorkerConflict"];
  setDeleteWorkerConflict: PayrollModel["setDeleteWorkerConflict"];
  handleForceDeleteWorker: () => void;
  createWorkerGroupDialogOpen: boolean;
  setCreateWorkerGroupDialogOpen: (open: boolean) => void;
  workerGroupMembersDialogOpen: boolean;
  setWorkerGroupMembersDialogOpen: (open: boolean) => void;
  selectedWorkerGroupForMembers: PayrollModel["selectedWorkerGroupForMembers"];
  allWorkerGroups: PayrollModel["workerGroupsData"];
  allWorkers: Employee[];
  addWorkerToWorkerGroupMutation: PayrollModel["addWorkerToWorkerGroupMutation"];
  removeWorkerFromWorkerGroupMutation: PayrollModel["removeWorkerFromWorkerGroupMutation"];
}

export function WorkerDialogs({
  newWorkerDialogOpen,
  setNewWorkerDialogOpen,
  newWorkerForm,
  createWorkerMutation,
  editWorkerDialogOpen,
  setEditWorkerDialogOpen,
  selectedWorkerForEdit,
  editWorkerForm,
  updateWorkerMutation,
  deleteWorkerConflict,
  setDeleteWorkerConflict,
  handleForceDeleteWorker,
  createWorkerGroupDialogOpen,
  setCreateWorkerGroupDialogOpen,
  workerGroupMembersDialogOpen,
  setWorkerGroupMembersDialogOpen,
  selectedWorkerGroupForMembers,
  allWorkerGroups,
  allWorkers,
  addWorkerToWorkerGroupMutation,
  removeWorkerFromWorkerGroupMutation,
}: WorkerDialogsProps) {
  const { formatAmount } = useCurrencyContext();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [workerGroupName, setWorkerGroupName] = useState("");
  const [workerGroupDescription, setWorkerGroupDescription] = useState("");

  const createWorkerGroupMutation = useMutation({
    mutationFn: async () =>
      modeApiRequest("POST", "/api/worker-groups", {
        name: workerGroupName.trim(),
        description: workerGroupDescription.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
      setWorkerGroupName("");
      setWorkerGroupDescription("");
      setCreateWorkerGroupDialogOpen(false);
      toast({ title: "Group created" });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to create group", variant: "destructive" });
    },
  });

  return (
    <>
      {/* New Worker Dialog */}
      <Dialog open={newWorkerDialogOpen} onOpenChange={setNewWorkerDialogOpen}>
        <DialogContent data-testid="dialog-new-worker">
          <DialogHeader>
            <DialogTitle>Add New Worker</DialogTitle>
            <DialogDescription>Create a new worker for this company</DialogDescription>
          </DialogHeader>

          <Form {...newWorkerForm}>
            <form
              noValidate
              onSubmit={newWorkerForm.handleSubmit((data) => createWorkerMutation.mutate(data))}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                  control={newWorkerForm.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-new-worker-firstname" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={newWorkerForm.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-new-worker-lastname" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={newWorkerForm.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Worker Code (Optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Auto-generated if left blank"
                        {...field}
                        data-testid="input-new-worker-code"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={newWorkerForm.control}
                name="monthlySalary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Salary</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-new-worker-salary" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={newWorkerForm.control}
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department (Optional)</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-new-worker-department" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={newWorkerForm.control}
                name="active"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-new-worker-active"
                      />
                    </FormControl>
                    <FormLabel className="!mt-0">Active</FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setNewWorkerDialogOpen(false)}
                  data-testid="button-cancel-new-worker"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createWorkerMutation.isPending} data-testid="button-submit-new-worker">
                  {createWorkerMutation.isPending ? "Creating..." : "Create Worker"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit Worker Dialog */}
      <Dialog open={editWorkerDialogOpen} onOpenChange={setEditWorkerDialogOpen}>
        <DialogContent data-testid="dialog-edit-worker">
          <DialogHeader>
            <DialogTitle>Edit Worker</DialogTitle>
            <DialogDescription>
              Update worker information for {selectedWorkerForEdit?.firstName} {selectedWorkerForEdit?.lastName}
            </DialogDescription>
          </DialogHeader>

          <Form {...editWorkerForm}>
            <form
              noValidate
              onSubmit={editWorkerForm.handleSubmit((data) => {
                if (selectedWorkerForEdit) {
                  updateWorkerMutation.mutate(data);
                }
              })}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                  control={editWorkerForm.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-edit-worker-firstname" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editWorkerForm.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-edit-worker-lastname" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={editWorkerForm.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Worker Code</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-edit-worker-code" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editWorkerForm.control}
                name="monthlySalary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Salary</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-edit-worker-salary" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editWorkerForm.control}
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department (Optional)</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-edit-worker-department" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editWorkerForm.control}
                name="active"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-edit-worker-active"
                      />
                    </FormControl>
                    <FormLabel className="!mt-0">Active</FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditWorkerDialogOpen(false)}
                  data-testid="button-cancel-edit-worker"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={updateWorkerMutation.isPending} data-testid="button-submit-edit-worker">
                  {updateWorkerMutation.isPending ? "Updating..." : "Update Worker"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Create Worker Group Dialog */}
      <Dialog open={createWorkerGroupDialogOpen} onOpenChange={setCreateWorkerGroupDialogOpen}>
        <DialogContent data-testid="dialog-create-worker-group">
          <DialogHeader>
            <DialogTitle>Create Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="worker-group-name">
                Group Name
              </label>
              <Input
                id="worker-group-name"
                value={workerGroupName}
                onChange={(event) => setWorkerGroupName(event.target.value)}
                placeholder="e.g. Lubumbashi Workers"
                data-testid="input-worker-group-name"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="worker-group-description">
                Description (Optional)
              </label>
              <Input
                id="worker-group-description"
                value={workerGroupDescription}
                onChange={(event) => setWorkerGroupDescription(event.target.value)}
                placeholder="Brief description of the group"
                data-testid="input-worker-group-description"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateWorkerGroupDialogOpen(false)}
                data-testid="button-cancel-worker-group"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => createWorkerGroupMutation.mutate()}
                disabled={!workerGroupName.trim() || createWorkerGroupMutation.isPending}
                data-testid="button-submit-worker-group"
              >
                Create Group
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Manage Group Members Dialog */}
      <Dialog open={workerGroupMembersDialogOpen} onOpenChange={setWorkerGroupMembersDialogOpen}>
        <DialogContent className="max-w-lg" data-testid="dialog-worker-group-members">
          <DialogHeader>
            <DialogTitle>Manage Group: {selectedWorkerGroupForMembers?.name}</DialogTitle>
            <DialogDescription>Toggle workers in or out of this group.</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">In Group</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Department</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allWorkers.map((worker) => {
                  const liveGroup = allWorkerGroups.find((g) => g.id === selectedWorkerGroupForMembers?.id);
                  const isMember = liveGroup?.members?.some((m: { id: number }) => m.id === worker.id);
                  return (
                    <TableRow key={worker.id}>
                      <TableCell>
                        <Checkbox
                          checked={!!isMember}
                          onCheckedChange={(checked) => {
                            if (!selectedWorkerGroupForMembers) return;
                            if (checked) {
                              addWorkerToWorkerGroupMutation.mutate({
                                groupId: selectedWorkerGroupForMembers.id,
                                workerId: worker.id,
                              });
                            } else {
                              removeWorkerFromWorkerGroupMutation.mutate({
                                groupId: selectedWorkerGroupForMembers.id,
                                workerId: worker.id,
                              });
                            }
                          }}
                          data-testid={`checkbox-group-member-${worker.id}`}
                        />
                      </TableCell>
                      <TableCell>{[worker.firstName, worker.lastName].filter(Boolean).join(" ")}</TableCell>
                      <TableCell className="text-muted-foreground">{worker.department || "—"}</TableCell>
                    </TableRow>
                  );
                })}
                {allWorkers.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                      No workers found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end pt-2">
            <Button onClick={() => setWorkerGroupMembersDialogOpen(false)} data-testid="button-close-group-members">
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Worker Balance Conflict Alert */}
      <AlertDialog open={!!deleteWorkerConflict} onOpenChange={(open) => !open && setDeleteWorkerConflict(null)}>
        <AlertDialogContent data-testid="dialog-delete-worker-conflict">
          <AlertDialogHeader>
            <AlertDialogTitle>Worker Has Non-Zero Balance</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteWorkerConflict && (
                <>
                  <span className="font-semibold">
                    {deleteWorkerConflict.employee.firstName} {deleteWorkerConflict.employee.lastName}
                  </span>{" "}
                  has a non-zero balance:
                  <div className="mt-2 space-y-1 font-mono text-sm">
                    <div>Employee Balance: {formatAmount(deleteWorkerConflict.employeeBalance)}</div>
                    <div>Ledger Balance: {formatAmount(deleteWorkerConflict.ledgerBalance)}</div>
                  </div>
                  <p className="mt-3">
                    Deleting this worker will also delete their linked ledger account. This action cannot be undone.
                  </p>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setDeleteWorkerConflict(null)}
              data-testid="button-cancel-force-delete-worker"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleForceDeleteWorker}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-force-delete-worker"
            >
              Delete Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
