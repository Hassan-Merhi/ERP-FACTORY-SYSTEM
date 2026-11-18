import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonFormSection } from "./PersonFormDialog";

export interface EmployeeFormValues {
  firstName: string;
  lastName: string;
  code?: string;
  department: string;
  phone: string;
  monthlySalary: string;
  joinDate?: string;
}

/**
 * Employee add/edit fields, laid out in the same sections as the worker form
 * (Identity, Contact, Employment). Fields missing from `values` are not shown,
 * so each caller keeps sending exactly the fields it sent before.
 */
export function EmployeeFormFields({
  values,
  onChange,
  testIdPrefix = "input",
}: {
  values: EmployeeFormValues;
  onChange: (key: keyof EmployeeFormValues, value: string) => void;
  /** "input" → `input-first-name`; "input-edit" → `input-edit-first-name`. */
  testIdPrefix?: string;
}) {
  const testId = (name: string) => `${testIdPrefix}-${name}`;
  return (
    <>
      <PersonFormSection title="Identity">
        <div className="space-y-1">
          <Label className="text-xs">First Name *</Label>
          <Input
            value={values.firstName}
            onChange={(e) => onChange("firstName", e.target.value)}
            placeholder="First name"
            data-testid={testId("first-name")}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Last Name *</Label>
          <Input
            value={values.lastName}
            onChange={(e) => onChange("lastName", e.target.value)}
            placeholder="Last name"
            data-testid={testId("last-name")}
          />
        </div>
        {values.code !== undefined && (
          <div className="space-y-1">
            <Label className="text-xs">Code (optional)</Label>
            <Input
              value={values.code}
              onChange={(e) => onChange("code", e.target.value)}
              placeholder="Auto-generated if blank"
              data-testid={testId("code")}
            />
          </div>
        )}
      </PersonFormSection>
      <PersonFormSection title="Contact">
        <div className="space-y-1">
          <Label className="text-xs">Phone</Label>
          <Input
            value={values.phone}
            onChange={(e) => onChange("phone", e.target.value)}
            placeholder="+1 234 567 8900"
            data-testid={testId("phone")}
          />
        </div>
      </PersonFormSection>
      <PersonFormSection title="Employment">
        <div className="space-y-1">
          <Label className="text-xs">Department</Label>
          <Input
            value={values.department}
            onChange={(e) => onChange("department", e.target.value)}
            placeholder="e.g. Operations"
            data-testid={testId("department")}
          />
        </div>
        {values.joinDate !== undefined && (
          <div className="space-y-1">
            <Label className="text-xs">Join Date *</Label>
            <Input
              type="date"
              value={values.joinDate}
              onChange={(e) => onChange("joinDate", e.target.value)}
              data-testid={testId("join-date")}
            />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Monthly Salary</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={values.monthlySalary}
            onChange={(e) => onChange("monthlySalary", e.target.value)}
            placeholder="0.00"
            data-testid={testId("monthly-salary")}
          />
        </div>
      </PersonFormSection>
    </>
  );
}
