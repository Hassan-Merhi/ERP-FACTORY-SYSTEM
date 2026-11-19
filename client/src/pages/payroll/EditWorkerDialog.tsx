// Extracted from ./WorkerDialogs.tsx
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import type { WorkerDialogsProps } from "./WorkerDialogs";
import type { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

export function EditWorkerDialog({
  recordChanges,
  editWorkerDialogOpen,
  setEditWorkerDialogOpen,
  selectedWorkerForEdit,
  editWorkerForm,
  updateWorkerMutation,
}: {
  recordChanges: ReturnType<typeof useExistingRecordChangeAccess>;
  editWorkerDialogOpen: WorkerDialogsProps["editWorkerDialogOpen"];
  setEditWorkerDialogOpen: WorkerDialogsProps["setEditWorkerDialogOpen"];
  selectedWorkerForEdit: WorkerDialogsProps["selectedWorkerForEdit"];
  editWorkerForm: WorkerDialogsProps["editWorkerForm"];
  updateWorkerMutation: WorkerDialogsProps["updateWorkerMutation"];
}) {
  return (
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
                  <FormLabel className="mt-0!">Active</FormLabel>
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
              {recordChanges.allowed && (
                <Button type="submit" disabled={updateWorkerMutation.isPending} data-testid="button-submit-edit-worker">
                  {updateWorkerMutation.isPending ? "Updating..." : "Update Worker"}
                </Button>
              )}
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
