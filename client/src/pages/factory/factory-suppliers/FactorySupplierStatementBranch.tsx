import { Badge } from "@/components/ui/badge";
import { SupplierStatement } from "./SupplierStatement";
import { FactorySuppliersMoveContainerDialog } from "./FactorySuppliersMoveContainerDialog";
import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";
import type { StatementDisplayRow } from "./factorySupplierTypes";

type SuppliersModel = ReturnType<typeof useFactorySuppliersModel>;

interface VoucherPayment {
  id: number;
  currency?: string | null;
  debitAmount?: string | number | null;
  exchangeRate?: string | number | null;
  voucherDate: string;
  voucherNumber: string;
  description?: string | null;
  optional?: boolean | null;
}

function isVoucherPayment(value: unknown): value is VoucherPayment {
  return (
    typeof value === "object" && value !== null && "id" in value && "voucherDate" in value && "voucherNumber" in value
  );
}

export function FactorySupplierStatementBranch({ model }: { model: SuppliersModel }) {
  if (!model.statementSupplierId) return null;
  const rows = model.statementData?.statement || [];
  const payments = model.statementData?.payments || [];
  const voucherPayments = (model.statementData?.voucherPayments || []).filter(isVoucherPayment);
  const fxTransfers = model.statementData?.fxTransfers || [];
  const openingCommissions = model.statementData?.obCommissions || [];
  const allRows: StatementDisplayRow[] = [];

  for (const row of rows) {
    allRows.push({
      key: `c-${row.id}`,
      date: row.date,
      type: "purchase",
      ref: row.containerNumber,
      amount: model.formatNum(row.value),
      amountVal: parseFloat(row.value),
      rowCc: "USD",
      status: row.status,
      onMove: () =>
        model.setMoveContainerDialog({ open: true, containerId: row.id, containerRef: row.containerNumber }),
    });
  }

  for (const payment of payments) {
    allRows.push({
      key: `p-${payment.id}`,
      date: payment.date,
      type: "payment",
      ref:
        payment.currencyCode !== "USD"
          ? `Payment #${payment.id} (${payment.currencyCode} ${model.formatNum(payment.amount)} @ ${parseFloat(payment.fxRateToUsd).toFixed(4)})`
          : `Payment #${payment.id}`,
      detail: payment.notes || undefined,
      amount: model.formatNum(payment.amount),
      amountVal: parseFloat(payment.amountUsd),
      rowCc: "USD",
      onDelete: () => model.wrapAdminAction(() => model.deletePaymentMutation.mutate(payment.id), "Delete Payment"),
    });
  }

  for (const payment of voucherPayments) {
    const currency = payment.currency || "USD";
    const debitAmount = parseFloat(String(payment.debitAmount || "0"));
    const exchangeRate = parseFloat(String(payment.exchangeRate || "1")) || 1;
    const usdAmount = currency === "USD" ? debitAmount : debitAmount / exchangeRate;
    allRows.push({
      key: `vp-${payment.id}`,
      date: payment.voucherDate,
      type: "payment",
      ref:
        currency !== "USD"
          ? `${payment.voucherNumber} (${currency} ${model.formatNum(String(debitAmount))} @ ${exchangeRate.toFixed(4)})`
          : payment.voucherNumber,
      detail: payment.description || undefined,
      amount: model.formatNum(String(debitAmount)),
      amountVal: payment.optional ? 0 : usdAmount,
      rowCc: "USD",
      optional: !!payment.optional,
    });
  }

  for (const transfer of fxTransfers) {
    allRows.push({
      key: `f-${transfer.id}`,
      date: transfer.date,
      type: "fx",
      ref: "FX Settlement",
      detail: transfer.notes || undefined,
      amount: model.formatNum(transfer.toAmountUsd),
      amountVal: parseFloat(transfer.toAmountUsd),
      rowCc: "USD",
    });
  }

  for (const commission of openingCommissions) {
    allRows.push({
      key: `o-${commission.rawStockId}`,
      date: commission.date,
      type: "commission",
      ref: `OB: ${commission.containerNumber}`,
      amount: model.formatNum(commission.amount),
      amountVal: parseFloat(commission.amountUsd),
      rowCc: "USD",
      onEdit: () =>
        model.setEditObComm({
          rawStockId: commission.rawStockId,
          amount: commission.amount,
          currencyCode: commission.currencyCode,
          personName: commission.personName,
          notes: "",
        }),
      onDelete: () =>
        model.wrapAdminAction(
          () => model.deleteObCommissionMutation.mutate(commission.rawStockId),
          "Delete OB Commission"
        ),
    });
  }

  const sortedForBalance = [...allRows].sort(
    (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime()
  );
  let runningBalance = 0;
  const balanceByKey: Record<string, { bal: number; cc: string }> = {};
  for (const row of sortedForBalance) {
    if (row.type === "purchase" || row.type === "commission") runningBalance += row.amountVal;
    else if (row.type === "payment" || row.type === "fx") runningBalance -= row.amountVal;
    balanceByKey[row.key] = { bal: runningBalance, cc: "USD" };
  }

  const totalPurchases = allRows.filter((row) => row.type === "purchase").reduce((sum, row) => sum + row.amountVal, 0);
  const totalPayments = allRows.filter((row) => row.type === "payment").reduce((sum, row) => sum + row.amountVal, 0);
  const purchaseCount = allRows.filter((row) => row.type === "purchase").length;
  const yesterday = (() => {
    const date = new Date(model.today);
    date.setDate(date.getDate() - 1);
    return date.toLocaleDateString("en-CA");
  })();
  const filteredRows = allRows
    .filter((row) => {
      if (model.statDateFilter === "all") return true;
      const date = row.date?.slice(0, 10) ?? "";
      if (model.statDateFilter === "today") return date === model.today;
      if (model.statDateFilter === "yesterday") return date === yesterday;
      if (model.statDateFilter === "this_month") return date.slice(0, 7) === model.today.slice(0, 7);
      if (model.statDateFilter === "this_year") return date.slice(0, 4) === model.today.slice(0, 4);
      return true;
    })
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());

  const typeBadge = (type: string) => (
    <Badge variant="outline" className="text-[10px] uppercase font-bold">
      {type}
    </Badge>
  );

  return (
    <>
      <SupplierStatement
        statementSupplierId={model.statementSupplierId}
        statementData={model.statementData}
        statementLoading={model.statementLoading}
        statementError={model.statementError}
        supplierIncludeOtw={model.supplierIncludeOtw}
        setSupplierIncludeOtw={model.setSupplierIncludeOtw}
        collapsedStmtSections={model.collapsedStmtSections}
        toggleStmtSection={model.toggleStmtSection}
        isBrokerStatement={model.isBrokerStatement}
        statementReturnToParent={model.statementReturnToParent}
        setStatementSupplierId={model.setStatementSupplierId}
        setStatementReturnToParent={model.setStatementReturnToParent}
        openFxConversionDialog={(fromSupplierId, toSupplierId, currencyCode, amount, totalCommission) => {
          model.setFxConversionForm({
            fromSupplierId,
            toSupplierId,
            selectedCurrency: currencyCode,
            amount,
            availableBalance: amount,
            supplierBalance: amount,
            commissionBalance: totalCommission || "0",
            fxRateToUsd: "",
            date: model.today,
            notes: "",
            effectiveDate: "",
          });
          model.setFxConversionOpen(true);
        }}
        formatNum={model.formatNum}
        formatDate={model.formatDate}
        formatKg={model.formatKg}
        today={model.today}
        fxConversionOpen={model.fxConversionOpen}
        setFxConversionOpen={model.setFxConversionOpen}
        fxConversionForm={model.fxConversionForm}
        setFxConversionForm={model.setFxConversionForm}
        fxSourceType={model.fxSourceType}
        setFxSourceType={model.setFxSourceType}
        allSuppliers={model.allSuppliers}
        subAccountsByParent={model.subAccountsByParent}
        wrapAdminAction={model.wrapAdminAction}
        deleteFxTransferMutation={model.deleteFxTransferMutation}
        statDateFilter={model.statDateFilter}
        setStatDateFilter={model.setStatDateFilter}
        onEditPayment={() => {}}
        onDeletePayment={(id) => model.wrapAdminAction(() => model.deletePaymentMutation.mutate(id), "Delete Payment")}
        setEditObComm={model.setEditObComm}
        statusColor={model.statusColor}
        statusDisplayLabel={model.statusDisplayLabel}
        typeBadge={typeBadge}
        displayedRows={filteredRows}
        balanceByKey={balanceByKey}
        sfTotalPurchases={totalPurchases}
        sfTotalPayments={totalPayments}
        sfPurchasesQty={purchaseCount}
        sfTxCount={filteredRows.length}
        currencyTotals={{ USD: runningBalance }}
        primaryCc="USD"
        onRenameSupplier={(id, name) => model.renameSupplierMutation.mutate({ id, name })}
        onDeleteSupplier={(id) =>
          model.wrapAdminAction(() => {
            model.permanentDeleteMutation.mutate(id);
            model.setStatementSupplierId(null);
            if (model.statementReturnToParent) model.setStatementReturnToParent(false);
          }, "Delete Supplier")
        }
      />
      <FactorySuppliersMoveContainerDialog model={model} />
    </>
  );
}
