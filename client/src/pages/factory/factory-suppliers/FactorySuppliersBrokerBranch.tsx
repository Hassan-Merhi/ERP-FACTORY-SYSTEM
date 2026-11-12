import { AssignContainersDialog } from "./AssignContainersDialog";
import { BrokerOverviewPanel } from "./BrokerOverviewPanel";
import { FactorySuppliersDialogBundle } from "./FactorySuppliersDialogBundle";
import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

type SuppliersModel = ReturnType<typeof useFactorySuppliersModel>;

export function FactorySuppliersBrokerBranch({ model }: { model: SuppliersModel }) {
  if (!model.parentViewSupplierId) return null;
  return (
    <>
      <BrokerOverviewPanel
        parentViewSupplierId={model.parentViewSupplierId}
        allSuppliers={model.allSuppliers}
        subAccountsByParent={model.subAccountsByParent}
        brokerOverviewStatement={model.brokerOverviewStatement}
        brokerOverviewLoading={model.brokerOverviewLoading}
        brokerIncludeOtw={model.brokerIncludeOtw}
        setBrokerIncludeOtw={model.setBrokerIncludeOtw}
        setParentViewSupplierId={model.setParentViewSupplierId}
        openChildStatement={(id) => {
          model.setStatementSupplierId(id);
          model.setStatementReturnToParent(true);
        }}
        openPaymentDialog={(supplier) => {
          model.setPaymentDialogSupplier(supplier);
          model.setPaymentForm((previous) => ({ ...previous, supplierId: supplier.id }));
        }}
        openFxConversionDialog={(supplier, currencyCode, balance) => {
          const toId = supplier.parentId || supplier.id;
          const balanceString = balance.toFixed(2);
          model.setFxConversionForm({
            fromSupplierId: supplier.id,
            toSupplierId: toId,
            selectedCurrency: currencyCode,
            amount: balanceString,
            availableBalance: balanceString,
            supplierBalance: balanceString,
            commissionBalance: "0",
            fxRateToUsd: "",
            date: model.today,
            notes: "",
            effectiveDate: "",
          });
          model.setFxSourceType("supplier");
          model.setFxConversionOpen(true);
        }}
        formatNum={model.formatNum}
        formatDate={model.formatDate}
        directContainers={model.directContainers}
        directContainersLoading={model.directContainersLoading}
        onAddLinkedSupplier={() => {
          model.setCreateSubAccountParentId(model.parentViewSupplierId);
          model.resetForm(model.parentViewSupplierId);
          model.setCreateOpen(true);
        }}
        onAssignContainersTo={(supplierId, supplierName) =>
          model.setAssignTarget({ id: supplierId, name: supplierName })
        }
        canAddLinkedSupplier={model.canCreateSupplier}
        canChangeExistingRecords={model.canChangeExistingRecords}
        canRecordFxTransfer={model.canRecordFxTransfer}
        canRecordPayment={model.canRecordSupplierPayment}
      />
      <AssignContainersDialog
        open={!!model.assignTarget}
        onClose={() => model.setAssignTarget(null)}
        linkedSupplier={model.assignTarget}
        containers={model.directContainers}
        onAssign={(containerIds) => {
          if (model.assignTarget)
            model.assignContainersMutation.mutate({ containerIds, targetSupplierId: model.assignTarget.id });
        }}
        isPending={model.assignContainersMutation.isPending}
      />
      <FactorySuppliersDialogBundle model={model} />
    </>
  );
}
