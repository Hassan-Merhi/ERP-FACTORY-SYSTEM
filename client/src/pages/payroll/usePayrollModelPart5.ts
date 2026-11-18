// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { usePayrollModelPart1 } from "./usePayrollModelPart1";

export function usePayrollModelPart5({
  assertCanChangeRecords,
  modeApiRequest,
  setWorkerDeductionAmount,
  setWorkerDeductionReason,
  setWorkerDeductionTarget,
  toast,
  workerDeductionAmount,
  workerDeductionDate,
  workerDeductionReason,
  workerDeductionTarget,
}: Pick<
  Awaited<ReturnType<typeof usePayrollModelPart1>>,
  | "assertCanChangeRecords"
  | "modeApiRequest"
  | "setWorkerDeductionAmount"
  | "setWorkerDeductionReason"
  | "setWorkerDeductionTarget"
  | "toast"
  | "workerDeductionAmount"
  | "workerDeductionDate"
  | "workerDeductionReason"
  | "workerDeductionTarget"
>) {
  const workerDeductionMutation = useMutation({
    mutationFn: async () => {
      assertCanChangeRecords();
      if (!workerDeductionTarget) throw new Error("No worker selected");
      return await modeApiRequest("POST", `/api/factory/workers/${workerDeductionTarget.id}/deductions`, {
        amount: workerDeductionAmount,
        reason: workerDeductionReason || null,
        deductionDate: workerDeductionDate,
      });
    },
    onSuccess: () => {
      toast({ title: "Deduction added", description: "Pending deduction saved." });
      setWorkerDeductionTarget(null);
      setWorkerDeductionAmount("");
      setWorkerDeductionReason("");
    },
  });
  return { workerDeductionMutation };
}
