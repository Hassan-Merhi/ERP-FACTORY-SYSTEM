import { ArrowLeft, UserX, UserCheck, Upload, DollarSign, Phone, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

import { fmt, getAvatarColor, getInitials } from "./utils";
import { EndContractDialog } from "../factory-worker-detail/dialogs/EndContractDialog";
import { GenerateMissingAccountingEntryDialog } from "../factory-worker-detail/dialogs/GenerateMissingAccountingEntryDialog";
import { MarkPayrollPaidDialog } from "../factory-worker-detail/dialogs/MarkPayrollPaidDialog";
import { DocumentPreviewDialog } from "../factory-worker-detail/dialogs/DocumentPreviewDialog";
import { PayrollDetailDialog } from "../factory-worker-detail/dialogs/PayrollDetailDialog";
import type { useFactoryWorkerDetailModel } from "./useFactoryWorkerDetailModel";
import { PersonStatusBadge } from "../people/PeopleRoster";
import { PersonInfoRow } from "../people/PersonDetailParts";
import { useFactoryWorkerDetailViewTabs } from "./useFactoryWorkerDetailViewTabs";
import { FactoryWorkerDetailTabs } from "./FactoryWorkerDetailTabs";

export interface FactoryWorkerDetailModelProps {
  model: ReturnType<typeof useFactoryWorkerDetailModel>;
}

export function FactoryWorkerDetailView({ model }: FactoryWorkerDetailModelProps) {
  const tabs = useFactoryWorkerDetailViewTabs(model);

  if (!model.workerId)
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Invalid worker ID</div>;

  if (model.workerLoading) {
    return (
      <div className="flex gap-6">
        <Skeleton className="w-72 h-96 shrink-0 rounded-md" />
        <Skeleton className="flex-1 h-96 rounded-md" />
      </div>
    );
  }

  if (model.workerError || !model.worker) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => model.navigate("/factory/payroll-hub?section=workers")}
          data-testid="button-back-error"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center justify-center py-20 text-muted-foreground">Worker not found</div>
      </div>
    );
  }

  const infoRow = (label: string, value: string | number | null | undefined, testId?: string) => (
    <PersonInfoRow label={label} value={value || "—"} testId={testId} />
  );

  const avatarColor = getAvatarColor(model.worker.fullName);

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.navigate("/factory/payroll-hub?section=workers")}
        data-testid="button-back-workers"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-col lg:flex-row gap-6 items-stretch lg:items-start">
        <div className="w-full lg:w-72 shrink-0 space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="relative">
                  <Avatar className={`h-20 w-20 text-lg font-bold ${avatarColor}`}>
                    {model.worker.photoUrl ? (
                      <AvatarImage
                        src={model.worker.photoUrl}
                        alt={model.worker.fullName}
                        data-testid="img-worker-photo"
                      />
                    ) : null}
                    <AvatarFallback className={avatarColor} data-testid="text-worker-avatar">
                      {getInitials(model.worker.fullName)}
                    </AvatarFallback>
                  </Avatar>
                </div>
                <div>
                  <h2 className="font-bold text-lg leading-tight" data-testid="text-worker-name">
                    {model.worker.fullName}
                  </h2>
                  {model.worker.position && (
                    <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-worker-position">
                      {model.worker.position}
                    </p>
                  )}
                  {model.worker.department && (
                    <p className="text-xs text-muted-foreground">{model.worker.department}</p>
                  )}
                </div>
                <PersonStatusBadge active={model.worker.active} data-testid="badge-worker-status" />
              </div>

              <div className="border-t pt-3 space-y-2">
                {model.worker.employeeCode && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground text-xs">Code</span>
                    <span className="font-mono text-xs ml-auto" data-testid="text-worker-code">
                      {model.worker.employeeCode}
                    </span>
                  </div>
                )}
                {model.worker.nationality && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground text-xs">Nationality</span>
                    <span className="text-xs ml-auto">{model.worker.nationality}</span>
                  </div>
                )}
                {model.worker.phone1 && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto" data-testid="text-worker-phone">
                      {model.worker.phone1}
                    </span>
                  </div>
                )}
                {model.worker.dateJoined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto">Joined {model.formatDate(model.worker.dateJoined)}</span>
                  </div>
                )}
                {model.worker.salaryType && (
                  <div className="flex items-center gap-2 text-sm">
                    <DollarSign className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto">
                      {model.worker.salaryType} — {fmt(model.worker.baseSalary)}
                    </span>
                  </div>
                )}
              </div>

              {model.canChangeExistingRecords && (
                <div className="border-t pt-3 space-y-2">
                  <input
                    type="file"
                    accept="image/*"
                    ref={model.fileInputRef}
                    className="hidden"
                    onChange={model.handlePhotoUpload}
                    data-testid="input-photo-upload"
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => model.fileInputRef.current?.click()}
                    data-testid="button-upload-photo"
                  >
                    <Upload className="h-3.5 w-3.5 mr-2" />
                    Upload Photo
                  </Button>
                  {model.worker.active ? (
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={model.openEndContract}
                      data-testid="button-end-contract"
                    >
                      <UserX className="h-3.5 w-3.5 mr-2" />
                      End Contract
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full text-green-600 border-green-600"
                      onClick={() =>
                        model.wrapAdminAction(() => model.reactivateMutation.mutate(), "Reactivate Worker")
                      }
                      disabled={model.reactivateMutation.isPending}
                      data-testid="button-reactivate-worker"
                    >
                      <UserCheck className="h-3.5 w-3.5 mr-2" />
                      {model.reactivateMutation.isPending ? "Reactivating..." : "Reactivate Worker"}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {!model.statsLoading && model.stats && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-sm text-muted-foreground">Production Stats</CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-4 space-y-3">
                <div className="text-center">
                  <p className="text-2xl font-bold" data-testid="text-stat-bales">
                    {model.stats.totalBales}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Bales</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div>
                    <p className="font-semibold text-sm" data-testid="text-stat-kg">
                      {parseFloat(model.stats.totalKg).toFixed(1)}
                    </p>
                    <p className="text-xs text-muted-foreground">KG</p>
                  </div>
                  <div>
                    <p className="font-semibold text-sm" data-testid="text-stat-paid">
                      {fmt(model.stats.totalPaid)}
                    </p>
                    <p className="text-xs text-muted-foreground">Paid</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <FactoryWorkerDetailTabs model={model} tabs={tabs} infoRow={infoRow} worker={model.worker} />
      </div>

      <EndContractDialog
        cashAccounts={model.cashAccounts}
        endCalculating={model.endCalculating}
        endCashAccountId={model.endCashAccountId}
        endEnd={model.endEnd}
        endOpen={model.endOpen}
        endResult={model.endResult}
        endStart={model.endStart}
        endStep={model.endStep}
        endSubmitting={model.endSubmitting}
        handleCalculate={model.handleCalculate}
        handleEndContract={model.handleEndContract}
        handleSkipAndEnd={model.handleSkipAndEnd}
        payrollBalance={model.payrollBalance}
        setEndCashAccountId={model.setEndCashAccountId}
        setEndEnd={model.setEndEnd}
        setEndOpen={model.setEndOpen}
        setEndResult={model.setEndResult}
        setEndStart={model.setEndStart}
        setEndStep={model.setEndStep}
        worker={model.worker}
      />

      {/* Fix Accounting Dialog */}
      <GenerateMissingAccountingEntryDialog
        cashAccounts={model.cashAccounts}
        fixAcctCashId={model.fixAcctCashId}
        fixAcctMutation={model.fixAcctMutation}
        fixAcctOpen={model.fixAcctOpen}
        fixAcctTargetId={model.fixAcctTargetId}
        setFixAcctCashId={model.setFixAcctCashId}
        setFixAcctOpen={model.setFixAcctOpen}
        setFixAcctTargetId={model.setFixAcctTargetId}
        wrapAdminAction={model.wrapAdminAction}
      />

      <MarkPayrollPaidDialog
        cashAccounts={model.cashAccounts}
        markPaidMutation={model.markPaidMutation}
        payCashAccountId={model.payCashAccountId}
        payOpen={model.payOpen}
        payTargetId={model.payTargetId}
        setPayCashAccountId={model.setPayCashAccountId}
        setPayOpen={model.setPayOpen}
        setPayTargetId={model.setPayTargetId}
        wrapAdminAction={model.wrapAdminAction}
      />

      {/* Image Viewer Dialog */}
      <DocumentPreviewDialog setViewingDoc={model.setViewingDoc} viewingDoc={model.viewingDoc} />

      {/* Delete Document Confirmation */}
      <Dialog
        open={model.pendingDeleteDocId !== null}
        onOpenChange={(open) => {
          if (!open) model.setPendingDeleteDocId(null);
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
              onClick={() => model.setPendingDeleteDocId(null)}
              disabled={model.deleteDocMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={model.deleteDocMutation.isPending}
              onClick={() =>
                model.wrapAdminAction(() => {
                  if (model.pendingDeleteDocId !== null) {
                    model.deleteDocMutation.mutate(model.pendingDeleteDocId);
                    model.setPendingDeleteDocId(null);
                  }
                }, "Delete Document")
              }
              data-testid="button-confirm-delete-doc"
            >
              {model.deleteDocMutation.isPending ? "Deleting..." : "Delete Document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Payroll Detail Dialog */}
      <PayrollDetailDialog
        detailPayrollId={model.detailPayrollId}
        payrollDetail={model.payrollDetail}
        payrollDetailLoading={model.payrollDetailLoading}
        setDetailPayrollId={model.setDetailPayrollId}
      />

      {model.AdminDialog}
    </div>
  );
}
