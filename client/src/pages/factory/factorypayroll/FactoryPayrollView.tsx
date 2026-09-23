import { useState } from "react";
import {
  CheckCircle2,
  Download,
  DollarSign,
  Edit,
  FileText,
  GitMerge,
  Loader2,
  Table2,
  Upload,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProductionBonusDecisionPanel } from "./ProductionBonusDecisionPanel";
import { PayrollSummaryCards } from "./PayrollSummaryCards";
import { amount, getStatusBadge } from "./utils";
import type { useFactoryPayrollModel } from "./useFactoryPayrollModel";

export function FactoryPayrollView({ model }: { model: ReturnType<typeof useFactoryPayrollModel> }) {
  const {
    formatDisplayDate,
    navigate,
    showPayrollRecords,
    showWorkerMaster,
    setCompanyId,
    filterStartDate,
    setFilterStartDate,
    filterEndDate,
    setFilterEndDate,
    statusFilter,
    setStatusFilter,
    showGenerateDialog,
    setShowGenerateDialog,
    genStartDate,
    setGenStartDate,
    genEndDate,
    setGenEndDate,
    editRecord,
    setEditRecord,
    editOtherBonuses,
    setEditOtherBonuses,
    editDeductions,
    setEditDeductions,
    editAdvances,
    setEditAdvances,
    editOvertimeHours,
    setEditOvertimeHours,
    editNotes,
    setEditNotes,
    editStatus,
    setEditStatus,
    showPayDialog,
    setShowPayDialog,
    paySource,
    setPaySource,
    payDate,
    setPayDate,
    payReference,
    setPayReference,
    payEffectiveDate,
    setPayEffectiveDate,
    exportingPdf,
    exportingExcel,
    migrating,
    workerSearch,
    setWorkerSearch,
    workerImporting,
    workerFileInput,
    companies,
    selectedCompanyId,
    workersLoading,
    filteredWorkers,
    payrollRecords,
    isLoading,
    isError,
    generateMutation,
    adjustMutation,
    openEditDialog,
    handleProductionBonusChanged,
    handleAdjustSubmit,
    handleConfirmPayment,
    handleWorkerImport,
    handleMigrateCitySplit,
    handleExportPdf,
    handleExportExcel,
    totals,
  } = model;
  const visibleTabs = [
    showPayrollRecords ? "payroll" : null,
    showWorkerMaster ? "workers" : null,
  ].filter((value): value is "payroll" | "workers" => value !== null);
  const [requestedTab, setRequestedTab] = useState<"payroll" | "workers">("payroll");
  const activeTab = visibleTabs.includes(requestedTab) ? requestedTab : visibleTabs[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeader
          title="Factory Worker Payroll"
          subtitle="Generate, review production bonuses, and manage factory worker payroll"
        />
        <div className="flex flex-wrap items-end gap-2">
          {companies.length > 1 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Company</Label>
              <Select
                value={selectedCompanyId ? String(selectedCompanyId) : ""}
                onValueChange={(value) => setCompanyId(parseInt(value))}
              >
                <SelectTrigger className="w-48" data-testid="select-company">
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={String(company.id)}>
                      {company.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button
            onClick={() => setShowGenerateDialog(true)}
            disabled={!selectedCompanyId}
            data-testid="button-generate-payroll"
          >
            <DollarSign className="mr-1 h-4 w-4" /> Generate Payroll
          </Button>
          <Button
            variant="outline"
            onClick={handleExportPdf}
            disabled={!selectedCompanyId || exportingPdf}
            data-testid="button-export-pdf"
          >
            {exportingPdf ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}{" "}
            Export PDF
          </Button>
          <Button
            variant="outline"
            onClick={handleExportExcel}
            disabled={!selectedCompanyId || exportingExcel}
            data-testid="button-export-excel"
          >
            {exportingExcel ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}{" "}
            Export Excel
          </Button>
          <Button
            variant="outline"
            onClick={handleMigrateCitySplit}
            disabled={!selectedCompanyId || migrating}
            data-testid="button-migrate-city-split"
            title="One-time: split historical salary/bonus by city"
          >
            {migrating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <GitMerge className="mr-1 h-4 w-4" />}{" "}
            Split by City
          </Button>
        </div>
      </div>

      {activeTab ? (
      <Tabs
        value={activeTab}
        onValueChange={(value) => setRequestedTab(value as "payroll" | "workers")}
        className="space-y-4"
      >
        <TabsList variant="underline">
          {showPayrollRecords && (
            <TabsTrigger value="payroll" data-testid="tab-payroll-records">
              <FileText className="mr-1 h-4 w-4" /> Payroll Records
            </TabsTrigger>
          )}
          {showWorkerMaster && (
            <TabsTrigger value="workers" data-testid="tab-worker-master">
              <Table2 className="mr-1 h-4 w-4" /> Worker Master Sheet
            </TabsTrigger>
          )}
        </TabsList>

        {showPayrollRecords && <TabsContent value="payroll" className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">From</Label>
                  <Input
                    type="date"
                    value={filterStartDate}
                    onChange={(event) => setFilterStartDate(event.target.value)}
                    className="w-40"
                    data-testid="input-filter-start-date"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">To</Label>
                  <Input
                    type="date"
                    value={filterEndDate}
                    onChange={(event) => setFilterEndDate(event.target.value)}
                    className="w-40"
                    data-testid="input-filter-end-date"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-40" data-testid="select-status-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All Statuses</SelectItem>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="APPROVED">Approved</SelectItem>
                      <SelectItem value="PAID">Paid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          <PayrollSummaryCards recordCount={payrollRecords.length} totals={totals} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" /> Payroll Records
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selectedCompanyId ? (
                <div className="py-12 text-center">
                  <Users className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-4 text-lg font-semibold">Select a company</h3>
                  <p className="mt-2 text-muted-foreground">Choose a company to view payroll records</p>
                </div>
              ) : isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-muted-foreground">Loading payroll...</span>
                </div>
              ) : isError ? (
                <div className="py-12 text-center">
                  <p className="text-destructive">Failed to load payroll data. Please try again.</p>
                </div>
              ) : payrollRecords.length === 0 ? (
                <div className="py-12 text-center">
                  <DollarSign className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-4 text-lg font-semibold">No payroll records found</h3>
                  <p className="mt-2 text-muted-foreground">Generate payroll or adjust the filters to see records</p>
                </div>
              ) : (
                <div className="table-responsive">
                  <Table minimumWidth="92rem" scrollLabel="Factory payroll records">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Employee Code</TableHead>
                        <TableHead>Worker Name</TableHead>
                        <TableHead>Position</TableHead>
                        <TableHead className="text-right">Base Salary</TableHead>
                        <TableHead className="text-right">Bale Earnings</TableHead>
                        <TableHead className="text-right">KG Earnings</TableHead>
                        <TableHead className="text-right">Overtime</TableHead>
                        <TableHead className="text-right">Production Bonus</TableHead>
                        <TableHead className="text-right">Other Bonus</TableHead>
                        <TableHead className="text-right">Deductions</TableHead>
                        <TableHead className="text-right">Advances</TableHead>
                        <TableHead className="text-right">Net Salary</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payrollRecords.map((record) => (
                        <TableRow key={record.id} data-testid={`row-payroll-${record.id}`}>
                          <TableCell className="font-mono text-sm">{record.workerCode || "-"}</TableCell>
                          <TableCell className="font-medium">{record.workerName || "-"}</TableCell>
                          <TableCell className="text-muted-foreground">{record.workerPosition || "-"}</TableCell>
                          <TableCell className="text-right font-mono">{amount(record.baseSalary).toFixed(2)}</TableCell>
                          <TableCell className="text-right font-mono">
                            {amount(record.baleEarnings).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {amount(record.kgEarnings).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {amount(record.overtimePay).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="font-mono font-semibold">{amount(record.productionBonus).toFixed(2)}</div>
                            {amount(record.pendingProductionBonus) > 0 && (
                              <Badge variant="outline" className="mt-1 whitespace-nowrap text-[10px]">
                                +{amount(record.pendingProductionBonus).toFixed(2)} pending
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {amount(record.otherBonuses).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">{amount(record.deductions).toFixed(2)}</TableCell>
                          <TableCell className="text-right font-mono">{amount(record.advances).toFixed(2)}</TableCell>
                          <TableCell className="text-right font-mono font-bold">
                            {amount(record.netSalary).toFixed(2)}
                          </TableCell>
                          <TableCell>{getStatusBadge(record.status)}</TableCell>
                          <TableCell>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => openEditDialog(record)}
                              data-testid={`button-edit-payroll-${record.id}`}
                            >
                              <Edit className="h-3 w-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="border-t-2 font-bold" data-testid="row-payroll-totals">
                        <TableCell colSpan={3} className="text-right">
                          TOTALS
                        </TableCell>
                        <TableCell className="text-right font-mono">{totals.baseSalary.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.baleEarnings.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.kgEarnings.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono">{totals.overtimePay.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.productionBonus.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.otherBonuses.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.deductions.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.advances.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-mono">{totals.netSalary.toFixed(2)}</TableCell>
                        <TableCell colSpan={2} />
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
            <DialogContent data-testid="dialog-generate-payroll">
              <DialogHeader>
                <DialogTitle>Generate Payroll</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={genStartDate}
                    onChange={(event) => setGenStartDate(event.target.value)}
                    data-testid="input-gen-start-date"
                  />
                </div>
                <div className="space-y-1">
                  <Label>End Date</Label>
                  <Input
                    type="date"
                    value={genEndDate}
                    onChange={(event) => setGenEndDate(event.target.value)}
                    data-testid="input-gen-end-date"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowGenerateDialog(false)}
                  data-testid="button-cancel-generate"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    selectedCompanyId &&
                    generateMutation.mutate({
                      companyId: selectedCompanyId,
                      startDate: genStartDate,
                      endDate: genEndDate,
                    })
                  }
                  disabled={generateMutation.isPending || !genStartDate || !genEndDate}
                  data-testid="button-submit-generate"
                >
                  {generateMutation.isPending ? (
                    <>
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    "Generate"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={showPayDialog} onOpenChange={(open) => !open && setShowPayDialog(false)}>
            <DialogContent data-testid="dialog-confirm-payment">
              <DialogHeader>
                <DialogTitle>Confirm Payment</DialogTitle>
              </DialogHeader>
              {editRecord && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Recording payment for <span className="font-medium text-foreground">{editRecord.workerName}</span> —
                    net salary{" "}
                    <span className="font-mono font-medium text-foreground">
                      {amount(editRecord.netSalary).toFixed(2)}
                    </span>
                  </p>
                  <div className="space-y-1">
                    <Label>Payment Source</Label>
                    <Select value={paySource} onValueChange={setPaySource}>
                      <SelectTrigger data-testid="select-pay-source">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Cash">Cash</SelectItem>
                        <SelectItem value="Bank">Bank</SelectItem>
                        <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                        <SelectItem value="Cheque">Cheque</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Payment Date</Label>
                    <Input
                      type="date"
                      value={payDate}
                      onChange={(event) => setPayDate(event.target.value)}
                      data-testid="input-pay-date"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>
                      Reference / Notes <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      value={payReference}
                      onChange={(event) => setPayReference(event.target.value)}
                      placeholder="e.g. cheque no. or transfer ref"
                      data-testid="input-pay-reference"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>
                      Effective Date{" "}
                      <span className="text-muted-foreground">(optional — defaults to payment date)</span>
                    </Label>
                    <Input
                      type="date"
                      value={payEffectiveDate}
                      onChange={(event) => setPayEffectiveDate(event.target.value)}
                      data-testid="input-pay-effective-date"
                    />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowPayDialog(false)} data-testid="button-cancel-payment">
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirmPayment}
                  disabled={adjustMutation.isPending || !payDate}
                  data-testid="button-confirm-payment"
                >
                  {adjustMutation.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                  )}{" "}
                  Mark as Paid
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={editRecord !== null} onOpenChange={(open) => !open && setEditRecord(null)}>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl" data-testid="dialog-adjust-payroll">
              <DialogHeader>
                <DialogTitle>Adjust Payroll</DialogTitle>
              </DialogHeader>
              {editRecord && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Worker: <span className="font-medium text-foreground">{editRecord.workerName}</span> (
                    {editRecord.workerCode})
                  </p>
                  <ProductionBonusDecisionPanel
                    payrollId={editRecord.id}
                    payrollStatus={editRecord.status}
                    onChanged={handleProductionBonusChanged}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label>Approved Production Bonus</Label>
                      <Input
                        value={amount(editRecord.productionBonus).toFixed(2)}
                        readOnly
                        className="bg-muted font-mono"
                        data-testid="input-approved-production-bonus"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Other Bonus</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={editOtherBonuses}
                        onChange={(event) => setEditOtherBonuses(event.target.value)}
                        data-testid="input-edit-other-bonuses"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Deductions</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={editDeductions}
                        onChange={(event) => setEditDeductions(event.target.value)}
                        data-testid="input-edit-deductions"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Advances</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={editAdvances}
                        onChange={(event) => setEditAdvances(event.target.value)}
                        data-testid="input-edit-advances"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Overtime Hours</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={editOvertimeHours}
                        onChange={(event) => setEditOvertimeHours(event.target.value)}
                        data-testid="input-edit-overtime-hours"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Current Net Salary</Label>
                      <Input
                        value={amount(editRecord.netSalary).toFixed(2)}
                        readOnly
                        className="bg-muted font-mono font-semibold"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Notes</Label>
                    <Input
                      value={editNotes}
                      onChange={(event) => setEditNotes(event.target.value)}
                      placeholder="Optional notes"
                      data-testid="input-edit-notes"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Status</Label>
                    <Select value={editStatus} onValueChange={setEditStatus}>
                      <SelectTrigger data-testid="select-edit-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DRAFT">Draft</SelectItem>
                        <SelectItem value="APPROVED">Approved</SelectItem>
                        <SelectItem value="PAID">Paid</SelectItem>
                      </SelectContent>
                    </Select>
                    {amount(editRecord.pendingProductionBonus) > 0 && (
                      <p className="text-xs text-amber-600">
                        Decide all pending production bonuses before approving or paying.
                      </p>
                    )}
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditRecord(null)} data-testid="button-cancel-adjust">
                  Cancel
                </Button>
                <Button
                  onClick={handleAdjustSubmit}
                  disabled={adjustMutation.isPending}
                  data-testid="button-submit-adjust"
                >
                  {adjustMutation.isPending ? (
                    <>
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Changes"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>}

        {showWorkerMaster && (
          <TabsContent value="workers" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Input
                  placeholder="Search by name, code or phone..."
                  value={workerSearch}
                  onChange={(event) => setWorkerSearch(event.target.value)}
                  className="max-w-sm"
                  data-testid="input-worker-search"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={workerFileInput}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={handleWorkerImport}
                  data-testid="input-worker-import-file"
                />
                <Button
                  variant="outline"
                  onClick={() => workerFileInput.current?.click()}
                  disabled={workerImporting || !selectedCompanyId}
                  data-testid="button-import-workers"
                >
                  {workerImporting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-1 h-4 w-4" />
                  )}{" "}
                  Import Workers Excel
                </Button>
                <a
                  href={selectedCompanyId ? "/api/factory/workers/template.xlsx" : "#"}
                  download
                  onClick={(event) => {
                    if (!selectedCompanyId) event.preventDefault();
                  }}
                >
                  <Button variant="outline" disabled={!selectedCompanyId} data-testid="button-download-template">
                    <Download className="mr-1 h-4 w-4" /> Download Template
                  </Button>
                </a>
              </div>
            </div>

            <Card>
              <CardContent className="overflow-x-auto pt-0">
                <Table minimumWidth="94rem" scrollLabel="Factory worker master sheet">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead className="whitespace-nowrap">Code</TableHead>
                      <TableHead className="whitespace-nowrap">Full Name</TableHead>
                      <TableHead className="whitespace-nowrap">Status</TableHead>
                      <TableHead className="whitespace-nowrap">Position</TableHead>
                      <TableHead className="whitespace-nowrap">Department</TableHead>
                      <TableHead className="whitespace-nowrap">Phone 1</TableHead>
                      <TableHead className="whitespace-nowrap">Phone 2</TableHead>
                      <TableHead className="whitespace-nowrap">Emergency Contact</TableHead>
                      <TableHead className="whitespace-nowrap">Date Joined</TableHead>
                      <TableHead className="whitespace-nowrap">Contract Start</TableHead>
                      <TableHead className="whitespace-nowrap">Salary Type</TableHead>
                      <TableHead className="whitespace-nowrap">Pay Frequency</TableHead>
                      <TableHead className="whitespace-nowrap text-right">Base Salary</TableHead>
                      <TableHead className="whitespace-nowrap">Visa No.</TableHead>
                      <TableHead className="whitespace-nowrap">Work Permit</TableHead>
                      <TableHead className="whitespace-nowrap">Residential Permit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workersLoading ? (
                      <TableRow>
                        <TableCell colSpan={16} className="py-8 text-center">
                          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                        </TableCell>
                      </TableRow>
                    ) : filteredWorkers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={16} className="py-8 text-center text-muted-foreground">
                          {workerSearch ? "No workers match your search" : "No workers found. Import or add workers."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredWorkers.map((worker) => (
                        <TableRow
                          key={worker.id}
                          className="cursor-pointer hover-elevate"
                          onClick={() => navigate(`/factory/workers/${worker.id}`)}
                          data-testid={`row-worker-${worker.id}`}
                        >
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {worker.employeeCode || "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-medium">{worker.fullName}</TableCell>
                          <TableCell>
                            <Badge
                              variant={worker.active ? "secondary" : "outline"}
                              className={
                                worker.active
                                  ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                  : ""
                              }
                            >
                              {worker.active ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{worker.position || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.department || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.phone1 || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.phone2 || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.emergencyContactName || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {worker.dateJoined ? formatDisplayDate(new Date(worker.dateJoined)) : "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {worker.contractStartDate ? formatDisplayDate(new Date(worker.contractStartDate)) : "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{worker.salaryType || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.payFrequency || "Monthly"}</TableCell>
                          <TableCell className="whitespace-nowrap text-right">
                            {worker.baseSalary ? parseFloat(worker.baseSalary).toFixed(2) : "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{worker.visaNumber || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.workPermitNumber || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{worker.residentialPermit || "—"}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Payroll tabs are available for this user.
        </div>
      )}
    </div>
  );
}
