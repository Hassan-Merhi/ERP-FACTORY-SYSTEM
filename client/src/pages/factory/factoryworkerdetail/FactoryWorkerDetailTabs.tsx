// Extracted from ./FactoryWorkerDetailView.tsx
import { DollarSign, CreditCard, Building, Phone, Banknote, Wrench, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PAYROLL_STATUS, fmt, fmtNum } from "./utils";
import { FactoryWorkerAdvancesPanel } from "./FactoryWorkerAdvancesPanel";
import { FactoryWorkerDocumentsBalesPanel } from "./FactoryWorkerDocumentsBalesPanel";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import { PersonAttendancePanel } from "../people/PersonAttendancePanel";
import { PersonInfoCard } from "../people/PersonDetailParts";
import { type WorkerDetailTab } from "./useFactoryWorkerDetailViewTabs";
import type { useFactoryWorkerDetailViewTabs } from "./useFactoryWorkerDetailViewTabs";
import type { FactoryWorkerDetailModelProps } from "./FactoryWorkerDetailView";

export function FactoryWorkerDetailTabs({
  model,
  tabs,
  infoRow,
  worker,
}: {
  model: FactoryWorkerDetailModelProps["model"];
  tabs: ReturnType<typeof useFactoryWorkerDetailViewTabs>;
  infoRow: (label: string, value: string | number | null | undefined, testId?: string) => React.ReactNode;
  worker: NonNullable<FactoryWorkerDetailModelProps["model"]["worker"]>;
}) {
  return (
    <div className="flex-1 min-w-0">
      {tabs.activeDetailTab ? (
        <Tabs
          value={tabs.activeDetailTab}
          onValueChange={(value) => tabs.setRequestedDetailTab(value as WorkerDetailTab)}
        >
          <div className="erp-mobile-scroll-tabs mb-4 pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory worker details">
              {model.showProfile && (
                <TabsTrigger value="profile" data-testid="tab-profile">
                  Profile
                </TabsTrigger>
              )}
              {model.showStatement && (
                <TabsTrigger value="statement" data-testid="tab-statement">
                  Statement
                </TabsTrigger>
              )}
              {model.showAdvances && (
                <TabsTrigger value="advances" data-testid="tab-advances">
                  Advances
                </TabsTrigger>
              )}
              {model.showAttendance && (
                <TabsTrigger value="attendance" data-testid="tab-attendance">
                  Attendance
                </TabsTrigger>
              )}
              {model.showBales && (
                <TabsTrigger value="bales" data-testid="tab-bales">
                  Bales
                </TabsTrigger>
              )}
              {model.showDocuments && (
                <TabsTrigger value="documents" data-testid="tab-documents">
                  Documents
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {model.showProfile && (
            <TabsContent value="profile" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <PersonInfoCard title="Personal">
                  {infoRow("Full Name", worker.fullName, "text-detail-fullname")}
                  {infoRow("Father Name", worker.fatherName, "text-detail-father")}
                  {infoRow("Mother Name", worker.motherName, "text-detail-mother")}
                  {infoRow("National ID", worker.nationalId, "text-detail-nationalid")}
                  {infoRow("Passport", worker.passportNumber, "text-detail-passport")}
                  {infoRow("Date of Birth", model.formatDate(worker.dateOfBirth), "text-detail-dob")}
                  {infoRow("Gender", worker.gender, "text-detail-gender")}
                  {infoRow("Nationality", worker.nationality, "text-detail-nationality")}
                  {infoRow("Marital Status", worker.maritalStatus, "text-detail-marital")}
                  {infoRow("Children", worker.numberOfChildren ?? "—", "text-detail-children")}
                </PersonInfoCard>

                <PersonInfoCard title="Contact" icon={Phone}>
                  {infoRow("Phone 1", worker.phone1, "text-detail-phone1")}
                  {infoRow("Phone 2", worker.phone2, "text-detail-phone2")}
                  {infoRow("Emergency Name", worker.emergencyContactName, "text-detail-emergency")}
                  {infoRow("Emergency Phone", worker.emergencyContactPhone)}
                  {infoRow("Address", worker.address, "text-detail-address")}
                  {infoRow("City", worker.city, "text-detail-city")}
                  {infoRow("Country", worker.country, "text-detail-country")}
                </PersonInfoCard>

                <PersonInfoCard title="Employment" icon={Building}>
                  {infoRow("Employee Code", worker.employeeCode, "text-detail-code")}
                  {infoRow("Position", worker.position, "text-detail-position")}
                  {infoRow("Department", worker.department, "text-detail-department")}
                  {infoRow("Date Joined", model.formatDate(worker.dateJoined), "text-detail-joined")}
                  {infoRow("Contract Start", model.formatDate(worker.contractStartDate), "text-detail-contract-start")}
                  {infoRow("Contract End", model.formatDate(worker.contractEndDate), "text-detail-contract-end")}
                  {infoRow("Shift", worker.shiftType, "text-detail-shift")}
                </PersonInfoCard>

                <PersonInfoCard title="Compensation" icon={CreditCard}>
                  {infoRow("Salary Type", worker.salaryType, "text-detail-salary-type")}
                  {infoRow("Base Salary", fmt(worker.baseSalary), "text-detail-base-salary")}
                  {infoRow("Transport Allowance", fmt(worker.transportAllowance), "text-detail-transport-allowance")}
                  {infoRow("Per Bale Rate", fmt(worker.perBaleRate), "text-detail-bale-rate")}
                  {infoRow("Per KG Rate", fmt(worker.perKgRate), "text-detail-kg-rate")}
                  {infoRow("Overtime Rate", fmt(worker.overtimeRate), "text-detail-overtime-rate")}
                  {infoRow("Pay Frequency", worker.payFrequency)}
                  {infoRow("Payment Method", worker.paymentMethod, "text-detail-payment-method")}
                  {infoRow("Bank Name", worker.bankName, "text-detail-bank")}
                  {infoRow("Bank Account", worker.bankAccountNumber, "text-detail-bank-account")}
                </PersonInfoCard>
              </div>
              {worker.notes && (
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm whitespace-pre-wrap" data-testid="text-worker-notes">
                      {worker.notes}
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          )}

          {model.showStatement && (
            <TabsContent value="statement" className="space-y-4">
              <div className="flex justify-end">
                <ReportExportMenu
                  busy={tabs.statementExportBusy}
                  disabled={!model.payrolls?.length}
                  data-testid="button-statement-export"
                  options={[
                    { id: "excel", label: "Excel", kind: "excel", onSelect: () => tabs.exportStatement("excel") },
                    { id: "pdf", label: "PDF", kind: "pdf", onSelect: () => tabs.exportStatement("pdf") },
                    { id: "print", label: "Print", kind: "print", onSelect: () => tabs.exportStatement("print") },
                  ]}
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Net Balance</p>
                    <p
                      className={`text-xl font-bold ${model.netBalance >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                      data-testid="stat-net-balance"
                    >
                      ${model.netBalance.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Paid + Bonus − Outstanding Advances</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total Paid</p>
                    <p className="text-xl font-bold text-green-700 dark:text-green-400" data-testid="stat-total-paid">
                      ${fmtNum(model.totalPaid)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Salary only</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Pending</p>
                    <p
                      className="text-xl font-bold text-amber-700 dark:text-amber-400"
                      data-testid="stat-total-pending"
                    >
                      ${fmtNum(model.totalPending)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Unpaid payrolls</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Advances Left</p>
                    <p
                      className={`text-xl font-bold ${model.advancesLeft > 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}
                      data-testid="stat-advances-left"
                    >
                      ${model.advancesLeft.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Outstanding balance</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="p-0">
                  {model.payrollsLoading ? (
                    <div className="p-4 space-y-2">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : !model.payrolls?.length ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <DollarSign className="mx-auto h-8 w-8 mb-3 opacity-30" />
                      <p className="font-medium">No payroll records</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <Table mobileLayout="cards">
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow>
                            <TableHead>Period</TableHead>
                            <TableHead className="text-right">Base</TableHead>
                            <TableHead className="text-right">Transport</TableHead>
                            <TableHead className="text-right">Bonus</TableHead>
                            <TableHead className="text-right">Advances</TableHead>
                            <TableHead className="text-right">Net</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Paid On</TableHead>
                            <TableHead></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {model.payrolls.map((p) => {
                            const cfg = PAYROLL_STATUS[p.status] || PAYROLL_STATUS.DRAFT;
                            return (
                              <TableRow key={p.id} data-testid={`row-payroll-${p.id}`}>
                                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                  {p.periodStart?.slice(0, 10)} – {p.periodEnd?.slice(0, 10)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">${fmtNum(p.baseSalary)}</TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  ${fmtNum(p.transport || "0")}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">${fmtNum(p.bonuses)}</TableCell>
                                <TableCell className="text-right font-mono text-sm">${fmtNum(p.advances)}</TableCell>
                                <TableCell className="text-right font-mono text-sm font-semibold">
                                  ${fmtNum(p.netSalary)}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline" className={`text-xs ${cfg.className}`}>
                                    {cfg.label}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {p.paidAt ? model.formatDate(p.paidAt) : "—"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => model.setDetailPayrollId(p.id)}
                                      data-testid={`button-detail-payroll-${p.id}`}
                                      title="View details"
                                    >
                                      <Eye className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                    {model.canChangeExistingRecords && p.status !== "PAID" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          model.setPayTargetId(p.id);
                                          model.setPayCashAccountId("");
                                          model.setPayOpen(true);
                                        }}
                                        data-testid={`button-pay-payroll-${p.id}`}
                                      >
                                        Pay
                                      </Button>
                                    )}
                                    {model.canChangeExistingRecords &&
                                      model.isDeveloper &&
                                      (p.status === "PAID" || p.status === "APPROVED") &&
                                      !p.cashAccountId && (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          onClick={() => {
                                            model.setFixAcctTargetId(p.id);
                                            model.setFixAcctCashId("");
                                            model.setFixAcctOpen(true);
                                          }}
                                          data-testid={`button-fix-acct-${p.id}`}
                                          title="Generate missing accounting entry"
                                        >
                                          <Wrench className="h-4 w-4 text-amber-500" />
                                        </Button>
                                      )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Banknote className="h-4 w-4" />
                    Advances Given
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {model.advancesLoading ? (
                    <div className="p-4 space-y-2">
                      {Array.from({ length: 2 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : !model.workerAdvances?.length ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <p className="text-sm">No advances given</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <Table mobileLayout="cards">
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead className="text-right">Remaining</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Notes</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {model.workerAdvances.map((adv) => (
                            <TableRow key={adv.id} data-testid={`row-statement-advance-${adv.id}`}>
                              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                {model.formatDate(adv.advanceDate)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">${fmtNum(adv.amount)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                ${fmtNum(adv.remainingBalance)}
                              </TableCell>
                              <TableCell>
                                <Badge variant="secondary" className="text-xs">
                                  {adv.repaymentType === "manual_repayment" ? "Loan" : "Salary Deduction"}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Badge variant={adv.fullyPaid ? "outline" : "default"} className="text-xs">
                                  {adv.fullyPaid ? "Repaid" : "Outstanding"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                                {adv.notes || "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          <FactoryWorkerAdvancesPanel model={model} />

          {model.showAttendance && (
            <TabsContent value="attendance" className="space-y-4">
              <PersonAttendancePanel
                endpoint={`/api/factory/attendance/worker/${worker.id}`}
                personName={worker.fullName}
                kind="worker"
                formatDate={model.formatDate}
              />
            </TabsContent>
          )}

          <FactoryWorkerDocumentsBalesPanel model={model} />
        </Tabs>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Worker Profile tabs are available for this user.
        </div>
      )}
    </div>
  );
}
