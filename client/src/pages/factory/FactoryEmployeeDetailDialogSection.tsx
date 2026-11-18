// Extracted from ./FactoryEmployeeDetail.tsx to keep that module under the source-size cap.
import { Building, CreditCard, Phone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import { PersonInfoCard, PersonInfoRow } from "@/pages/factory/people/PersonDetailParts";
import { PersonAttendancePanel } from "@/pages/factory/people/PersonAttendancePanel";
import { EmployeeAdvancesCard } from "@/pages/factory/people/EmployeeAdvancesCard";
import { PersonFormDialog } from "@/pages/factory/people/PersonFormDialog";
import { EmployeeFormFields } from "@/pages/factory/people/EmployeeFormFields";
import { fmt, type Employee, type EmployeeDetailTab } from "./FactoryEmployeeDetailTypes";
import { useFactoryEmployeeDetailState } from "./useFactoryEmployeeDetailState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export function FactoryEmployeeDetailSection({
  activeTab,
  employee,
  exportBusy,
  exportStatement,
  formatDate,
  fullName,
  refetchStatement,
  setRequestedTab,
  showAdvancesTab,
  showAttendanceTab,
  statement,
  statementRows,
  stmtError,
  stmtLoading,
}: Pick<
  ReturnType<typeof useFactoryEmployeeDetailState>,
  | "activeTab"
  | "exportBusy"
  | "exportStatement"
  | "formatDate"
  | "refetchStatement"
  | "setRequestedTab"
  | "showAdvancesTab"
  | "showAttendanceTab"
  | "statement"
  | "statementRows"
  | "stmtError"
  | "stmtLoading"
> & { employee: Employee; fullName: string }) {
  return (
    <div className="flex-1 min-w-0">
      <Tabs value={activeTab} onValueChange={(value) => setRequestedTab(value as EmployeeDetailTab)}>
        <div className="erp-mobile-scroll-tabs mb-4 pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory employee details">
            <TabsTrigger value="profile" data-testid="tab-profile">
              Profile
            </TabsTrigger>
            <TabsTrigger value="statement" data-testid="tab-statement">
              Statement
            </TabsTrigger>
            {showAdvancesTab && (
              <TabsTrigger value="advances" data-testid="tab-advances">
                Advances
              </TabsTrigger>
            )}
            {showAttendanceTab && (
              <TabsTrigger value="attendance" data-testid="tab-attendance">
                Attendance
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="profile" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PersonInfoCard title="Personal">
              <PersonInfoRow label="First Name" value={employee.firstName} testId="text-detail-first-name" />
              <PersonInfoRow label="Last Name" value={employee.lastName} testId="text-detail-last-name" />
            </PersonInfoCard>
            <PersonInfoCard title="Contact" icon={Phone}>
              <PersonInfoRow label="Phone" value={employee.phone} testId="text-detail-phone" />
            </PersonInfoCard>
            <PersonInfoCard title="Employment" icon={Building}>
              <PersonInfoRow label="Employee Code" value={employee.code} testId="text-detail-code" />
              <PersonInfoRow label="Department" value={employee.department} testId="text-detail-department" />
              <PersonInfoRow label="Date Joined" value={formatDate(employee.joinDate)} testId="text-detail-joined" />
            </PersonInfoCard>
            <PersonInfoCard title="Compensation" icon={CreditCard}>
              <PersonInfoRow label="Monthly Salary" value={fmt(employee.monthlySalary)} testId="text-detail-salary" />
              <PersonInfoRow label="Current Balance" value={fmt(employee.currentBalance)} />
              <PersonInfoRow label="Total Deposits" value={fmt(employee.totalDeposits)} />
              <PersonInfoRow label="Total Withdrawals" value={fmt(employee.totalWithdrawals)} />
            </PersonInfoCard>
          </div>
        </TabsContent>

        <TabsContent value="statement" className="space-y-4">
          <div className="flex justify-end">
            <ReportExportMenu
              busy={exportBusy}
              disabled={!statementRows.length}
              data-testid="button-statement-export"
              options={[
                { id: "excel", label: "Excel", kind: "excel", onSelect: () => exportStatement("excel") },
                { id: "pdf", label: "PDF", kind: "pdf", onSelect: () => exportStatement("pdf") },
                { id: "print", label: "Print", kind: "print", onSelect: () => exportStatement("print") },
              ]}
            />
          </div>
          <Card>
            <CardHeader className="pb-2 pt-4 px-5">
              <CardTitle className="text-sm text-muted-foreground">Running Statement</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-4 overflow-x-auto">
              {stmtLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : stmtError && !statement ? (
                <ErrorState onAction={() => void refetchStatement()} actionLabel="Try again" />
              ) : statementRows.length === 0 ? (
                <EmptyState title="No transactions yet" />
              ) : (
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Voucher</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Deposit</TableHead>
                      <TableHead className="text-right">Withdrawal</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statementRows.map((row) => (
                      <TableRow key={row.id} data-testid={`row-stmt-${row.id}`}>
                        <TableCell className="text-sm">{formatDate(row.voucherDate)}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{row.voucherNumber}</TableCell>
                        <TableCell className="text-sm" dir="ltr">
                          {row.narration || row.description || "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {row.credit > 0 ? (
                            <span className="text-green-600 dark:text-green-400">{fmt(row.credit)}</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {row.debit > 0 ? (
                            <span className="text-red-600 dark:text-red-400">{fmt(row.debit)}</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono text-sm font-semibold tabular-nums ${row.balance < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                        >
                          {fmt(row.balance)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {showAdvancesTab && (
          <TabsContent value="advances" className="space-y-4">
            <EmployeeAdvancesCard employeeId={employee.id} formatDate={formatDate} formatAmount={fmt} />
          </TabsContent>
        )}

        {showAttendanceTab && (
          <TabsContent value="attendance" className="space-y-4">
            <PersonAttendancePanel
              endpoint={`/api/factory/employee-attendance/employee/${employee.id}`}
              personName={fullName}
              kind="employee"
              formatDate={formatDate}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export function FactoryEmployeeDetailDialogSection({
  editForm,
  editOpen,
  setEditForm,
  setEditOpen,
  updateMutation,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof useFactoryEmployeeDetailState>,
  "editForm" | "editOpen" | "setEditForm" | "setEditOpen" | "updateMutation" | "wrapAdminAction"
>) {
  return (
    <PersonFormDialog
      open={editOpen}
      onOpenChange={setEditOpen}
      title="Edit Employee"
      description="Update employee details"
      onSave={() => wrapAdminAction(() => updateMutation.mutate(editForm), "Save Employee")}
      saving={updateMutation.isPending}
      testIds={{ dialog: "dialog-edit-employee", cancel: "button-cancel-edit", save: "button-save-edit" }}
    >
      <EmployeeFormFields
        values={editForm}
        onChange={(key, value) => setEditForm((form) => ({ ...form, [key]: value }))}
        testIdPrefix="input-edit"
      />
    </PersonFormDialog>
  );
}
