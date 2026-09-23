import { useState } from "react";
import {
  ArrowLeft,
  UserX,
  UserCheck,
  Upload,
  DollarSign,
  CreditCard,
  Building,
  Phone,
  Calendar,
  Banknote,
  Wrench,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";

import { PAYROLL_STATUS, fmt, fmtNum, getAvatarColor, getInitials } from "./utils";
import { EndContractDialog } from "../factory-worker-detail/dialogs/EndContractDialog";
import { GenerateMissingAccountingEntryDialog } from "../factory-worker-detail/dialogs/GenerateMissingAccountingEntryDialog";
import { MarkPayrollPaidDialog } from "../factory-worker-detail/dialogs/MarkPayrollPaidDialog";
import { DocumentPreviewDialog } from "../factory-worker-detail/dialogs/DocumentPreviewDialog";
import { PayrollDetailDialog } from "../factory-worker-detail/dialogs/PayrollDetailDialog";
import type { useFactoryWorkerDetailModel } from "./useFactoryWorkerDetailModel";
import { FactoryWorkerAdvancesPanel } from "./FactoryWorkerAdvancesPanel";
import { FactoryWorkerDocumentsBalesPanel } from "./FactoryWorkerDocumentsBalesPanel";

interface FactoryWorkerDetailModelProps {
  model: ReturnType<typeof useFactoryWorkerDetailModel>;
}

export function FactoryWorkerDetailView({ model }: FactoryWorkerDetailModelProps) {
  const {
    AdminDialog,
    advancesLeft,
    advancesLoading,
    cashAccounts,
    deleteDocMutation,
    detailPayrollId,
    endCalculating,
    endCashAccountId,
    endEnd,
    endOpen,
    endResult,
    endStart,
    endStep,
    endSubmitting,
    fileInputRef,
    fixAcctCashId,
    fixAcctMutation,
    fixAcctOpen,
    fixAcctTargetId,
    formatDate,
    handleCalculate,
    handleEndContract,
    handlePhotoUpload,
    handleSkipAndEnd,
    isDeveloper,
    markPaidMutation,
    navigate,
    netBalance,
    openEndContract,
    payCashAccountId,
    payOpen,
    payTargetId,
    payrollBalance,
    payrollDetail,
    payrollDetailLoading,
    payrolls,
    payrollsLoading,
    pendingDeleteDocId,
    reactivateMutation,
    setDetailPayrollId,
    setEndCashAccountId,
    setEndEnd,
    setEndOpen,
    setEndResult,
    setEndStart,
    setEndStep,
    setFixAcctCashId,
    setFixAcctOpen,
    setFixAcctTargetId,
    setPayCashAccountId,
    setPayOpen,
    setPayTargetId,
    setPendingDeleteDocId,
    setViewingDoc,
    showAdvances,
    showBales,
    showDocuments,
    showProfile,
    showStatement,
    stats,
    statsLoading,
    totalPaid,
    totalPending,
    viewingDoc,
    worker,
    workerAdvances,
    workerError,
    workerId,
    workerLoading,
    wrapAdminAction,
  } = model;
  const visibleDetailTabs = [
    showProfile ? "profile" : null,
    showStatement ? "statement" : null,
    showAdvances ? "advances" : null,
    showBales ? "bales" : null,
    showDocuments ? "documents" : null,
  ].filter((value): value is "profile" | "statement" | "advances" | "bales" | "documents" => value !== null);
  const [requestedDetailTab, setRequestedDetailTab] = useState<
    "profile" | "statement" | "advances" | "bales" | "documents"
  >("profile");
  const activeDetailTab = visibleDetailTabs.includes(requestedDetailTab)
    ? requestedDetailTab
    : visibleDetailTabs[0];

  if (!workerId)
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Invalid worker ID</div>;

  if (workerLoading) {
    return (
      <div className="flex gap-6">
        <Skeleton className="w-72 h-96 shrink-0 rounded-md" />
        <Skeleton className="flex-1 h-96 rounded-md" />
      </div>
    );
  }

  if (workerError || !worker) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/factory/payroll-hub?tab=workers")}
          data-testid="button-back-error"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center justify-center py-20 text-muted-foreground">Worker not found</div>
      </div>
    );
  }

  const infoRow = (label: string, value: string | number | null | undefined, testId?: string) => (
    <div className="flex justify-between py-1.5 border-b last:border-0 text-sm">
      <span className="text-muted-foreground shrink-0 mr-3">{label}</span>
      <span className="font-medium text-right" data-testid={testId}>
        {value || "—"}
      </span>
    </div>
  );

  const avatarColor = getAvatarColor(worker.fullName);

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate("/factory/payroll-hub?tab=workers")}
        data-testid="button-back-workers"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="w-full lg:w-72 shrink-0 space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="relative">
                  <Avatar className={`h-20 w-20 text-lg font-bold ${avatarColor}`}>
                    {worker.photoUrl ? (
                      <AvatarImage src={worker.photoUrl} alt={worker.fullName} data-testid="img-worker-photo" />
                    ) : null}
                    <AvatarFallback className={avatarColor} data-testid="text-worker-avatar">
                      {getInitials(worker.fullName)}
                    </AvatarFallback>
                  </Avatar>
                </div>
                <div>
                  <h2 className="font-bold text-lg leading-tight" data-testid="text-worker-name">
                    {worker.fullName}
                  </h2>
                  {worker.position && (
                    <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-worker-position">
                      {worker.position}
                    </p>
                  )}
                  {worker.department && <p className="text-xs text-muted-foreground">{worker.department}</p>}
                </div>
                <Badge
                  variant={worker.active ? "default" : "secondary"}
                  className="no-default-active-elevate"
                  data-testid="badge-worker-status"
                >
                  {worker.active ? "Active" : "Inactive"}
                </Badge>
              </div>

              <div className="border-t pt-3 space-y-2">
                {worker.employeeCode && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground text-xs">Code</span>
                    <span className="font-mono text-xs ml-auto" data-testid="text-worker-code">
                      {worker.employeeCode}
                    </span>
                  </div>
                )}
                {worker.nationality && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground text-xs">Nationality</span>
                    <span className="text-xs ml-auto">{worker.nationality}</span>
                  </div>
                )}
                {worker.phone1 && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto" data-testid="text-worker-phone">
                      {worker.phone1}
                    </span>
                  </div>
                )}
                {worker.dateJoined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto">Joined {formatDate(worker.dateJoined)}</span>
                  </div>
                )}
                {worker.salaryType && (
                  <div className="flex items-center gap-2 text-sm">
                    <DollarSign className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto">
                      {worker.salaryType} — {fmt(worker.baseSalary)}
                    </span>
                  </div>
                )}
              </div>

              <div className="border-t pt-3 space-y-2">
                <input
                  type="file"
                  accept="image/*"
                  ref={fileInputRef}
                  className="hidden"
                  onChange={handlePhotoUpload}
                  data-testid="input-photo-upload"
                />
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="button-upload-photo"
                >
                  <Upload className="h-3.5 w-3.5 mr-2" />
                  Upload Photo
                </Button>
                {worker.active ? (
                  <Button
                    variant="destructive"
                    className="w-full"
                    onClick={openEndContract}
                    data-testid="button-end-contract"
                  >
                    <UserX className="h-3.5 w-3.5 mr-2" />
                    End Contract
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full text-green-600 border-green-600"
                    onClick={() => wrapAdminAction(() => reactivateMutation.mutate(), "Reactivate Worker")}
                    disabled={reactivateMutation.isPending}
                    data-testid="button-reactivate-worker"
                  >
                    <UserCheck className="h-3.5 w-3.5 mr-2" />
                    {reactivateMutation.isPending ? "Reactivating..." : "Reactivate Worker"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {!statsLoading && stats && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-sm text-muted-foreground">Production Stats</CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-4 space-y-3">
                <div className="text-center">
                  <p className="text-2xl font-bold" data-testid="text-stat-bales">
                    {stats.totalBales}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Bales</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div>
                    <p className="font-semibold text-sm" data-testid="text-stat-kg">
                      {parseFloat(stats.totalKg).toFixed(1)}
                    </p>
                    <p className="text-xs text-muted-foreground">KG</p>
                  </div>
                  <div>
                    <p className="font-semibold text-sm" data-testid="text-stat-paid">
                      {fmt(stats.totalPaid)}
                    </p>
                    <p className="text-xs text-muted-foreground">Paid</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {activeDetailTab ? (
          <Tabs
            value={activeDetailTab}
            onValueChange={(value) =>
              setRequestedDetailTab(value as "profile" | "statement" | "advances" | "bales" | "documents")
            }
          >
            <TabsList className="mb-4">
              {showProfile && (
                <TabsTrigger value="profile" data-testid="tab-profile">
                  Profile
                </TabsTrigger>
              )}
              {showStatement && (
                <TabsTrigger value="statement" data-testid="tab-statement">
                  Statement
                </TabsTrigger>
              )}
              {showAdvances && (
                <TabsTrigger value="advances" data-testid="tab-advances">
                  Advances
                </TabsTrigger>
              )}
              {showBales && (
                <TabsTrigger value="bales" data-testid="tab-bales">
                  Bales
                </TabsTrigger>
              )}
              {showDocuments && (
                <TabsTrigger value="documents" data-testid="tab-documents">
                  Documents
                </TabsTrigger>
              )}
            </TabsList>

            {showProfile && <TabsContent value="profile" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span>Personal</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Full Name", worker.fullName, "text-detail-fullname")}
                    {infoRow("Father Name", worker.fatherName, "text-detail-father")}
                    {infoRow("Mother Name", worker.motherName, "text-detail-mother")}
                    {infoRow("National ID", worker.nationalId, "text-detail-nationalid")}
                    {infoRow("Passport", worker.passportNumber, "text-detail-passport")}
                    {infoRow("Date of Birth", formatDate(worker.dateOfBirth), "text-detail-dob")}
                    {infoRow("Gender", worker.gender, "text-detail-gender")}
                    {infoRow("Nationality", worker.nationality, "text-detail-nationality")}
                    {infoRow("Marital Status", worker.maritalStatus, "text-detail-marital")}
                    {infoRow("Children", worker.numberOfChildren ?? "—", "text-detail-children")}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Phone className="h-3.5 w-3.5" /> Contact
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Phone 1", worker.phone1, "text-detail-phone1")}
                    {infoRow("Phone 2", worker.phone2, "text-detail-phone2")}
                    {infoRow("Emergency Name", worker.emergencyContactName, "text-detail-emergency")}
                    {infoRow("Emergency Phone", worker.emergencyContactPhone)}
                    {infoRow("Address", worker.address, "text-detail-address")}
                    {infoRow("City", worker.city, "text-detail-city")}
                    {infoRow("Country", worker.country, "text-detail-country")}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building className="h-3.5 w-3.5" /> Employment
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Employee Code", worker.employeeCode, "text-detail-code")}
                    {infoRow("Position", worker.position, "text-detail-position")}
                    {infoRow("Department", worker.department, "text-detail-department")}
                    {infoRow("Date Joined", formatDate(worker.dateJoined), "text-detail-joined")}
                    {infoRow("Contract Start", formatDate(worker.contractStartDate), "text-detail-contract-start")}
                    {infoRow("Contract End", formatDate(worker.contractEndDate), "text-detail-contract-end")}
                    {infoRow("Shift", worker.shiftType, "text-detail-shift")}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CreditCard className="h-3.5 w-3.5" /> Compensation
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
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
                  </CardContent>
                </Card>
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
            </TabsContent>}

            {showStatement && (
              <TabsContent value="statement" className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Net Balance</p>
                      <p
                        className={`text-xl font-bold ${netBalance >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                        data-testid="stat-net-balance"
                      >
                        ${netBalance.toFixed(2)}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Paid + Bonus − Outstanding Advances</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Total Paid</p>
                      <p className="text-xl font-bold text-green-700 dark:text-green-400" data-testid="stat-total-paid">
                        ${fmtNum(totalPaid)}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Salary only</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Pending</p>
                      <p
                        className="text-xl font-bold text-amber-700 dark:text-amber-400"
                        data-testid="stat-total-pending"
                      >
                        ${fmtNum(totalPending)}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Unpaid payrolls</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Advances Left</p>
                      <p
                        className={`text-xl font-bold ${advancesLeft > 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}
                        data-testid="stat-advances-left"
                      >
                        ${advancesLeft.toFixed(2)}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Outstanding balance</p>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardContent className="p-0">
                    {payrollsLoading ? (
                      <div className="p-4 space-y-2">
                        {Array.from({ length: 4 }).map((_, i) => (
                          <Skeleton key={i} className="h-10 w-full" />
                        ))}
                      </div>
                    ) : !payrolls?.length ? (
                      <div className="text-center py-12 text-muted-foreground">
                        <DollarSign className="mx-auto h-8 w-8 mb-3 opacity-30" />
                        <p className="font-medium">No payroll records</p>
                      </div>
                    ) : (
                      <div className="table-responsive">
                        <Table>
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
                            {payrolls.map((p) => {
                              const cfg = PAYROLL_STATUS[p.status] || PAYROLL_STATUS.DRAFT;
                              return (
                                <TableRow key={p.id} data-testid={`row-payroll-${p.id}`}>
                                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                    {p.periodStart?.slice(0, 10)} – {p.periodEnd?.slice(0, 10)}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm">
                                    ${fmtNum(p.baseSalary)}
                                  </TableCell>
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
                                    {p.paidAt ? formatDate(p.paidAt) : "—"}
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex items-center gap-1">
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => setDetailPayrollId(p.id)}
                                        data-testid={`button-detail-payroll-${p.id}`}
                                        title="View details"
                                      >
                                        <Eye className="h-4 w-4 text-muted-foreground" />
                                      </Button>
                                      {p.status !== "PAID" && (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => {
                                            setPayTargetId(p.id);
                                            setPayCashAccountId("");
                                            setPayOpen(true);
                                          }}
                                          data-testid={`button-pay-payroll-${p.id}`}
                                        >
                                          Pay
                                        </Button>
                                      )}
                                      {isDeveloper &&
                                        (p.status === "PAID" || p.status === "APPROVED") &&
                                        !p.cashAccountId && (
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => {
                                              setFixAcctTargetId(p.id);
                                              setFixAcctCashId("");
                                              setFixAcctOpen(true);
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
                    {advancesLoading ? (
                      <div className="p-4 space-y-2">
                        {Array.from({ length: 2 }).map((_, i) => (
                          <Skeleton key={i} className="h-10 w-full" />
                        ))}
                      </div>
                    ) : !workerAdvances?.length ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <p className="text-sm">No advances given</p>
                      </div>
                    ) : (
                      <div className="table-responsive">
                        <Table>
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
                            {workerAdvances.map((adv) => (
                              <TableRow key={adv.id} data-testid={`row-statement-advance-${adv.id}`}>
                                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                  {formatDate(adv.advanceDate)}
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

            <FactoryWorkerDocumentsBalesPanel model={model} />
          </Tabs>
          ) : (
            <div className="rounded-md border p-6 text-sm text-muted-foreground">
              No Worker Profile tabs are available for this user.
            </div>
          )}
        </div>
      </div>

      <EndContractDialog
        cashAccounts={cashAccounts}
        endCalculating={endCalculating}
        endCashAccountId={endCashAccountId}
        endEnd={endEnd}
        endOpen={endOpen}
        endResult={endResult}
        endStart={endStart}
        endStep={endStep}
        endSubmitting={endSubmitting}
        handleCalculate={handleCalculate}
        handleEndContract={handleEndContract}
        handleSkipAndEnd={handleSkipAndEnd}
        payrollBalance={payrollBalance}
        setEndCashAccountId={setEndCashAccountId}
        setEndEnd={setEndEnd}
        setEndOpen={setEndOpen}
        setEndResult={setEndResult}
        setEndStart={setEndStart}
        setEndStep={setEndStep}
        worker={worker}
      />

      {/* Fix Accounting Dialog */}
      <GenerateMissingAccountingEntryDialog
        cashAccounts={cashAccounts}
        fixAcctCashId={fixAcctCashId}
        fixAcctMutation={fixAcctMutation}
        fixAcctOpen={fixAcctOpen}
        fixAcctTargetId={fixAcctTargetId}
        setFixAcctCashId={setFixAcctCashId}
        setFixAcctOpen={setFixAcctOpen}
        setFixAcctTargetId={setFixAcctTargetId}
        wrapAdminAction={wrapAdminAction}
      />

      <MarkPayrollPaidDialog
        cashAccounts={cashAccounts}
        markPaidMutation={markPaidMutation}
        payCashAccountId={payCashAccountId}
        payOpen={payOpen}
        payTargetId={payTargetId}
        setPayCashAccountId={setPayCashAccountId}
        setPayOpen={setPayOpen}
        setPayTargetId={setPayTargetId}
        wrapAdminAction={wrapAdminAction}
      />

      {/* Image Viewer Dialog */}
      <DocumentPreviewDialog setViewingDoc={setViewingDoc} viewingDoc={viewingDoc} />

      {/* Delete Document Confirmation */}
      <Dialog
        open={pendingDeleteDocId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteDocId(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Document?</DialogTitle>
            <DialogDescription>
              This will permanently remove the uploaded document. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setPendingDeleteDocId(null)}
              disabled={deleteDocMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteDocMutation.isPending}
              onClick={() =>
                wrapAdminAction(() => {
                  if (pendingDeleteDocId !== null) {
                    deleteDocMutation.mutate(pendingDeleteDocId);
                    setPendingDeleteDocId(null);
                  }
                }, "Delete Document")
              }
              data-testid="button-confirm-delete-doc"
            >
              {deleteDocMutation.isPending ? "Deleting..." : "Delete Document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Payroll Detail Dialog */}
      <PayrollDetailDialog
        detailPayrollId={detailPayrollId}
        payrollDetail={payrollDetail}
        payrollDetailLoading={payrollDetailLoading}
        setDetailPayrollId={setDetailPayrollId}
      />

      {AdminDialog}
    </div>
  );
}
