import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins what the ERP Run Payroll screen shows at each step (worker selection,
// preview, history) so the unreachable step-1 branch inside ERPRunPayrollView
// can be removed without changing anything a user sees.

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
];
const payrollRuns = [
  {
    id: 70,
    date: "2026-08-11",
    status: "DRAFT",
    notes: "August payroll",
    itemCount: 2,
    totalBase: "1800",
    totalNet: "1520",
    items: [],
  },
  {
    id: 71,
    date: "2026-07-11",
    status: "PAID",
    notes: null,
    itemCount: 1,
    totalBase: "1000",
    totalNet: "1000",
    items: [],
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = queryKey[0];
    if (key === "/api/auth/me") return { data: { role: "Developer" } };
    if (key === "/api/employees") return { data: employees, isLoading: false };
    if (key === "/api/worker-groups/with-members")
      return { data: [{ id: 10, name: "Production", groupType: "Worker", members: [{ id: 1 }] }], isLoading: false };
    if (key === "/api/ledger-accounts") return { data: [{ id: 90, accountType: "Cash", name: "Cashbox" }] };
    if (key === "/api/payroll/runs") return { data: payrollRuns, isLoading: false };
    return { data: [] };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../client/src/contexts/CompanyContext", () => ({
  useOptionalCompany: () => null,
  useCompany: () => ({ selectedCompany: { id: 4, displayCurrency: "USD" } }),
}));
vi.mock("../../client/src/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (amount: number) => `USD ${amount.toFixed(2)}` }),
}));
vi.mock("../../client/src/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../../client/src/lib/queryClient", () => ({
  apiRequest: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

import ERPRunPayroll from "../../client/src/components/ERPRunPayroll";

describe("ERP Run Payroll screen", () => {
  beforeEach(() => window.history.replaceState({}, "", "/payroll?section=run-payroll"));

  it("selects workers in the compact table, previews them and goes back", async () => {
    const user = userEvent.setup();
    render(<ERPRunPayroll />);

    // Groups start collapsed in the compact selection table.
    expect(screen.getByTestId("group-toggle-10")).toHaveTextContent("Production");
    expect(screen.getByTestId("group-toggle-ungrouped")).toHaveTextContent("1 workers · 0 selected");
    expect(screen.queryByTestId("row-worker-1")).toBeNull();
    expect(screen.queryByTestId("card-worker-1")).toBeNull();
    await user.click(screen.getByTestId("group-toggle-10"));
    expect(screen.getByTestId("row-worker-1")).toHaveTextContent("Ada Mensah");
    expect(screen.getByTestId("button-preview-payroll")).toBeDisabled();

    await user.click(screen.getByTestId("checkbox-worker-1"));
    await user.click(screen.getByTestId("button-preview-payroll"));

    expect(screen.getByText("Payroll Preview — 1 worker")).toBeInTheDocument();
    expect(screen.getByTestId("row-preview-1")).toHaveTextContent("Production");
    expect(screen.getByTestId("text-net-1")).toHaveTextContent("USD 1000.00");
    expect(screen.queryByTestId("row-worker-1")).toBeNull();
    expect(screen.getByTestId("button-save-draft")).toBeEnabled();

    await user.click(screen.getByTestId("button-back-to-select"));
    expect(screen.getByTestId("group-toggle-10")).toHaveTextContent("1 workers · 1 selected");
    expect(screen.queryByTestId("row-preview-1")).toBeNull();
  });

  it("shows the payroll history with its row actions and returns to worker selection", async () => {
    const user = userEvent.setup();
    render(<ERPRunPayroll />);

    expect(screen.getByTestId("tab-payroll-history")).toHaveTextContent("1 draft");
    await user.click(screen.getByTestId("tab-payroll-history"));
    expect(window.location.search).toContain("tab=history");

    const draft = screen.getByTestId("row-run-70");
    expect(draft).toHaveTextContent("August payroll");
    expect(draft).toHaveTextContent("Draft");
    expect(within(draft).getByTestId("button-pay-run-70")).toBeInTheDocument();
    expect(within(draft).getByTestId("button-delete-run-70")).toBeInTheDocument();
    const paid = screen.getByTestId("row-run-71");
    expect(paid).toHaveTextContent("Paid");
    expect(within(paid).getByTestId("button-undo-run-71")).toBeInTheDocument();
    expect(screen.queryByTestId("group-toggle-10")).toBeNull();

    await act(async () => {
      await user.click(screen.getByTestId("tab-run-payroll"));
    });
    expect(screen.getByTestId("group-toggle-10")).toBeInTheDocument();
    expect(screen.queryByTestId("row-run-70")).toBeNull();
  });
});
