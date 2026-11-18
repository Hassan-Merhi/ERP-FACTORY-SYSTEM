import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/pages/payroll/EmployeesTab", () => ({ EmployeesTab: () => <div>Employees panel</div> }));
vi.mock("@/pages/payroll/WorkersTab", () => ({ WorkersTab: () => <div>Workers panel</div> }));
vi.mock("@/pages/payroll/AdvancesTab", () => ({ AdvancesTab: () => <div>Advances panel</div> }));
vi.mock("@/components/ERPRunPayroll", () => ({ default: () => <div>Run payroll panel</div> }));
vi.mock("@/pages/payroll/DepositDialog", () => ({ DepositDialog: () => null }));
vi.mock("@/pages/payroll/WithdrawalDialog", () => ({ WithdrawalDialog: () => null }));
vi.mock("@/pages/payroll/BulkPaymentDialog", () => ({ BulkPaymentDialog: () => null }));
vi.mock("@/pages/payroll/WorkerDialogs", () => ({ WorkerDialogs: () => null }));
vi.mock("@/pages/payroll/BonusDialog", () => ({ BonusDialog: () => null }));
vi.mock("@/pages/payroll/EmployeeCrudDialogs", () => ({ EmployeeCrudDialogs: () => null }));
vi.mock("@/pages/payroll/BulkDialogs", () => ({ BulkDialogs: () => null }));
vi.mock("@/pages/payroll/EmployeeStatementDialog", () => ({ EmployeeStatementDialog: () => null }));
vi.mock("@/pages/payroll/EditEmployeeDialog", () => ({ EditEmployeeDialog: () => null }));
vi.mock("@/pages/payroll/PayrollDialogs", () => ({ WorkerDeductionDialog: () => null }));

import { PayrollView } from "@/pages/payroll/PayrollView";
import { usePayrollAdvancesTab, usePayrollRunTab, usePayrollSection } from "@/pages/payroll/payrollTabs";

// PayrollView only forwards the model to the (mocked) tabs and dialogs.
const model = new Proxy({}, { get: () => undefined }) as never;

describe("ERP payroll tabs in the URL", () => {
  beforeEach(() => window.history.replaceState({}, "", "/payroll"));

  it("opens the first tab for a link without ?section and records it", async () => {
    render(<PayrollView model={model} />);
    expect(screen.getByText("Employees panel")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?section=employees"));
  });

  it("opens the tab a link names and keeps it on refresh", () => {
    window.history.replaceState({}, "", "/payroll?section=run-payroll");
    render(<PayrollView model={model} />);
    expect(screen.getByText("Run payroll panel")).toBeInTheDocument();
    expect(screen.queryByText("Employees panel")).not.toBeInTheDocument();
  });

  it("falls back to the first tab for an unknown section", async () => {
    window.history.replaceState({}, "", "/payroll?section=retired");
    render(<PayrollView model={model} />);
    expect(screen.getByText("Employees panel")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?section=employees"));
  });

  it("writes the clicked tab to ?section and drops the old sub-tab", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/payroll?section=run-payroll&tab=history");
    render(<PayrollView model={model} />);
    await user.click(screen.getByRole("tab", { name: "Advances + Deductions" }));
    expect(screen.getByText("Advances panel")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/payroll");
    expect(window.location.search).toBe("?section=advances");
  });
});

function SubTabs() {
  const [section, setSection] = usePayrollSection();
  return (
    <div>
      <button onClick={() => setSection("run-payroll")}>Go run</button>
      {section === "advances" && <AdvancesSubTab />}
      {section === "run-payroll" && <RunSubTab />}
    </div>
  );
}
function AdvancesSubTab() {
  const [tab] = usePayrollAdvancesTab();
  return <div data-testid="advances-tab">{tab}</div>;
}
function RunSubTab() {
  const [tab, setTab] = usePayrollRunTab();
  return (
    <div>
      <div data-testid="run-tab">{tab}</div>
      <button onClick={() => setTab("history")}>History</button>
    </div>
  );
}

describe("ERP payroll sub-tabs in ?tab", () => {
  beforeEach(() => window.history.replaceState({}, "", "/payroll"));

  it("opens the Advances sub-tab a link names", () => {
    window.history.replaceState({}, "", "/payroll?section=advances&tab=repayments");
    render(<SubTabs />);
    expect(screen.getByTestId("advances-tab")).toHaveTextContent("repayments");
  });

  it("opens the first sub-tab when ?tab is missing or belongs to another section", async () => {
    window.history.replaceState({}, "", "/payroll?section=advances&tab=history");
    render(<SubTabs />);
    expect(screen.getByTestId("advances-tab")).toHaveTextContent("advances");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("advances"));
  });

  it("switches section, then records the Run / History sub-tab", async () => {
    window.history.replaceState({}, "", "/payroll?section=advances&tab=repayments");
    render(<SubTabs />);
    act(() => screen.getByText("Go run").click());
    expect(screen.getByTestId("run-tab")).toHaveTextContent("run");
    act(() => screen.getByText("History").click());
    expect(screen.getByTestId("run-tab")).toHaveTextContent("history");
    expect(window.location.search).toBe("?section=run-payroll&tab=history");
  });
});
