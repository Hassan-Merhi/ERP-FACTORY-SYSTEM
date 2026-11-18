// Extracted from ./ViewEntryModal.tsx: state, queries and handlers for ViewEntryModal.
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { companyDataKey } from "@/lib/frontendDataArchitecture";
import {
  FACTORY_BALANCE_VOUCHER_TYPES,
  fetchFactoryVoucherCurrentBalances,
  type FactoryVoucherCurrentBalances,
} from "./entry-views/voucherBalances";
import type {
  ContainerDetail,
  ContainerImportDetail,
  LoadingOrder,
  MixBatchDetail,
  MixBatchSource,
  PayrollSummary,
  SupplierBalance,
  VoucherViewEntry,
} from "./entry-views/types";
import { apiNumber } from "./entry-views/types";
import { parseBalesMeta, currencySymbol, getFactoryTxTypeBadge } from "./daybookUtils";
import type { ViewEntryModalProps } from "./ViewEntryModal";
import { NO_VIEW_ENTRIES } from "./ViewEntryModal";

export function useViewEntryModalModel({ entry }: { entry: ViewEntryModalProps["entry"] }) {
  const { selectedCompany } = useCompany();
  const { formatHistoricalBaseAmount: formatCurrentLedgerBalance } = useCurrencyContext();
  const isVoucherBacked = entry.referenceTable === "vouchers" && !!entry.referenceId;
  const isBaleStockEntry = entry.txType === "BALE_STOCK_ENTRY";
  const isBaleRemoval = entry.txType === "BALE_REMOVAL";
  const hasBalesMeta = isBaleStockEntry || isBaleRemoval;
  const isContainerImport = entry.txType === "CONTAINER_IMPORT" && !!entry.referenceId;
  const isPayrollPayment = entry.txType === "PAYROLL_PAYMENT" && !!entry.referenceId;
  const isMixBatchCreated =
    (entry.txType === "MIX_BATCH_CREATED" || entry.txType === "MIX_BATCH_TOPUP") && !!entry.referenceId;
  const isLoadingCreated = entry.txType === "LOADING_CREATED" && !!entry.referenceId;
  const isOffloadRawStock = entry.txType === "OFFLOAD_RAW_STOCK";
  const isCommission = entry.txType === "COMMISSION";
  const isWasteDisposal = entry.txType === "WASTE_DISPOSAL";
  const isOtherCharge = entry.txType === "OTHER_CHARGE";

  const entryMeta = (() => {
    try {
      return JSON.parse(entry.metaJson || "{}");
    } catch {
      return {};
    }
  })();
  const metaContainerId: number | undefined = entryMeta.containerId;

  const { data: rawViewEntries } = useQuery<VoucherViewEntry[] | { entries?: VoucherViewEntry[] }>({
    queryKey: companyDataKey(
      `/api/vouchers/${entry.referenceId}/view-entries`,
      selectedCompany?.id,
      "factory-daybook-view"
    ),
    enabled: isVoucherBacked && !!entry.referenceId && !!selectedCompany?.id,
    // A voucher may have been revised since it was last viewed.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const viewEntries = Array.isArray(rawViewEntries) ? rawViewEntries : (rawViewEntries?.entries ?? NO_VIEW_ENTRIES);

  const { data: containerDetail } = useQuery<ContainerImportDetail>({
    queryKey: [`/api/factory/containers/${entry.referenceId}`],
    enabled: isContainerImport,
  });

  const { data: supplierBalance } = useQuery<SupplierBalance>({
    queryKey: [`/api/factory/suppliers/${containerDetail?.supplierId}/balance`],
    enabled: isContainerImport && !!containerDetail?.supplierId,
  });

  const { data: payrollSummary } = useQuery<PayrollSummary>({
    queryKey: [`/api/factory/payroll/${entry.referenceId}/summary`],
    enabled: isPayrollPayment,
  });

  const { data: mixBatchDetail } = useQuery<MixBatchDetail>({
    queryKey: [`/api/factory/mix-batches/${entry.referenceId}`],
    enabled: isMixBatchCreated,
  });

  const { data: mixBatchSources = [] } = useQuery<MixBatchSource[]>({
    queryKey: [`/api/factory/mix-batches/${entry.referenceId}/sources`],
    enabled: isMixBatchCreated,
  });

  const { data: loadingOrder } = useQuery<LoadingOrder>({
    queryKey: [`/api/factory/customer-orders/${entry.referenceId}`],
    enabled: isLoadingCreated,
    // Only while this detail dialog is open: keep scanned bales and totals live.
    refetchInterval: isLoadingCreated ? 2_500 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

  const { data: metaContainerDetail } = useQuery<ContainerDetail>({
    queryKey: [`/api/factory/containers/${metaContainerId}`],
    enabled: (isOffloadRawStock || isCommission) && !!metaContainerId,
  });

  const { data: otherChargeContainerDetail } = useQuery<ContainerDetail>({
    queryKey: [`/api/factory/containers/${entry.referenceId}`],
    enabled: isOtherCharge && !!entry.referenceId,
  });

  // Current posted account balances, shared with ERP Daybook's book-balance basis.
  // The company and voucher IDs are part of the query identity so switching
  // companies or vouchers never displays a balance from another selection.
  const isBalanceVoucher = FACTORY_BALANCE_VOUCHER_TYPES.has(entry.txType);
  const {
    data: currentBalances,
    isPending: currentBalancesPending,
    isFetching: currentBalancesFetching,
  } = useQuery<FactoryVoucherCurrentBalances>({
    queryKey: companyDataKey(
      `/api/factory/daybook/voucher-balances/${entry.referenceId}`,
      selectedCompany?.id,
      entry.txType,
      viewEntries.map((e) => [
        e.id,
        e.ledgerAccountId,
        e.bankAccountId,
        e.customerId,
        e.employeeId,
        e.supplierId,
        e.factorySupplierId,
        e.debitAmount,
        e.creditAmount,
      ])
    ),
    queryFn: ({ signal }) => fetchFactoryVoucherCurrentBalances(entry.txType, viewEntries, signal),
    enabled: isVoucherBacked && !!selectedCompany?.id && isBalanceVoucher && viewEntries.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const sourceBalance = currentBalances?.sourceBalance ?? null;
  const entryBalances = currentBalances?.entryBalances ?? {};
  const balancesLoading = isBalanceVoucher && (currentBalancesPending || currentBalancesFetching);
  const displayCurrentBalance = (balance: string | null | undefined) =>
    balancesLoading ? "Loading…" : balance == null ? "Unavailable" : formatCurrentLedgerBalance(balance);

  const bales = parseBalesMeta(entry);
  const amt = parseFloat(entry.amountCurrency || "0");
  const sym = currencySymbol(entry.currencyCode);

  const totalDebit = viewEntries.reduce((s, e) => s + apiNumber(e.debitAmount), 0);
  const totalCredit = viewEntries.reduce((s, e) => s + apiNumber(e.creditAmount), 0);

  const { variant: badgeVariant, className: badgeClass } = getFactoryTxTypeBadge(entry.txType);

  return {
    isVoucherBacked,
    isBaleStockEntry,
    isBaleRemoval,
    hasBalesMeta,
    isContainerImport,
    isPayrollPayment,
    isMixBatchCreated,
    isLoadingCreated,
    isOffloadRawStock,
    isCommission,
    isWasteDisposal,
    isOtherCharge,
    metaContainerId,
    viewEntries,
    containerDetail,
    supplierBalance,
    payrollSummary,
    mixBatchDetail,
    mixBatchSources,
    loadingOrder,
    metaContainerDetail,
    otherChargeContainerDetail,
    sourceBalance,
    entryBalances,
    displayCurrentBalance,
    bales,
    amt,
    sym,
    totalDebit,
    totalCredit,
    badgeVariant,
    badgeClass,
  };
}

export type ViewEntryModalModel = ReturnType<typeof useViewEntryModalModel>;
