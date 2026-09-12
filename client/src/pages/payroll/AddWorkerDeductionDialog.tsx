import type { UseFormReturn } from "react-hook-form";
import type { Employee } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export interface WorkerDeductionFormData {
  workerId: string;
  amount: string;
  reason: string;
  deductionDate: string;
}

interface AddWorkerDeductionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: UseFormReturn<WorkerDeductionFormData>;
  workerStaff: Employee[];
  isPending: boolean;
  onSubmit: (data: WorkerDeductionFormData) => void;
}

export function AddWorkerDeductionDialog({
  open,
  onOpenChange,
  form,
  workerStaff,
  isPending,
  onSubmit,
}: AddWorkerDeductionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Worker Deduction</DialogTitle>
          <DialogDescription>Record a deduction from a worker's salary.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form noValidate onSubmit={form.handleSubmit((data) => onSubmit(data))} className="space-y-4">
            <FormField
              control={form.control}
              name="workerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Worker</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-deduction-worker">
                        <SelectValue placeholder="Select worker" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {workerStaff.map((w) => (
                        <SelectItem key={w.id} value={String(w.id)}>
                          {w.firstName} {w.lastName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      {...field}
                      data-testid="input-deduction-amount"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="deductionDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-deduction-date" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (Optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="e.g. Damage, absence, etc."
                      {...field}
                      data-testid="textarea-deduction-reason"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-deduction"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending} data-testid="button-save-deduction">
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Deduction
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
