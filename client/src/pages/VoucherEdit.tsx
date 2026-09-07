import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { ArrowLeft } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

// Sub-components
import { focusByTestId } from "./voucher-edit/VoucherEditHelpers";
import { PaymentReceiptEditForm } from "./voucher-edit/PaymentReceiptEditForm";
import { JournalEditForm } from "./voucher-edit/JournalEditForm";
import { PurchaseEditForm } from "./voucher-edit/PurchaseEditForm";
import { AdjustmentEditForm } from "./voucher-edit/AdjustmentEditForm";
import { TransferEditForm } from "./voucher-edit/TransferEditForm";
import { SalesEditForm } from "./voucher-edit/SalesEditForm";

// Hooks
import { useVoucherEditQueries } from "./voucher-edit/useVoucherEditQueries";
import { useVoucherEditMutations } from "./voucher-edit/useVoucherEditMutations";
import { useVoucherEditState } from "./voucher-edit/useVoucherEditState";

type GoldenCoastEditReadiness = {
  parentCompanyId?: number | null;
  code?: string;
  message?: string;
};

export default function VoucherEdit() {
  const { formatDisplayDate } = useDateFormat();
  const { id } = useParams<{ id: string }>();
  const [_location, navigate] = useLocation();
  const handleBack = useBackToParent();
  const { selectedCompany } = useCompany();
  const { selectedCurrency, formatAmount, exchangeRate } = useCurrencyContext();
  const appMode = useAppMode();
  const modePrefix = useModePrefix();
  const modeApiRequest = getApiRequest(appMode);
  const isSpCompany = selectedCompany?.companyType === "supplier_partner";

  const { data: goldenCoastReadiness } = useQuery<GoldenCoastEditReadiness>({
    queryKey: selectedCompany?.id
      ? ["/api/sp/golden-coast/phase6/pos-sale/readiness", selectedCompany.id]
      : [],
    enabled: !!isSpCompany && !!selectedCompany?.id,
    retry: false,
    queryFn: async () => {
      const response = await fetch("/api/sp/golden-coast/phase6/pos-sale/readiness", {
        credentials: "include",
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409 && body?.code === "GC_PHASE6_NOT_CONFIGURED") {
        return { parentCompanyId: null };
      }
      if (!response.ok) {
        throw new Error(body?.message || response.statusText);
      }
      return body;
    },
  });

  useEscapeBack(() => navigate(`${modePrefix}/vouchers`));

  const {
    voucher,
    voucherLoading,
    voucherError,
    bankAccounts,
    ledgerAccounts,
    suppliers,
    stockItems,
    locations,
    allAccountsData,
  } = useVoucherEditQueries({ id, selectedCompanyId: selectedCompany?.id });

  const voucherType = voucher?.voucherType;
  const isPaymentOrReceipt = voucherType === "Payment" || voucherType === "Receipt";
  const isJournal = voucherType === "Journal";
  const isPurchase = voucherType === "Purchase";
  const isSales = voucherType === "Sales";
  const isConsumption = voucherType === "Consumption" || voucherType === "Production" || voucherType === "Mixed";
  const isStockTransfer = voucherType === "Stock Transfer";

  useEffect(() => {
    if (isSales && id) {
      navigate(`/pos/edit/${id}`);
    }
  }, [isSales, id, navigate]);

  const { paymentForm, journalForm, salesForm, purchaseForm, adjustmentForm, transferForm, allAccountsWithBalances } =
    useVoucherEditState({
      voucher,
      voucherType,
      isPaymentOrReceipt,
      selectedCurrency,
      ledgerAccounts,
      bankAccounts,
      suppliers,
      allAccountsData,
      exchangeRate: exchangeRate ?? 1,
      id,
    });

  const {
    updateMutation,
    toggleOptionalMutation,
    updateSalesMutation,
    updatePurchaseMutation,
    updateAdjustmentMutation,
    updateTransferMutation,
    onSubmitPaymentReceipt,
    onSubmitJournal,
  } = useVoucherEditMutations({
    id,
    modeApiRequest,
    voucherType,
    exchangeRate: exchangeRate ?? 1,
    handleBack,
    modePrefix,
    goldenCoastParentCompanyId: goldenCoastReadiness?.parentCompanyId ?? null,
  });

  if (voucherLoading)
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  if (voucherError || !voucher)
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => handleBack()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <PageHeader title="Edit Voucher" />
        </div>
        <div className="text-center py-8">Voucher not found</div>
      </div>
    );

  const paymentTotal = isPaymentOrReceipt
    ? paymentForm.watch("entries").reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0)
    : 0;
  const journalDRTotal = isJournal
    ? journalForm
        .watch("entries")
        .filter((e) => e.type === "DR")
        .reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0)
    : 0;
  const journalCRTotal = isJournal
    ? journalForm
        .watch("entries")
        .filter((e) => e.type === "CR")
        .reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0)
    : 0;

  const renderForm = () => {
    if (isPaymentOrReceipt)
      return (
        <PaymentReceiptEditForm
          form={paymentForm}
          voucherType={voucherType!}
          onSubmit={onSubmitPaymentReceipt}
          onCancel={handleBack}
          isPending={updateMutation.isPending}
          allAccountsWithBalances={allAccountsWithBalances}
          formatDisplayDate={formatDisplayDate}
          formatAmount={formatAmount}
          total={paymentTotal}
          focusByTestId={focusByTestId}
        />
      );
    if (isJournal)
      return (
        <JournalEditForm
          form={journalForm}
          onSubmit={onSubmitJournal}
          onCancel={handleBack}
          isPending={updateMutation.isPending}
          allAccountsWithBalances={allAccountsWithBalances}
          formatDisplayDate={formatDisplayDate}
          formatAmount={formatAmount}
          drTotal={journalDRTotal}
          crTotal={journalCRTotal}
          focusByTestId={focusByTestId}
        />
      );
    if (isPurchase)
      return (
        <PurchaseEditForm
          form={purchaseForm}
          voucher={voucher}
          onSubmit={updatePurchaseMutation.mutate}
          onCancel={handleBack}
          onToggleOptional={toggleOptionalMutation.mutate}
          isPending={updatePurchaseMutation.isPending}
          isTogglingOptional={toggleOptionalMutation.isPending}
          stockItems={stockItems}
          formatDisplayDate={formatDisplayDate}
          formatAmount={formatAmount}
          grandTotal={purchaseForm
            .watch("items")
            .reduce((sum, item) => sum + (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0), 0)}
        />
      );
    if (isSales)
      return (
        <SalesEditForm
          form={salesForm}
          voucher={voucher}
          onSubmit={updateSalesMutation.mutate}
          onCancel={handleBack}
          onToggleOptional={toggleOptionalMutation.mutate}
          isPending={updateSalesMutation.isPending}
          isTogglingOptional={toggleOptionalMutation.isPending}
          stockItems={stockItems}
          locations={locations}
          formatDisplayDate={formatDisplayDate}
          formatAmount={formatAmount}
          grandTotal={salesForm
            .watch("items")
            .reduce((sum, item) => sum + (parseFloat(item.quantity) || 0) * (parseFloat(item.sellingPrice) || 0), 0)}
        />
      );
    if (isConsumption)
      return (
        <AdjustmentEditForm
          form={adjustmentForm}
          voucher={voucher}
          onSubmit={updateAdjustmentMutation.mutate}
          onCancel={handleBack}
          onToggleOptional={toggleOptionalMutation.mutate}
          isPending={updateAdjustmentMutation.isPending}
          isTogglingOptional={toggleOptionalMutation.isPending}
          stockItems={stockItems}
          locations={locations}
          formatDisplayDate={formatDisplayDate}
          formatAmount={formatAmount}
          grandTotal={adjustmentForm
            .watch("items")
            .reduce((sum, item) => sum + (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0), 0)}
          voucherType={voucherType!}
        />
      );
    if (isStockTransfer)
      return (
        <TransferEditForm
          form={transferForm}
          voucher={voucher}
          onSubmit={updateTransferMutation.mutate}
          onCancel={handleBack}
          onToggleOptional={toggleOptionalMutation.mutate}
          isPending={updateTransferMutation.isPending}
          isTogglingOptional={toggleOptionalMutation.isPending}
          stockItems={stockItems}
          locations={locations}
          formatDisplayDate={formatDisplayDate}
          formatAmount={formatAmount}
          grandTotal={transferForm
            .watch("items")
            .reduce((sum, item) => sum + (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0), 0)}
        />
      );
    return <div className="text-center py-8">Unsupported Voucher Type: {voucherType}</div>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => handleBack()} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl md:text-3xl font-bold" data-testid="text-page-title">
            Edit {voucherType} Voucher
          </h1>
          <p className="text-muted-foreground mt-1">Voucher #{voucher.voucherNumber}</p>
        </div>
      </div>
      {renderForm()}
    </div>
  );
}
