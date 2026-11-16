// Extracted from ./useFactoryWorkerDetailModel.tsx to keep that module under the source-size cap.
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { fmt } from "./utils";
import { errorMessage } from "./useFactoryWorkerDetailModelTypes";
import { useFactoryWorkerDetailModelPart1 } from "./useFactoryWorkerDetailModelPart1";

export function useFactoryWorkerDetailModelPart3({
  endCashAccountId,
  endEnd,
  endResult,
  endStart,
  fileInputRef,
  payrolls,
  recordChanges,
  setEndCalculating,
  setEndCashAccountId,
  setEndEnd,
  setEndOpen,
  setEndResult,
  setEndStart,
  setEndStep,
  setEndSubmitting,
  toast,
  worker,
  workerAdvances,
  workerId,
}: Pick<
  Awaited<ReturnType<typeof useFactoryWorkerDetailModelPart1>>,
  | "endCashAccountId"
  | "endEnd"
  | "endResult"
  | "endStart"
  | "fileInputRef"
  | "payrolls"
  | "recordChanges"
  | "setEndCalculating"
  | "setEndCashAccountId"
  | "setEndEnd"
  | "setEndOpen"
  | "setEndResult"
  | "setEndStart"
  | "setEndStep"
  | "setEndSubmitting"
  | "toast"
  | "worker"
  | "workerAdvances"
  | "workerId"
>) {
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !workerId || !recordChanges.allowed) return;
    const fd = new FormData();
    fd.append("photo", file);
    try {
      const res = await fetch(`/api/factory/workers/${workerId}/photo`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Photo updated" });
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const openEndContract = () => {
    if (!worker) return;
    setEndStep(1);
    setEndResult(null);
    setEndCashAccountId("");
    const today = new Date().toLocaleDateString("en-CA");
    const firstOfMonth = today.slice(0, 7) + "-01";
    setEndStart(worker.contractStartDate || worker.dateJoined || firstOfMonth);
    setEndEnd(today);
    setEndOpen(true);
  };

  const handleCalculate = async () => {
    if (!worker || !endStart || !endEnd) return;
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    setEndCalculating(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/settle-and-end`, {
        companyId: worker.companyId,
        startDate: endStart,
        endDate: endEnd,
        dryRun: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Calculation failed");
      setEndResult(data);
      setEndStep(2);
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    } finally {
      setEndCalculating(false);
    }
  };

  const handleEndContract = async (payNow: boolean) => {
    if (!worker || !recordChanges.allowed) return;
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    setEndSubmitting(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/settle-and-end`, {
        companyId: worker.companyId,
        startDate: endStart,
        endDate: endEnd,
        payNow,
        cashAccountId: payNow ? endCashAccountId : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to end contract");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({
        title: "Contract ended",
        description: payNow ? `Paid ${fmt(data.balance)}` : "Balance recorded as pending",
      });
      setEndOpen(false);
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    } finally {
      setEndSubmitting(false);
    }
  };

  const handleSkipAndEnd = async () => {
    if (!worker || !recordChanges.allowed) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Requires a connection", variant: "destructive" });
      return;
    }
    setEndSubmitting(true);
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/settle-and-end`, {
        companyId: worker.companyId,
        endDate: endEnd || today,
        skipSettlement: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to end contract");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Contract ended", description: "Worker deactivated. No settlement payroll was created." });
      setEndOpen(false);
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    } finally {
      setEndSubmitting(false);
    }
  };

  const payrollBalance = endResult ? parseFloat(endResult.balance) : 0;
  const totalPaidSalary =
    payrolls?.filter((p) => p.status === "PAID").reduce((s, p) => s + parseFloat(p.netSalary || "0"), 0) ?? 0;
  const totalPaidBonuses =
    payrolls?.filter((p) => p.status === "PAID").reduce((s, p) => s + parseFloat(p.bonuses || "0"), 0) ?? 0;
  const totalAdvancesGiven = workerAdvances?.reduce((s, a) => s + parseFloat(a.amount || "0"), 0) ?? 0;
  const totalPaid = totalPaidSalary;
  const totalPending =
    payrolls?.filter((p) => p.status !== "PAID").reduce((s, p) => s + parseFloat(p.netSalary || "0"), 0) ?? 0;
  const advancesLeft = (workerAdvances || [])
    .filter((a) => !a.fullyPaid)
    .reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
  // netSalary already has advance deductions baked in, so subtract only the REMAINING advance balance to avoid double-counting
  const netBalance = totalPaidSalary + totalPaidBonuses - advancesLeft;
  return {
    advancesLeft,
    handleCalculate,
    handleEndContract,
    handlePhotoUpload,
    handleSkipAndEnd,
    netBalance,
    openEndContract,
    payrollBalance,
    totalAdvancesGiven,
    totalPaid,
    totalPaidBonuses,
    totalPaidSalary,
    totalPending,
  };
}
