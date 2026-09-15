import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { BadgeDollarSign, BriefcaseBusiness, MapPin, Plus, Save, UserRound, X } from "lucide-react";

interface EditEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setEditingEmployee: PayrollModel["setEditingEmployee"];
  editEmployeeForm: PayrollModel["editEmployeeForm"];
  editEmployeeMutation: PayrollModel["editEmployeeMutation"];
  employeeGroups: PayrollModel["employeeGroups"];
  otherCompanies: PayrollModel["otherCompanies"];
  selectedCompany: PayrollModel["selectedCompany"];
  locations: PayrollModel["locations"];
  allCompanyLocations: PayrollModel["allCompanyLocations"];
  editBaleRates: PayrollModel["editBaleRates"];
  setEditBaleRates: PayrollModel["setEditBaleRates"];
  editBalePctRates: PayrollModel["editBalePctRates"];
  setEditBalePctRates: PayrollModel["setEditBalePctRates"];
  pctLocations: PayrollModel["allCompanyLocations"];
}

function SectionTitle({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof UserRound;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

export function EditEmployeeDialog({
  open,
  onOpenChange,
  setEditingEmployee,
  editEmployeeForm,
  editEmployeeMutation,
  employeeGroups,
  otherCompanies,
  selectedCompany,
  locations,
  allCompanyLocations,
  editBaleRates,
  setEditBaleRates,
  editBalePctRates,
  setEditBalePctRates,
  pctLocations,
}: EditEmployeeDialogProps) {
  const closeDialog = () => {
    onOpenChange(false);
    setEditingEmployee(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        onOpenChange(isOpen);
        if (!isOpen) setEditingEmployee(null);
      }}
    >
      <DialogContent
        className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-5xl gap-0 overflow-hidden p-0 sm:rounded-2xl"
        data-testid="dialog-edit-employee"
      >
        <DialogHeader className="border-b bg-muted/20 px-6 py-5 pr-14 text-left">
          <DialogTitle className="text-xl font-semibold tracking-tight">Edit Employee</DialogTitle>
          <DialogDescription>
            Update employee information, payroll settings, status, and location-based bonus rules.
          </DialogDescription>
        </DialogHeader>

        <Form {...editEmployeeForm}>
          <form
            noValidate
            onSubmit={editEmployeeForm.handleSubmit((data) => editEmployeeMutation.mutate(data))}
            className="flex max-h-[calc(92vh-94px)] flex-col"
          >
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              <section className="rounded-xl border bg-card p-5 shadow-sm">
                <SectionTitle
                  icon={UserRound}
                  title="Employee details"
                  description="Basic identity and payroll information used across the ERP."
                />

                <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <FormField
                    control={editEmployeeForm.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem className="xl:col-span-2">
                        <FormLabel>First Name</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10" data-testid="input-edit-first-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editEmployeeForm.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem className="xl:col-span-2">
                        <FormLabel>Last Name</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10" data-testid="input-edit-last-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editEmployeeForm.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Employee Code</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ""} className="h-10" data-testid="input-edit-code" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editEmployeeForm.control}
                    name="monthlySalary"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Monthly Salary</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            {...field}
                            className="h-10"
                            data-testid="input-edit-monthly-salary"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editEmployeeForm.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Department</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="e.g. Warehouse"
                            {...field}
                            value={field.value || ""}
                            className="h-10"
                            data-testid="input-edit-department"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editEmployeeForm.control}
                    name="joinDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Starting Date</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            {...field}
                            value={field.value || ""}
                            className="h-10"
                            data-testid="input-edit-join-date"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>

              <section className="rounded-xl border bg-card p-5 shadow-sm">
                <SectionTitle
                  icon={BriefcaseBusiness}
                  title="Employment settings"
                  description="Control payroll availability and employee grouping."
                />

                <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <FormField
                    control={editEmployeeForm.control}
                    name="active"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Status</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === "true")}
                          value={field.value === undefined ? undefined : field.value ? "true" : "false"}
                        >
                          <FormControl>
                            <SelectTrigger className="h-10" data-testid="select-edit-active">
                              <SelectValue placeholder="Select status" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="true">Active</SelectItem>
                            <SelectItem value="false">Inactive</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editEmployeeForm.control}
                    name="employeeGroupId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Employee Group</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || "none"}>
                          <FormControl>
                            <SelectTrigger className="h-10" data-testid="select-edit-employee-group">
                              <SelectValue placeholder="No Group" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">No Group</SelectItem>
                            {employeeGroups.map((group) => (
                              <SelectItem key={group.id} value={group.id.toString()}>
                                {group.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>

              <section className="rounded-xl border bg-card p-5 shadow-sm">
                <SectionTitle
                  icon={BadgeDollarSign}
                  title="Sales bonus"
                  description="Optional percentage bonus based on sales from a selected company and location."
                />

                <div className="mt-5">
                  <FormField
                    control={editEmployeeForm.control}
                    name="salesBonusPct"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sales Bonus %</FormLabel>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr_1fr]">
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              step="0.0001"
                              placeholder="e.g. 0.2"
                              {...field}
                              value={field.value || ""}
                              className="h-10"
                              data-testid="input-edit-sales-bonus-pct"
                            />
                          </FormControl>

                          {otherCompanies.length > 0 ? (
                            <FormField
                              control={editEmployeeForm.control}
                              name="salesBonusPctSourceCompanyId"
                              render={({ field: sourceCompanyField }) => (
                                <Select
                                  value={sourceCompanyField.value || "__current__"}
                                  onValueChange={(value) => {
                                    sourceCompanyField.onChange(value === "__current__" ? "" : value);
                                    editEmployeeForm.setValue("salesBonusPctLocationId", "");
                                  }}
                                >
                                  <SelectTrigger className="h-10" data-testid="select-edit-bonus-pct-source-company">
                                    <SelectValue placeholder={selectedCompany?.name || "This company"} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__current__">{selectedCompany?.name || "This company"}</SelectItem>
                                    {otherCompanies.map((company) => (
                                      <SelectItem key={company.id} value={String(company.id)}>
                                        {company.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            />
                          ) : (
                            <div className="flex h-10 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                              {selectedCompany?.name || "This company"}
                            </div>
                          )}

                          <FormField
                            control={editEmployeeForm.control}
                            name="salesBonusPctLocationId"
                            render={({ field: locationField }) => (
                              <Select value={locationField.value || ""} onValueChange={locationField.onChange}>
                                <SelectTrigger className="h-10" data-testid="select-edit-bonus-pct-location">
                                  <SelectValue placeholder="Select location" />
                                </SelectTrigger>
                                <SelectContent>
                                  {pctLocations.map((location) => (
                                    <SelectItem key={location.id} value={String(location.id)}>
                                      {location.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>

              <section className="rounded-xl border bg-card p-5 shadow-sm">
                <SectionTitle
                  icon={MapPin}
                  title="Location bonus rules"
                  description="Set fixed bale rates and percentage rates independently for each location."
                />

                <div className="mt-5 grid gap-5 xl:grid-cols-2">
                  <div className="rounded-lg border bg-muted/15 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <Label className="text-sm font-semibold">Bale Bonus Rates</Label>
                        <p className="mt-0.5 text-xs text-muted-foreground">Fixed amount per bale.</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditBaleRates((previous) => [
                            ...previous,
                            { locationId: "", rate: "", sourceCompanyId: "" },
                          ])
                        }
                        data-testid="button-add-bale-rate"
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Location
                      </Button>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {editBaleRates.length === 0 && (
                        <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                          No fixed bale rates configured.
                        </div>
                      )}
                      {editBaleRates.map((row, index) => {
                        const rowCompanyId = row.sourceCompanyId || "";
                        const locationsForRow = rowCompanyId
                          ? allCompanyLocations.filter((location) => String(location.companyId) === rowCompanyId)
                          : locations;

                        return (
                          <div
                            key={`${rowCompanyId}-${row.locationId}-${index}`}
                            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_100px_36px] gap-2"
                          >
                            {otherCompanies.length > 0 ? (
                              <Select
                                value={rowCompanyId || "__current__"}
                                onValueChange={(value) =>
                                  setEditBaleRates((previous) =>
                                    previous.map((rateRow, rateIndex) =>
                                      rateIndex === index
                                        ? {
                                            ...rateRow,
                                            sourceCompanyId: value === "__current__" ? "" : value,
                                            locationId: "",
                                          }
                                        : rateRow
                                    )
                                  )
                                }
                              >
                                <SelectTrigger className="h-9 min-w-0 text-xs" data-testid={`select-bale-rate-company-${index}`}>
                                  <SelectValue placeholder={selectedCompany?.name || "Company"} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__current__">{selectedCompany?.name || "This company"}</SelectItem>
                                  {otherCompanies.map((company) => (
                                    <SelectItem key={company.id} value={String(company.id)}>
                                      {company.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <div className="flex h-9 min-w-0 items-center truncate rounded-md border bg-background px-3 text-xs text-muted-foreground">
                                {selectedCompany?.name || "Company"}
                              </div>
                            )}

                            <Select
                              value={row.locationId}
                              onValueChange={(value) =>
                                setEditBaleRates((previous) =>
                                  previous.map((rateRow, rateIndex) =>
                                    rateIndex === index ? { ...rateRow, locationId: value } : rateRow
                                  )
                                )
                              }
                            >
                              <SelectTrigger className="h-9 min-w-0" data-testid={`select-bale-rate-location-${index}`}>
                                <SelectValue placeholder="Location" />
                              </SelectTrigger>
                              <SelectContent>
                                {locationsForRow.map((location) => (
                                  <SelectItem key={location.id} value={String(location.id)}>
                                    {location.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>

                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="Rate"
                              className="h-9 text-right"
                              value={row.rate}
                              onChange={(event) =>
                                setEditBaleRates((previous) =>
                                  previous.map((rateRow, rateIndex) =>
                                    rateIndex === index ? { ...rateRow, rate: event.target.value } : rateRow
                                  )
                                )
                              }
                              data-testid={`input-bale-rate-${index}`}
                            />

                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 text-muted-foreground hover:text-destructive"
                              onClick={() =>
                                setEditBaleRates((previous) => previous.filter((_, rateIndex) => rateIndex !== index))
                              }
                              aria-label="Remove bale rate"
                              data-testid={`button-remove-bale-rate-${index}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-lg border bg-muted/15 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <Label className="text-sm font-semibold">Bales % by Location</Label>
                        <p className="mt-0.5 text-xs text-muted-foreground">Percentage-based bale bonus.</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditBalePctRates((previous) => [
                            ...previous,
                            { locationId: "", pct: "", sourceCompanyId: "" },
                          ])
                        }
                        data-testid="button-add-bale-pct-rate"
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Location
                      </Button>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {editBalePctRates.length === 0 && (
                        <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                          No percentage bale rates configured.
                        </div>
                      )}
                      {editBalePctRates.map((row, index) => {
                        const rowCompanyId = row.sourceCompanyId || "";
                        const locationsForRow = rowCompanyId
                          ? allCompanyLocations.filter((location) => String(location.companyId) === rowCompanyId)
                          : locations;

                        return (
                          <div
                            key={`${rowCompanyId}-${row.locationId}-${index}`}
                            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_100px_36px] gap-2"
                          >
                            {otherCompanies.length > 0 ? (
                              <Select
                                value={rowCompanyId || "__current__"}
                                onValueChange={(value) =>
                                  setEditBalePctRates((previous) =>
                                    previous.map((rateRow, rateIndex) =>
                                      rateIndex === index
                                        ? {
                                            ...rateRow,
                                            sourceCompanyId: value === "__current__" ? "" : value,
                                            locationId: "",
                                          }
                                        : rateRow
                                    )
                                  )
                                }
                              >
                                <SelectTrigger className="h-9 min-w-0 text-xs" data-testid={`select-bale-pct-rate-company-${index}`}>
                                  <SelectValue placeholder={selectedCompany?.name || "Company"} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__current__">{selectedCompany?.name || "This company"}</SelectItem>
                                  {otherCompanies.map((company) => (
                                    <SelectItem key={company.id} value={String(company.id)}>
                                      {company.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <div className="flex h-9 min-w-0 items-center truncate rounded-md border bg-background px-3 text-xs text-muted-foreground">
                                {selectedCompany?.name || "Company"}
                              </div>
                            )}

                            <Select
                              value={row.locationId}
                              onValueChange={(value) =>
                                setEditBalePctRates((previous) =>
                                  previous.map((rateRow, rateIndex) =>
                                    rateIndex === index ? { ...rateRow, locationId: value } : rateRow
                                  )
                                )
                              }
                            >
                              <SelectTrigger className="h-9 min-w-0" data-testid={`select-bale-pct-rate-location-${index}`}>
                                <SelectValue placeholder="Location" />
                              </SelectTrigger>
                              <SelectContent>
                                {locationsForRow.map((location) => (
                                  <SelectItem key={location.id} value={String(location.id)}>
                                    {location.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>

                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="%"
                              className="h-9 text-right"
                              value={row.pct}
                              onChange={(event) =>
                                setEditBalePctRates((previous) =>
                                  previous.map((rateRow, rateIndex) =>
                                    rateIndex === index ? { ...rateRow, pct: event.target.value } : rateRow
                                  )
                                )
                              }
                              data-testid={`input-bale-pct-rate-${index}`}
                            />

                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 text-muted-foreground hover:text-destructive"
                              onClick={() =>
                                setEditBalePctRates((previous) => previous.filter((_, rateIndex) => rateIndex !== index))
                              }
                              aria-label="Remove percentage bale rate"
                              data-testid={`button-remove-bale-pct-rate-${index}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background/95 px-6 py-4 backdrop-blur">
              <p className="hidden text-xs text-muted-foreground sm:block">Changes are saved to this employee only.</p>
              <div className="ml-auto flex items-center gap-2">
                <Button type="button" variant="outline" onClick={closeDialog} disabled={editEmployeeMutation.isPending}>
                  Cancel
                </Button>
                <Button type="submit" disabled={editEmployeeMutation.isPending} data-testid="button-save-employee">
                  <Save className="mr-2 h-4 w-4" />
                  {editEmployeeMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
