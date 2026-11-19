import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PeopleFilterChips,
  PeopleKpiCards,
  PeopleRosterToolbar,
  PeopleRowActions,
  PersonNameCell,
  PersonStatusBadge,
  matchesPeopleStatus,
} from "./PeopleRoster";
import { PersonFormDialog, PersonFormSection } from "./PersonFormDialog";
import { EmployeeFormFields } from "./EmployeeFormFields";
import { peopleExportCellText, peopleTablePrintHtml } from "./peopleExport";
import { Users } from "lucide-react";

describe("shared Factory people roster pieces", () => {
  it("filters status the same way for workers and employees", () => {
    expect(matchesPeopleStatus("All", false)).toBe(true);
    expect(matchesPeopleStatus("Active", true)).toBe(true);
    expect(matchesPeopleStatus("Active", false)).toBe(false);
    expect(matchesPeopleStatus("Inactive", false)).toBe(true);
  });

  it("renders the toolbar with search, Add button and Export menu, and hides Add without permission", () => {
    const onAdd = vi.fn();
    const onSearch = vi.fn();
    const { rerender } = render(
      <PeopleRosterToolbar
        searchPlaceholder="Search"
        search=""
        onSearchChange={onSearch}
        status="Active"
        onStatusChange={vi.fn()}
        exportOptions={[{ id: "excel", label: "Excel", kind: "excel", onSelect: vi.fn() }]}
        addLabel="Add Employee"
        onAdd={onAdd}
        searchTestId="search"
        statusTestId="status"
        addTestId="add"
      />
    );
    fireEvent.change(screen.getByTestId("search"), { target: { value: "ali" } });
    expect(onSearch).toHaveBeenCalledWith("ali");
    fireEvent.click(screen.getByTestId("add"));
    expect(onAdd).toHaveBeenCalled();
    expect(screen.getByTestId("add")).toHaveTextContent("Add Employee");
    expect(screen.getByTestId("button-people-export")).toHaveTextContent("Export");

    rerender(
      <PeopleRosterToolbar
        searchPlaceholder="Search"
        search=""
        onSearchChange={onSearch}
        status="Active"
        onStatusChange={vi.fn()}
        exportOptions={[]}
        addLabel="Add Employee"
        searchTestId="search"
        statusTestId="status"
        addTestId="add"
      />
    );
    expect(screen.queryByTestId("add")).toBeNull();
    expect(screen.getByTestId("button-people-export")).toBeDisabled();
  });

  it("shows code, name, status and the matching row action", () => {
    const onEnd = vi.fn();
    const onReactivate = vi.fn();
    const ids = { edit: "edit", end: "end", reactivate: "reactivate" };
    const { rerender } = render(
      <div>
        <PersonNameCell name="Sara Haddad" code="EMP004" testIdSuffix="e4" />
        <PersonStatusBadge active data-testid="status" />
        <PeopleRowActions
          active
          onEdit={vi.fn()}
          onEndContract={onEnd}
          onReactivate={onReactivate}
          testIdSuffix={ids}
        />
      </div>
    );
    expect(screen.getByTestId("text-code-e4")).toHaveTextContent("EMP004");
    expect(screen.getByTestId("text-name-e4")).toHaveTextContent("Sara Haddad");
    expect(screen.getByTestId("status")).toHaveTextContent("Active");
    fireEvent.click(screen.getByTestId("end"));
    expect(onEnd).toHaveBeenCalled();
    expect(screen.queryByTestId("reactivate")).toBeNull();

    rerender(
      <div>
        <PersonStatusBadge active={false} data-testid="status" />
        <PeopleRowActions
          active={false}
          onEdit={vi.fn()}
          onEndContract={onEnd}
          onReactivate={onReactivate}
          testIdSuffix={ids}
        />
      </div>
    );
    expect(screen.getByTestId("status")).toHaveTextContent("Inactive");
    fireEvent.click(screen.getByTestId("reactivate"));
    expect(onReactivate).toHaveBeenCalled();
  });

  it("lists active filters as removable chips with the result count", () => {
    const onRemove = vi.fn();
    render(<PeopleFilterChips chips={[{ key: "d", label: "Department", value: "Sales", onRemove }]} resultCount={1} />);
    expect(screen.getByTestId("people-filter-chips")).toHaveTextContent("Department: Sales");
    expect(screen.getByTestId("people-filter-chips")).toHaveTextContent("1 result");
    fireEvent.click(screen.getByLabelText("Remove filter"));
    expect(onRemove).toHaveBeenCalled();
  });

  it("renders KPI cards, or skeletons while loading", () => {
    const { rerender } = render(
      <PeopleKpiCards cards={[{ label: "Monthly Payroll", value: "$1,200", icon: Users }]} data-testid="kpis" />
    );
    expect(screen.getByTestId("people-kpi-monthly-payroll")).toHaveTextContent("$1,200");
    rerender(<PeopleKpiCards loading cards={[{ label: "Total", value: "3", icon: Users }]} data-testid="kpis" />);
    expect(screen.queryByTestId("people-kpi-total")).toBeNull();
  });
});

describe("shared person form dialog", () => {
  it("lays employee fields out in sections and saves through the page handler", () => {
    const onSave = vi.fn();
    const onChange = vi.fn();
    render(
      <PersonFormDialog
        open
        onOpenChange={vi.fn()}
        title="Add Employee"
        description="Fill in the employee details below"
        onSave={onSave}
        saving={false}
        testIds={{ dialog: "dialog", cancel: "cancel", save: "save" }}
      >
        <EmployeeFormFields
          values={{ firstName: "", lastName: "", code: "", department: "", phone: "", monthlySalary: "", joinDate: "" }}
          onChange={onChange}
        />
      </PersonFormDialog>
    );
    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByText("Employment")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("input-first-name"), { target: { value: "Omar" } });
    expect(onChange).toHaveBeenCalledWith("firstName", "Omar");
    expect(screen.getByTestId("save")).toHaveTextContent("Save");
    fireEvent.click(screen.getByTestId("save"));
    expect(onSave).toHaveBeenCalled();
  });

  it("hides fields the caller does not send and shows Saving… while busy", () => {
    render(
      <PersonFormDialog
        open
        onOpenChange={vi.fn()}
        title="Edit Employee"
        description="Update employee details"
        onSave={vi.fn()}
        saving
        testIds={{ dialog: "dialog", cancel: "cancel", save: "save" }}
      >
        <PersonFormSection title="Extra">
          <span>child</span>
        </PersonFormSection>
        <EmployeeFormFields
          values={{ firstName: "A", lastName: "B", department: "", phone: "", monthlySalary: "" }}
          onChange={vi.fn()}
          testIdPrefix="input-edit"
        />
      </PersonFormDialog>
    );
    expect(screen.queryByTestId("input-edit-code")).toBeNull();
    expect(screen.queryByTestId("input-edit-join-date")).toBeNull();
    expect(screen.getByTestId("save")).toHaveTextContent("Saving…");
    expect(screen.getByTestId("save")).toBeDisabled();
  });
});

describe("people export layout", () => {
  it("formats money cells and builds an escaped print table with totals", () => {
    expect(peopleExportCellText(1234.5, "money")).toContain("1,234.50");
    expect(peopleExportCellText(null, "money")).toBe("");
    const html = peopleTablePrintHtml({
      title: "Factory Employees",
      fileStem: "factory employees",
      columns: [
        { header: "Name", value: (row: { name: string; salary: number }) => row.name },
        { header: "Salary", type: "money", value: (row: { name: string; salary: number }) => row.salary },
      ],
      rows: [{ name: "<Ali>", salary: 500 }],
      footer: ["TOTAL", 500],
      period: { from: "2026-11-01", to: "2026-11-30" },
    });
    expect(html).toContain("&lt;Ali&gt;");
    expect(html).toContain("<tfoot>");
    expect(html).toContain("2026-11-01 – 2026-11-30");
  });
});
