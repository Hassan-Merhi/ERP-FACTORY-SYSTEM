import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  apiRequest: vi.fn(),
  formResets: [] as ReturnType<typeof vi.fn>[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/employees") {
      return {
        data: [
          {
            id: 1,
            firstName: "Alice",
            lastName: "Admin",
            code: "E1",
            employeeType: "Employee",
            monthlySalary: "1000",
            active: true,
            calculatedBalance: "250",
            salesBonusPct: "5",
            salesBonusPctLocationId: 11,
          },
          {
            id: 2,
            firstName: "Will",
            lastName: "Worker",
            code: "W1",
            employeeType: "Worker",
            monthlySalary: "600",
            active: true,
            calculatedBalance: "0",
          },
        ],
        isLoading: false,
      };
    }
    if (root === "/api/bank-accounts") return { data: [{ id: 30, accountName: "Bank" }], isLoading: false };
    if (root === "/api/ledger-accounts") return { data: [{ id: 40, accountType: "Cash", accountName: "Till" }] };
    if (root === "/api/payroll/worker-payments-summary") return { data: { totalPaid: "50" } };
    if (root === "/api/worker-groups/with-members") return { data: [{ id: 8, name: "Pressing", members: [] }] };
    if (root === "/api/locations") return { data: [{ id: 11, name: "Main", companyId: 4 }] };
    if (root === "/api/employee-groups") return { data: [] };
    if (root === "/api/accounts/employee") return { data: [], isLoading: false };
    return { data: [] };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value?: any) => {
      try {
        const result = await config.mutationFn(value);
        config.onSuccess?.(result);
        return result;
      } catch (error) {
        config.onError?.(error);
        throw error;
      }
    }),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: 4, name: "GC Lshi" },
    companies: [
      { id: 4, name: "GC Lshi" },
      { id: 5, name: "Partner" },
    ],
  }),
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "erp" }));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (value: unknown) => `$${value}` }),
}));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.apiRequest }));
vi.mock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries: harness.invalidateQueries } }));
vi.mock("@hookform/resolvers/zod", () => ({ zodResolver: () => undefined }));
vi.mock("react-hook-form", () => ({
  useForm: () => {
    const reset = vi.fn();
    harness.formResets.push(reset);
    return {
      reset,
      handleSubmit: (fn: any) => fn,
      register: vi.fn(),
      watch: vi.fn(),
      setValue: vi.fn(),
      formState: { errors: {} },
    };
  },
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: any) => <h1>{title}</h1> }));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: any) => <div>{children}</div>,
  TabsList: ({ children }: any) => <div>{children}</div>,
  TabsTrigger: ({ children, value }: any) => <button data-tab={value}>{children}</button>,
  TabsContent: ({ children, value }: any) => <section data-content={value}>{children}</section>,
}));
vi.mock("@/components/ERPRunPayroll", () => ({ default: () => <div>Run payroll model</div> }));

vi.mock("@/pages/payroll/EmployeesTab", () => ({
  EmployeesTab: (props: any) => (
    <div>
      <div data-testid="employee-count">{props.filteredEmployeeStaff.length}</div>
      <button onClick={() => props.handleDeposit(props.employeeStaff[0])}>Deposit Alice</button>
      <button onClick={() => props.handleWithdrawal(props.employeeStaff[0])}>Withdraw Alice</button>
      <button onClick={() => props.handleBonus(props.employeeStaff[0])}>Bonus Alice</button>
      <button onClick={() => props.setStatementEmployee(props.employeeStaff[0])}>Statement Alice</button>
      <button
        onClick={() => {
          props.setEditingEmployee(props.employeeStaff[0]);
          props.setEditEmployeeDialogOpen(true);
        }}
      >
        Edit Alice
      </button>
      <button onClick={() => props.setEmpSearch("missing")}>Filter missing</button>
    </div>
  ),
}));
vi.mock("@/pages/payroll/WorkersTab", () => ({
  WorkersTab: (props: any) => (
    <div>
      <div data-testid="worker-count">{props.workerStaff.length}</div>
      <button onClick={() => props.handleToggleWorker(2, true)}>Select worker</button>
      <button onClick={() => props.handleUpdateAmount(2, "725")}>Set worker amount</button>
      <button onClick={() => props.setWorkerDeductionTarget(props.workerStaff[0])}>Deduct worker</button>
    </div>
  ),
}));
vi.mock("@/pages/payroll/AdvancesTab", () => ({
  AdvancesTab: ({ cashAccounts }: any) => <div>Advances cash {cashAccounts.length}</div>,
}));

vi.mock("@/pages/payroll/DepositDialog", () => ({
  DepositDialog: ({ open, selectedEmployee, mutation }: any) =>
    open ? (
      <div data-testid="deposit-dialog">
        <span>{selectedEmployee?.firstName}</span>
        <button onClick={() => mutation.mutate({ amount: "125", date: "2026-08-11", notes: "salary" })}>
          Submit deposit
        </button>
      </div>
    ) : null,
}));
vi.mock("@/pages/payroll/WithdrawalDialog", () => ({
  WithdrawalDialog: ({ open, selectedEmployee, mutation }: any) =>
    open ? (
      <div data-testid="withdrawal-dialog">
        <span>{selectedEmployee?.firstName}</span>
        <button
          onClick={() =>
            mutation.mutate({
              amount: "75",
              paymentAccountType: "cash",
              paymentAccountId: "40",
              date: "2026-08-11",
              notes: "cash out",
            })
          }
        >
          Submit withdrawal
        </button>
      </div>
    ) : null,
}));
vi.mock("@/pages/payroll/BonusDialog", () => ({
  BonusDialog: ({ open, selectedEmployee, bonusSalesCustomPct, bonusSalesLocationId }: any) =>
    open ? (
      <div data-testid="bonus-dialog">
        {selectedEmployee?.firstName}:{bonusSalesCustomPct}:{bonusSalesLocationId}
      </div>
    ) : null,
}));
vi.mock("@/pages/payroll/EmployeeStatementDialog", () => ({
  EmployeeStatementDialog: ({ statementEmployee, cleanTxnDesc }: any) =>
    statementEmployee ? (
      <div data-testid="statement-dialog">
        {statementEmployee.firstName}:{cleanTxnDesc("SAL-DEP-ABC Salary payment")}
      </div>
    ) : null,
}));
vi.mock("@/pages/payroll/EditEmployeeDialog", () => ({
  EditEmployeeDialog: ({ open }: any) => (open ? <div data-testid="edit-dialog">editing</div> : null),
}));
vi.mock("@/pages/payroll/PayrollDialogs", () => ({
  WorkerDeductionDialog: ({ target, setAmount, setReason, mutation }: any) =>
    target ? (
      <div data-testid="deduction-dialog">
        <button
          onClick={() => {
            setAmount("25");
            setReason("uniform");
          }}
        >
          Fill deduction
        </button>
        <button onClick={() => mutation.mutate()}>Submit deduction</button>
      </div>
    ) : null,
}));
vi.mock("@/pages/payroll/BulkDialogs", () => ({
  BulkDialogs: ({ handleSelectAllEmployees, bulkDepositTotal }: any) => (
    <div>
      <span data-testid="bulk-total">{bulkDepositTotal}</span>
      <button onClick={() => handleSelectAllEmployees(true)}>Select all salaries</button>
    </div>
  ),
}));
vi.mock("@/pages/payroll/BulkPaymentDialog", () => ({
  BulkPaymentDialog: ({ selectedPayments, totalAmount }: any) => (
    <div data-testid="worker-payment-summary">
      {selectedPayments.length}:{totalAmount}
    </div>
  ),
}));
vi.mock("@/pages/payroll/WorkerDialogs", () => ({ WorkerDialogs: () => null }));
vi.mock("@/pages/payroll/EmployeeCrudDialogs", () => ({ EmployeeCrudDialogs: () => null }));

import Payroll from "@/pages/Payroll";

describe("ERP payroll page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.formResets.splice(0);
    harness.apiRequest.mockResolvedValue({ json: async () => ({ results: [] }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [], text: async () => "" }))
    );
  });

  it("separates employee/worker views and drives deposit, withdrawal, statement, bonus, and edit state", async () => {
    render(<Payroll />);

    expect(screen.getByRole("heading", { name: "Payroll Management" })).toBeInTheDocument();
    expect(screen.getByTestId("employee-count")).toHaveTextContent("1");
    expect(screen.getByTestId("worker-count")).toHaveTextContent("1");
    expect(screen.getByText("Advances cash 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deposit Alice" }));
    expect(screen.getByTestId("deposit-dialog")).toHaveTextContent("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Submit deposit" }));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/payroll/deposit-employee", {
        employeeId: 1,
        amount: "125",
        date: "2026-08-11",
        notes: "salary",
      })
    );
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Success", description: "Deposit recorded successfully" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Withdraw Alice" }));
    expect(screen.getByTestId("withdrawal-dialog")).toHaveTextContent("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Submit withdrawal" }));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/payroll/withdraw-employee", {
        employeeId: 1,
        amount: "75",
        paymentAccountType: "cash",
        paymentAccountId: "40",
        date: "2026-08-11",
        notes: "cash out",
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Bonus Alice" }));
    expect(screen.getByTestId("bonus-dialog")).toHaveTextContent("Alice:5:11");

    fireEvent.click(screen.getByRole("button", { name: "Statement Alice" }));
    expect(screen.getByTestId("statement-dialog")).toHaveTextContent("Alice:Salary payment");

    fireEvent.click(screen.getByRole("button", { name: "Edit Alice" }));
    expect(screen.getByTestId("edit-dialog")).toBeInTheDocument();
  });

  it("filters employees, derives bulk salary selection, and builds worker payment state", async () => {
    render(<Payroll />);

    fireEvent.click(screen.getByRole("button", { name: "Filter missing" }));
    expect(screen.getByTestId("employee-count")).toHaveTextContent("0");

    fireEvent.click(screen.getByRole("button", { name: "Select all salaries" }));
    await waitFor(() => expect(screen.getByTestId("bulk-total")).toHaveTextContent("1000"));

    fireEvent.click(screen.getByRole("button", { name: "Select worker" }));
    await waitFor(() => expect(screen.getByTestId("worker-payment-summary")).toHaveTextContent("1:600"));
    fireEvent.click(screen.getByRole("button", { name: "Set worker amount" }));
    await waitFor(() => expect(screen.getByTestId("worker-payment-summary")).toHaveTextContent("1:725"));
  });

  it("posts a pending worker deduction through the selected worker", async () => {
    render(<Payroll />);
    fireEvent.click(screen.getByRole("button", { name: "Deduct worker" }));
    expect(screen.getByTestId("deduction-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fill deduction" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit deduction" }));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/factory/workers/2/deductions",
        expect.objectContaining({ amount: "25", reason: "uniform" })
      )
    );
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Deduction added" }));
  });
});
