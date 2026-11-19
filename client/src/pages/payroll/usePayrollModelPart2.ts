// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import type { Employee } from "@shared/schema";
import { decodeLocationOption, errorMessage } from "./payrollUtils";
import type { SalesPreview } from "./payrollTypes";
import { getThisMonthRange } from "./payrollSchemas";
import { usePayrollModelPart1 } from "./usePayrollModelPart1";
import { usePayrollModelPart8 } from "./usePayrollModelPart8";

export function usePayrollModelPart2({
  assertCanChangeRecords,
  balesEnd,
  balesPeriod,
  balesRows,
  balesStart,
  bonusSalesEnd,
  bonusSalesLocationId,
  bonusSalesPeriod,
  bonusSalesStart,
  depositForm,
  editEmployeeForm,
  editingEmployee,
  employeeGroups,
  modeApiRequest,
  selectedCompany,
  selectedEmployee,
  setBalesPeriod,
  setBalesRows,
  setBonusDate,
  setBonusDialogOpen,
  setBonusNotes,
  setBonusSalesCustomPct,
  setBonusSalesEnd,
  setBonusSalesLoading,
  setBonusSalesLocationId,
  setBonusSalesPeriod,
  setBonusSalesPreview,
  setBonusSalesStart,
  setBonusTab,
  setDepositDialogOpen,
  setEditBalePctRates,
  setEditBaleRates,
  setSelectedEmployee,
  setWithdrawalDialogOpen,
  showError,
  toast,
  withdrawalForm,
}: Pick<
  Awaited<ReturnType<typeof usePayrollModelPart1>>,
  | "assertCanChangeRecords"
  | "balesEnd"
  | "balesPeriod"
  | "balesRows"
  | "balesStart"
  | "bonusSalesEnd"
  | "bonusSalesLocationId"
  | "bonusSalesPeriod"
  | "bonusSalesStart"
  | "depositForm"
  | "editEmployeeForm"
  | "editingEmployee"
  | "employeeGroups"
  | "modeApiRequest"
  | "selectedCompany"
  | "selectedEmployee"
  | "setBalesPeriod"
  | "setBalesRows"
  | "setBonusDate"
  | "setBonusDialogOpen"
  | "setBonusNotes"
  | "setBonusSalesCustomPct"
  | "setBonusSalesEnd"
  | "setBonusSalesLoading"
  | "setBonusSalesLocationId"
  | "setBonusSalesPeriod"
  | "setBonusSalesPreview"
  | "setBonusSalesStart"
  | "setBonusTab"
  | "setDepositDialogOpen"
  | "setEditBalePctRates"
  | "setEditBaleRates"
  | "setSelectedEmployee"
  | "setWithdrawalDialogOpen"
  | "showError"
  | "toast"
  | "withdrawalForm"
>) {
  const { depositMutation, withdrawalMutation, handleDeposit, handleWithdrawal } = usePayrollModelPart8({
    assertCanChangeRecords,
    depositForm,
    editEmployeeForm,
    editingEmployee,
    employeeGroups,
    modeApiRequest,
    selectedCompany,
    selectedEmployee,
    setDepositDialogOpen,
    setEditBalePctRates,
    setEditBaleRates,
    setSelectedEmployee,
    setWithdrawalDialogOpen,
    toast,
    withdrawalForm,
  });

  const handleBonus = (emp: Employee) => {
    setSelectedEmployee(emp);
    setBonusTab("sales");
    setBonusSalesPreview(null);
    setBonusSalesCustomPct(emp.salesBonusPct ? String(emp.salesBonusPct) : "");
    setBonusSalesLocationId(emp.salesBonusPctLocationId ? String(emp.salesBonusPctLocationId) : "");
    setBonusSalesPeriod("thisMonth");
    setBonusSalesStart("");
    setBonusSalesEnd("");
    setBalesRows([
      {
        locationId: "",
        sourceCompanyId: "",
        qty: "",
        rate: emp.balesBonusRate != null ? String(emp.balesBonusRate) : "",
        preview: null,
        loading: false,
      },
    ]);
    setBalesPeriod("thisMonth");
    setBonusDate(new Date().toLocaleDateString("en-CA"));
    setBonusNotes("");
    setBonusDialogOpen(true);
  };

  const fetchSalesPreview = async () => {
    if (!bonusSalesLocationId) return;
    setBonusSalesLoading(true);
    setBonusSalesPreview(null);
    try {
      const range =
        bonusSalesPeriod === "thisMonth" ? getThisMonthRange() : { start: bonusSalesStart, end: bonusSalesEnd };
      const { locationId, sourceCompanyId } = decodeLocationOption(bonusSalesLocationId);
      const sourceParam = sourceCompanyId ? `&sourceCompanyId=${sourceCompanyId}` : "";
      const res = await fetch(
        `/api/payroll/sales-summary?locationId=${locationId}&startDate=${range.start}&endDate=${range.end}${sourceParam}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SalesPreview;
      setBonusSalesPreview(data);
    } catch (error: unknown) {
      showError("Load failed")(error);
    } finally {
      setBonusSalesLoading(false);
    }
  };

  const fetchBalesQty = async (idx: number) => {
    const row = balesRows[idx];
    if (!row.locationId) return;
    setBalesRows((previous) => previous.map((row, index) => (index === idx ? { ...row, loading: true } : row)));
    try {
      const range = balesPeriod === "thisMonth" ? getThisMonthRange() : { start: balesStart, end: balesEnd };
      const sourceParam = row.sourceCompanyId ? `&sourceCompanyId=${row.sourceCompanyId}` : "";
      const res = await fetch(
        `/api/payroll/sales-summary?locationId=${row.locationId}&startDate=${range.start}&endDate=${range.end}${sourceParam}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SalesPreview;
      setBalesRows((previous) =>
        previous.map((row, index) => (index === idx ? { ...row, qty: data.totalQuantity, loading: false } : row))
      );
    } catch (error: unknown) {
      setBalesRows((previous) => previous.map((row, index) => (index === idx ? { ...row, loading: false } : row)));
      toast({ title: "Error fetching qty", description: errorMessage(error), variant: "destructive" });
    }
  };
  return {
    depositMutation,
    fetchBalesQty,
    fetchSalesPreview,
    handleBonus,
    handleDeposit,
    handleWithdrawal,
    withdrawalMutation,
  };
}
