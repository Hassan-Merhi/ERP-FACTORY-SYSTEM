// Extracted from ./EmployeeCrudDialogs.tsx
import type { usePayrollModel } from "./usePayrollModel";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/decimal-input";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/FormSubmitButton";

type PayrollModel = ReturnType<typeof usePayrollModel>;

export interface EmployeeCrudDialogsProps {
  createEmployeeDialogOpen: boolean;
  setCreateEmployeeDialogOpen: (open: boolean) => void;
  createEmployeeForm: PayrollModel["createEmployeeForm"];
  createEmployeeMutation: PayrollModel["createEmployeeMutation"];
  employeeGroups: PayrollModel["employeeGroups"];
  deleteConflict: PayrollModel["deleteConflict"];
  setDeleteConflict: PayrollModel["setDeleteConflict"];
  handleForceDeleteEmployee: () => void;
  createGroupDialogOpen: boolean;
  setCreateGroupDialogOpen: (open: boolean) => void;
  newGroupName: string;
  setNewGroupName: (v: string) => void;
  newGroupDescription: string;
  setNewGroupDescription: (v: string) => void;
  createGroupMutation: PayrollModel["createGroupMutation"];
  groupMembersDialogOpen: boolean;
  setGroupMembersDialogOpen: (open: boolean) => void;
  selectedGroupForMembers: PayrollModel["selectedGroupForMembers"];
  employeeStaff: PayrollModel["employeeStaff"];
  groupMembers: PayrollModel["groupMembers"];
  addWorkerToGroupMutation: PayrollModel["addWorkerToGroupMutation"];
  removeWorkerFromGroupMutation: PayrollModel["removeWorkerFromGroupMutation"];
}

export function EmployeeCrudDialogsForm({
  createEmployeeForm,
  createEmployeeMutation,
  employeeGroups,
  setCreateEmployeeDialogOpen,
}: Pick<
  EmployeeCrudDialogsProps,
  "createEmployeeForm" | "createEmployeeMutation" | "employeeGroups" | "setCreateEmployeeDialogOpen"
>) {
  return (
    <Form {...createEmployeeForm}>
      <form
        noValidate
        onSubmit={createEmployeeForm.handleSubmit((data) => createEmployeeMutation.mutate(data))}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={createEmployeeForm.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>First Name</FormLabel>
                <FormControl>
                  <Input placeholder="John" {...field} data-testid="input-first-name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={createEmployeeForm.control}
            name="lastName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Last Name</FormLabel>
                <FormControl>
                  <Input placeholder="Doe" {...field} data-testid="input-last-name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={createEmployeeForm.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Employee Code (Optional)</FormLabel>
              <FormControl>
                <Input placeholder="Auto-generated if left blank" {...field} data-testid="input-code" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={createEmployeeForm.control}
          name="monthlySalary"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Monthly Salary</FormLabel>
              <FormControl>
                <MoneyInput step="0.01" placeholder="0.00" {...field} data-testid="input-monthly-salary" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={createEmployeeForm.control}
          name="department"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Department (Optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g., Warehouse"
                  {...field}
                  value={field.value || ""}
                  data-testid="input-department"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={createEmployeeForm.control}
          name="joinDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Starting Date</FormLabel>
              <FormControl>
                <Input type="date" {...field} data-testid="input-join-date" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={createEmployeeForm.control}
          name="openingBalance"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Opening Balance (Optional)</FormLabel>
              <FormDescription>
                Positive = Credit (owed to employee). Negative = Debit (employee advance).
              </FormDescription>
              <FormControl>
                <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-opening-balance" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={createEmployeeForm.control}
          name="employeeGroupId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Employee Group (Optional)</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger data-testid="select-employee-group">
                    <SelectValue placeholder="Select a group" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none" data-testid="option-no-group">
                    No Group
                  </SelectItem>
                  {employeeGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id.toString()} data-testid={`option-group-${group.id}`}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm font-medium text-muted-foreground">Bonus Configuration (Optional)</p>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={createEmployeeForm.control}
              name="salesBonusPct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sales Bonus %</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.0001"
                      placeholder="e.g. 0.2"
                      {...field}
                      value={field.value || ""}
                      data-testid="input-sales-bonus-pct-create"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={createEmployeeForm.control}
              name="balesBonusRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bales Rate ($/unit)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 2.00"
                      {...field}
                      value={field.value || ""}
                      data-testid="input-bales-bonus-rate-create"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCreateEmployeeDialogOpen(false)}
            data-testid="button-cancel-create"
          >
            Cancel
          </Button>
          <FormSubmitButton
            type="submit"
            pending={createEmployeeMutation.isPending}
            pendingLabel="Creating…"
            data-testid="button-submit-create"
          >
            Create Employee
          </FormSubmitButton>
        </div>
      </form>
    </Form>
  );
}
