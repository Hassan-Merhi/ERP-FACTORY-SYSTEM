import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { queryClient } from "@/lib/queryClient";
import type { getApiRequest } from "@/lib/factoryApi";
import type { Employee } from "@shared/schema";
import type { SalaryAdvance } from "./payrollSchemas";

interface AdvanceReassignDialogProps {
  target: SalaryAdvance | null;
  workers: Employee[];
  companyId: number | undefined;
  apiRequest: ReturnType<typeof getApiRequest>;
  onClose: () => void;
}

/** Admin/Owner/Developer correction of the worker a salary advance belongs to. */
export function AdvanceReassignDialog({ target, workers, companyId, apiRequest, onClose }: AdvanceReassignDialogProps) {
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const [workerId, setWorkerId] = useState("");

  useEffect(() => {
    setWorkerId(target ? String(target.employeeId) : "");
  }, [target]);

  const reassignAdvanceMutation = useMutation({
    mutationFn: async ({ advanceId, employeeId }: { advanceId: number; employeeId: number }) => {
      return await apiRequest("PATCH", `/api/salary-advances/${advanceId}/worker`, { employeeId });
    },
    onSuccess: () => {
      toast({ title: "Advance updated", description: "The advance is now assigned to the selected worker." });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advance-deductions", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees-with-balances", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Unable to change worker", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open && !reassignAdvanceMutation.isPending) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change Advance Worker</DialogTitle>
          <DialogDescription>
            Reassign {target ? formatAmount(parseFloat(target.amount)) : "this advance"} from {target?.employeeName}.
            The amount, date and remaining balance stay unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="reassign-advance-worker">
            Correct Worker
          </label>
          <Select value={workerId} onValueChange={setWorkerId}>
            <SelectTrigger id="reassign-advance-worker" data-testid="select-reassign-advance-worker">
              <SelectValue placeholder="Select worker" />
            </SelectTrigger>
            <SelectContent>
              {workers.map((worker) => (
                <SelectItem key={worker.id} value={String(worker.id)}>
                  {worker.code ? `${worker.code} - ` : ""}
                  {worker.firstName} {worker.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The linked accounting entry will move to the corrected worker. An advance with applied repayments or in a
            closed accounting period cannot be reassigned.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={reassignAdvanceMutation.isPending}>
            Cancel
          </Button>
          <Button
            data-testid="button-confirm-reassign-advance"
            disabled={
              reassignAdvanceMutation.isPending || !target || !workerId || Number(workerId) === target?.employeeId
            }
            onClick={() => {
              if (target && workerId) {
                reassignAdvanceMutation.mutate({ advanceId: target.id, employeeId: Number(workerId) });
              }
            }}
          >
            {reassignAdvanceMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Worker
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
