import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  mutationConfigs: [] as Array<Record<string, (...args: any[]) => any>>,
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  apiRequest: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
  aoaToSheet: vi.fn(() => ({})),
  bookNew: vi.fn(() => ({})),
  bookAppendSheet: vi.fn(),
  writeFile: vi.fn(),
}));

const employees = [
  {
    id: 1,
    firstName: "Ada",
    lastName: "Mensah",
    code: "W-1",
    department: "Cutting",
    employeeType: "Worker",
    active: true,
    monthlySalary: "1000",
  },
  {
    id: 2,
    firstName: "Benoit",
    lastName: "Kossi",
    code: "W-2",
    department: "Packing",
    employeeType: "Worker",
    active: true,
    monthlySalary: "800",
  },
  { id: 3, firstName: "Inactive", lastName: "Worker", employeeType: "Worker", active: false, monthlySalary: "500" },
];
const workerGroups = [
  { id: 10, name: "Production", groupType: "Worker", members: [{ id: 1 }] },
  { id: 12, name: "Backup Crew", groupType: "Worker", members: [{ id: 1 }] },
  { id: 11, name: "Supervisors", groupType: "Supervisor", members: [{ id: 2 }] },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = queryKey[0];
    if (key === "/api/auth/me") return { data: { role: "Developer" } };
    if (key === "/api/employees") return { data: employees, isLoading: false };
    if (key === "/api/worker-groups/with-members") return { data: workerGroups, isLoading: false };
    if (key === "/api/ledger-accounts") return { data: [{ id: 90, accountType: "Cash", name: "Cashbox" }] };
    if (key === "/api/salary-advances")
      return {
        data: [
          { id: 1, employeeId: 1, remainingBalance: "200", fullyPaid: false },
          { id: 2, employeeId: 1, remainingBalance: "50", fullyPaid: false },
          { id: 3, employeeId: 2, remainingBalance: "100", fullyPaid: true },
        ],
      };
    if (key === "/api/payroll/worker-deductions")
      return {
        data: [
          { id: 1, workerId: 1, amount: "25", applied: false },
          { id: 2, workerId: 1, amount: "5", applied: false },
          { id: 3, workerId: 2, amount: "10", applied: true },
        ],
      };
    if (key === "/api/payroll/runs") return { data: [], isLoading: false };
    return { data: [] };
  },
  useMutation: (config: Record<string, (...args: any[]) => any>) => {
    harness.mutationConfigs.push(config);
    return { mutate: vi.fn(), isPending: false };
  },
}));
vi.mock("../../client/src/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 4, displayCurrency: "USD" } }),
}));
vi.mock("../../client/src/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (amount: number) => `USD ${amount.toFixed(2)}` }),
}));
vi.mock("../../client/src/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("../../client/src/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));
vi.mock("xlsx-js-style", () => ({
  default: {
    utils: {
      aoa_to_sheet: harness.aoaToSheet,
      book_new: harness.bookNew,
      book_append_sheet: harness.bookAppendSheet,
    },
    writeFile: harness.writeFile,
  },
}));

import { useERPRunPayrollModel } from "../../client/src/components/erprunpayroll/useERPRunPayrollModel";

const payrollRun = {
  id: 70,
  date: "2026-08-11",
  status: "DRAFT",
  notes: "August payroll",
  items: [
    {
      employeeId: 1,
      employeeName: "Ada Mensah",
      groupName: "Production",
      baseSalary: "1000",
      deduction: "250",
      payrollDeduction: "30",
      netPay: "720",
    },
    {
      employeeId: 2,
      employeeName: "Benoit Kossi",
      groupName: "Ungrouped",
      baseSalary: "800",
      deduction: "0",
      payrollDeduction: "0",
      netPay: "800",
    },
  ],
};

describe("ERP payroll model positive paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.mutationConfigs.splice(0);
    harness.apiRequest.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.spyOn(window, "open").mockReturnValue({
      document: { write: harness.write, close: harness.close },
    } as never);
  });

  it("selects grouped and ungrouped workers, applies advances/deductions, and edits a balanced preview", () => {
    const { result } = renderHook(() => useERPRunPayrollModel());

    expect(result.current.isDeveloper).toBe(true);
    expect(result.current.workers.map((worker) => worker.id)).toEqual([1, 2]);
    expect(result.current.workerGroups.map((group) => group.id)).toEqual([10, 12]);
    expect(result.current.ungroupedWorkers.map((worker) => worker.id)).toEqual([2]);
    expect(result.current.advanceBalanceByEmployee).toEqual({ 1: 250 });
    expect(result.current.cashAccounts).toHaveLength(1);

    act(() => result.current.toggleGroupSelection([1]));
    act(() => result.current.toggleWorker(2));
    expect([...result.current.selectedWorkers]).toEqual([1, 2]);
    expect(result.current.totalSelectedBase).toBe(1800);

    act(() => result.current.enterPreview());
    expect(result.current.step).toBe(2);
    expect(result.current.previewItems).toHaveLength(2);
    expect(result.current.previewItems).toEqual([
      expect.objectContaining({
        employeeId: 1,
        groupName: "Production",
        baseSalary: 1000,
        deduction: 250,
        pendingDeductions: 30,
        netPay: 720,
      }),
      expect.objectContaining({
        employeeId: 2,
        groupName: "Ungrouped",
        baseSalary: 800,
        deduction: 0,
        pendingDeductions: 0,
        netPay: 800,
      }),
    ]);
    expect(result.current.previewTotalBase).toBe(1800);
    expect(result.current.previewTotalNet).toBe(1520);

    act(() => result.current.updateDeduction(0, "100"));
    expect(result.current.previewItems[0]).toMatchObject({ deduction: 100, netPay: 870 });
    act(() => result.current.toggleGroup("ungrouped"));
    expect(result.current.expandedGroups.ungrouped).toBe(false);
    act(() => result.current.setSearchQuery("ADA"));
    expect([...result.current.filtered]).toEqual([1]);
  });

  it("produces the printable and spreadsheet payroll evidence with dates, codes, totals, and deductions", async () => {
    const { result } = renderHook(() => useERPRunPayrollModel());

    expect(result.current.getRunDateHeaders("2026-08-29")).toEqual([
      "29-Aug",
      "30-Aug",
      "31-Aug",
      "01-Sep",
      "02-Sep",
      "03-Sep",
      "04-Sep",
      "05-Sep",
      "06-Sep",
      "07-Sep",
    ]);
    expect(result.current.getRunTemplateRows(payrollRun as never)).toEqual([
      { code: "W-1", name: "Ada Mensah", days: Array(10).fill("") },
      { code: "W-2", name: "Benoit Kossi", days: Array(10).fill("") },
    ]);

    result.current.printRun(payrollRun as never);
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining("Worker Salaries"));
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining("USD\u00a01,520.00"));
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining("Payroll Deduction"));
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining("-USD\u00a030.00"));
    expect(harness.write).toHaveBeenCalledWith(expect.stringContaining("August payroll"));
    expect(harness.close).toHaveBeenCalledOnce();

    await result.current.exportRunExcel(payrollRun as never);
    expect(harness.aoaToSheet).toHaveBeenCalled();
    expect(harness.bookAppendSheet).toHaveBeenCalledWith(expect.anything(), expect.anything(), "Payroll");
    expect(harness.writeFile).toHaveBeenCalledWith(expect.anything(), "payroll-70-2026-08-11.xlsx");
  });

  it("executes every payroll mutation contract and applies their success/error state transitions", async () => {
    const { result } = renderHook(() => useERPRunPayrollModel());

    act(() => {
      result.current.toggleWorker(1);
    });
    act(() => result.current.enterPreview());
    // Every render registers the hook's five mutations again; take the latest
    // render's, whose closures see the preview built above.
    const [saveDraft, payRun, deleteRun, undoRun, migrate] = harness.mutationConfigs.slice(-5);

    // Each render registers five mutations; take the latest render's set so the
    // draft mutation closes over the preview items built above.
    const [saveDraft, payRun, deleteRun, undoRun, migrate] = harness.mutationConfigs.slice(-5);

    await expect(saveDraft.mutationFn()).resolves.toEqual({ ok: true });
    expect(harness.apiRequest).toHaveBeenCalledWith(
      "POST",
      "/api/payroll/runs",
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ employeeId: 1, payrollDeduction: "30.00", netPay: "720.00" }),
        ]),
      })
    );
    await expect(payRun.mutationFn({ runId: 70, accountId: "90" })).resolves.toEqual({ ok: true });
    await expect(deleteRun.mutationFn(70)).resolves.toBeUndefined();
    await expect(undoRun.mutationFn(70)).resolves.toBeUndefined();
    await expect(migrate.mutationFn()).resolves.toEqual({ ok: true });

    act(() => {
      saveDraft.onSuccess();
      payRun.onSuccess({});
      deleteRun.onSuccess();
      undoRun.onSuccess();
      migrate.onSuccess({ migrated: 2, total: 2 });
      migrate.onError(new Error("Owner approval required"));
    });

    expect(result.current.activeTab).toBe("history");
    expect(result.current.selectedWorkers.size).toBe(0);
    expect(result.current.migrateConfirmOpen).toBe(false);
    expect(harness.invalidateQueries).toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payroll paid" }));
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payroll undone" }));
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Migration failed", variant: "destructive" })
    );
  });
});
