// Extracted from ./WorkerDialogs.tsx
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/decimal-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import type { WorkerDialogsProps } from "./WorkerDialogsTypes";

export function WorkerDialogsContent({
  createWorkerMutation,
  newWorkerDialogOpen,
  newWorkerForm,
  setNewWorkerDialogOpen,
}: Pick<
  WorkerDialogsProps,
  "createWorkerMutation" | "newWorkerDialogOpen" | "newWorkerForm" | "setNewWorkerDialogOpen"
>) {
  return (
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
                    <Input placeholder="Auto-generated if left blank" {...field} data-testid="input-new-worker-code" />
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
                    <MoneyInput step="0.01" {...field} data-testid="input-new-worker-salary" />
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
                  <FormLabel className="mt-0!">Active</FormLabel>
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
              <FormSubmitButton
                type="submit"
                pending={createWorkerMutation.isPending}
                pendingLabel="Creating…"
                data-testid="button-submit-new-worker"
              >
                Create Worker
              </FormSubmitButton>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
