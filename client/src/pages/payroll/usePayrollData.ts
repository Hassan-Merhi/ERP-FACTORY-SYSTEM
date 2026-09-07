import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Employee } from "@shared/schema";
import type { useCompany } from "@/contexts/CompanyContext";
import type { AccountOption, EmployeeGroup, EmployeeTransaction, WorkerGroup } from "./payrollTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type PayrollLocation = { id: number; name: string; companyId: number };
type PayrollCompanyLocation = PayrollLocation & { companyName: string };
type PayrollCompanyOption = { id: number; name: string };

export type PayrollBonusLocation = PayrollCompanyLocation & { hasSales: boolean };

/**
 * Payroll bonus source companies can legitimately share location records.
 * Companies such as GC-LSHI post their sales against a location row owned by
 * another accessible company and therefore have no rows of their own in the
 * locations table. `/api/payroll/bonus-locations` already pairs every
 * accessible company with the locations it owns *and* the locations its own
 * sales vouchers reference, so the views below only have to split that list
 * into the active company and the other companies — while still falling back
 * to every known location for a company the server listed nothing for, so the
 * bonus pickers are never empty.
 */
export function buildPayrollLocationViews(
  bonusLocations: PayrollBonusLocation[],
  selectedCompanyId: number,
  otherCompanies: PayrollCompanyOption[]
): { locations: PayrollLocation[]; allCompanyLocations: PayrollCompanyLocation[] } {
  const canonicalById = new Map<number, PayrollBonusLocation>();
  for (const location of bonusLocations) {
    if (!canonicalById.has(location.id)) canonicalById.set(location.id, location);
  }
  const canonicalLocations = Array.from(canonicalById.values());

  const locationsForCompany = (companyId: number) => {
    const owned = bonusLocations.filter((location) => location.companyId === companyId);
    return owned.length > 0 ? owned : canonicalLocations;
  };

  const locations = locationsForCompany(selectedCompanyId).map((location) => ({
    id: location.id,
    name: location.name,
    // Keep the payroll source company in the view even when the physical
    // location row is shared from another company. The location ID remains the
    // real voucher location ID used by bonus calculation.
    companyId: selectedCompanyId,
  }));

  const allCompanyLocations = otherCompanies.flatMap((company) =>
    locationsForCompany(company.id).map((location) => ({
      id: location.id,
      name: location.name,
      companyId: company.id,
      companyName: company.name,
    }))
  );

  return { locations, allCompanyLocations };
}

export function usePayrollData({
  selectedCompany,
  companies,
  statementEmployee,
  workerOverrides,
  empSearch,
  empStatusFilter,
}: {
  selectedCompany: ReturnType<typeof useCompany>["selectedCompany"];
  companies: ReturnType<typeof useCompany>["companies"];
  statementEmployee: (Employee & { calculatedBalance?: string }) | null;
  workerOverrides: Record<number, { amount?: string; selected?: boolean; manuallyEdited?: boolean }>;
  empSearch: string;
  empStatusFilter: string;
}) {
  // Queries
  const { data: employees = [], isLoading: employeesLoading } = useQuery<
    Array<Employee & { calculatedBalance: string }>
  >({
    queryKey: ["/api/employees", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: bankAccounts = [], isLoading: bankAccountsLoading } = useQuery<AccountOption[]>({
    queryKey: ["/api/bank-accounts"],
    enabled: !!selectedCompany,
  });

  const { data: ledgerAccountsList = [] } = useQuery<AccountOption[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
    queryFn: async () => {
      if (!selectedCompany?.id) return [];
      const res = await fetch(`/api/ledger-accounts?companyId=${selectedCompany.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ledger accounts");
      return (await res.json()) as AccountOption[];
    },
    enabled: !!selectedCompany,
  });
  const cashAccounts = useMemo(
    () => ledgerAccountsList.filter((account) => account.accountType === "Cash"),
    [ledgerAccountsList]
  );

  const { data: employeeTransactions = [], isLoading: transactionsLoading } = useQuery<EmployeeTransaction[]>({
    queryKey: ["/api/accounts/employee", statementEmployee?.id],
    queryFn: async () => {
      if (!statementEmployee) return [];
      const res = await fetch(`/api/accounts/employee/${statementEmployee.id}/transactions`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch employee transactions");
      const payload: unknown = await res.json();
      const raw = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.transactions)
          ? payload.transactions
          : [];
      return raw.filter(isRecord).map((txn) => {
        const dr = Number(txn.debitAmount ?? txn.debit ?? 0) || 0;
        const cr = Number(txn.creditAmount ?? txn.credit ?? 0) || 0;
        const isDebit = dr > 0;
        return {
          ...txn,
          amount: isDebit ? dr : cr,
          isDebit,
          date: String(txn.voucherDate ?? txn.date ?? ""),
        };
      });
    },
    enabled: !!statementEmployee,
  });

  const { data: employeeGroups = [] } = useQuery<EmployeeGroup[]>({
    queryKey: ["/api/employee-groups", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const otherCompanies = useMemo(
    () => companies.filter((company) => company.id !== selectedCompany?.id),
    [companies, selectedCompany?.id]
  );

  // Bonus location options come from a payroll-scoped endpoint instead of
  // /api/locations: that route is gated behind the inventory module and rejects
  // a companyId other than the active one, so cross-company bonus locations
  // (and every location of a company that owns none) were silently missing.
  const { data: payrollCompanyLocations = [] } = useQuery<PayrollBonusLocation[]>({
    queryKey: ["/api/payroll/bonus-locations", selectedCompany?.id],
    queryFn: async () => {
      const res = await fetch("/api/payroll/bonus-locations", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch payroll bonus locations");
      const payload: unknown = await res.json();
      const rows = isRecord(payload) && Array.isArray(payload.locations) ? payload.locations : [];
      return rows.filter(isRecord).flatMap((row) => {
        if (typeof row.id !== "number" || typeof row.name !== "string" || typeof row.companyId !== "number") return [];
        return [
          {
            id: row.id,
            name: row.name,
            companyId: row.companyId,
            companyName: typeof row.companyName === "string" ? row.companyName : "",
            hasSales: row.hasSales === true,
          },
        ];
      });
    },
    enabled: !!selectedCompany?.id,
  });

  const { locations, allCompanyLocations } = useMemo(() => {
    if (!selectedCompany?.id) {
      return { locations: [] as PayrollLocation[], allCompanyLocations: [] as PayrollCompanyLocation[] };
    }
    return buildPayrollLocationViews(payrollCompanyLocations, selectedCompany.id, otherCompanies);
  }, [payrollCompanyLocations, selectedCompany?.id, otherCompanies]);

  const { data: workerGroupsData = [] } = useQuery<WorkerGroup[]>({
    queryKey: ["/api/worker-groups/with-members", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: workerPaymentSummary = null } = useQuery<unknown>({
    queryKey: ["/api/payroll/worker-payments-summary", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const employeeStaff = useMemo(() => employees.filter((e) => e.employeeType === "Employee"), [employees]);
  const workerStaff = useMemo(() => employees.filter((e) => e.employeeType === "Worker"), [employees]);

  // Derived worker payment state (merges monthlySalary defaults with manual overrides)
  const workerPayments = useMemo(() => {
    const map: Record<number, { selected: boolean; amount: string; manuallyEdited: boolean }> = {};
    workerStaff.forEach((w) => {
      const override = workerOverrides[w.id] || {};
      map[w.id] = {
        selected: override.selected ?? false,
        amount: override.amount ?? (w.monthlySalary || "0"),
        manuallyEdited: override.manuallyEdited ?? false,
      };
    });
    return map;
  }, [workerStaff, workerOverrides]);

  const ungroupedWorkers = useMemo(() => {
    const groupedIds = new Set(workerGroupsData.flatMap((group) => group.members.map((member) => member.id)));
    return workerStaff.filter((w) => !groupedIds.has(w.id));
  }, [workerStaff, workerGroupsData]);

  const selectedPayments = useMemo(
    () => workerStaff.filter((w) => workerPayments[w.id]?.selected),
    [workerStaff, workerPayments]
  );

  const totalAmount = useMemo(
    () => selectedPayments.reduce((s, w) => s + parseFloat(workerPayments[w.id]?.amount || "0"), 0),
    [selectedPayments, workerPayments]
  );

  const selectedPaymentsSummary = useMemo(
    () => selectedPayments.map((w) => ({ workerId: w.id, amount: workerPayments[w.id]?.amount || "0" })),
    [selectedPayments, workerPayments]
  );

  const filteredEmployeeStaff = useMemo(() => {
    return employeeStaff.filter((emp) => {
      const matchesSearch =
        `${emp.firstName} ${emp.lastName}`.toLowerCase().includes(empSearch.toLowerCase()) ||
        (emp.code && emp.code.toLowerCase().includes(empSearch.toLowerCase()));
      const matchesStatus =
        empStatusFilter === "All" ? true : empStatusFilter === "Active" ? emp.active !== false : emp.active === false;
      return matchesSearch && matchesStatus;
    });
  }, [employeeStaff, empSearch, empStatusFilter]);

  return {
    employees,
    employeesLoading,
    bankAccounts,
    bankAccountsLoading,
    ledgerAccountsList,
    cashAccounts,
    employeeTransactions,
    transactionsLoading,
    employeeGroups,
    locations,
    otherCompanies,
    allCompanyLocations,
    workerGroupsData,
    workerPaymentSummary,
    employeeStaff,
    workerStaff,
    workerPayments,
    ungroupedWorkers,
    selectedPayments,
    totalAmount,
    selectedPaymentsSummary,
    filteredEmployeeStaff,
  };
}
