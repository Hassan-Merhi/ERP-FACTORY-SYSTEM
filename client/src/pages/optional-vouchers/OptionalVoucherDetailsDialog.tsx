import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { apiRequest } from "@/lib/queryClient";
import { companyDataKey, frontendQueryPolicies } from "@/lib/frontendDataArchitecture";
import type { AuthMe } from "@shared/apiTypes";
import { VoucherDetailsDialog } from "../daybook/VoucherDetailsDialog";
import type {
  BankAccount,
  DaybookViewEntriesResponse,
  Employee,
  LedgerAccount,
  ViewVoucherEntry,
  Voucher,
} from "../daybook/types";
import {
  entryBalanceUrl,
  selectBalanceDisplayEntries,
  selectCashAccountId,
} from "../daybook/voucherBalanceSelection";

interface OptionalVoucherDetailsDialogProps {
  voucher: Voucher | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (voucher: Voucher) => void;
}

export function OptionalVoucherDetailsDialog({
  voucher,
  open,
  onOpenChange,
  onEdit,
}: OptionalVoucherDetailsDialogProps) {
  const { selectedCompany } = useCompany();
  const { formatHistoricalBaseAmount: formatAmount } = useCurrencyContext();
  const { formatDisplayDate, formatDisplayTime } = useDateFormat();
  const [, navigate] = useLocation();
  const [selectedDialogRow, setSelectedDialogRow] = useState<number | null>(null);
  const [viewProfitFilter, setViewProfitFilter] = useState<"all" | "gain" | "loss" | "even">("all");
  const [cashAccountBalance, setCashAccountBalance] = useState("0");
  const [entryBalances, setEntryBalances] = useState<Record<number, string>>({});

  const { data: currentUser } = useQuery<AuthMe>({
    queryKey: ["/api/auth/me"],
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyDataKey("/api/ledger-accounts", selectedCompany?.id),
    enabled: open && !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });

  const { data: bankAccounts = [] } = useQuery<BankAccount[]>({
    queryKey: companyDataKey("/api/bank-accounts", selectedCompany?.id),
    enabled: open && !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: companyDataKey("/api/employees", selectedCompany?.id),
    enabled: open && !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });

  const viewEntriesUrl = voucher ? `/api/vouchers/${voucher.id}/view-entries` : "";
  const { data: viewVoucherEntriesRaw, isLoading: viewEntriesLoading } = useQuery<DaybookViewEntriesResponse>({
    queryKey: voucher ? companyDataKey(viewEntriesUrl, selectedCompany?.id, "optional-voucher-view-entries") : [],
    enabled: open && !!voucher,
    ...frontendQueryPolicies.live,
  });

  const viewVoucherEntries: ViewVoucherEntry[] = useMemo(() => {
    if (!viewVoucherEntriesRaw) return [];
    return Array.isArray(viewVoucherEntriesRaw) ? viewVoucherEntriesRaw : viewVoucherEntriesRaw.entries || [];
  }, [viewVoucherEntriesRaw]);

  const purchaseOrderData = useMemo(() => {
    if (!viewVoucherEntriesRaw || Array.isArray(viewVoucherEntriesRaw)) return null;
    return viewVoucherEntriesRaw.purchaseOrder ?? null;
  }, [viewVoucherEntriesRaw]);

  const isStockTransferVoucher = !!(
    voucher &&
    (voucher.voucherType === "Stock Transfer" ||
      voucher.voucherType === "StockTransfer" ||
      voucher.voucherType === "Transfer")
  );

  const {
    data: voucherRevisions = [],
    isLoading: revisionsLoading,
    isError: revisionsError,
    error: revisionsErrorDetail,
    refetch: retryVoucherRevisions,
  } = useQuery({
    queryKey:
      voucher && isStockTransferVoucher && open
        ? companyDataKey(
            `/api/stock-transfers/by-voucher/${voucher.id}/revisions`,
            selectedCompany?.id,
            "optional-voucher-transfer-revisions"
          )
        : [],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/stock-transfers/by-voucher/${voucher!.id}/revisions`);
      if (!response.ok) throw new Error("Could not load revision history");
      const data = await response.json();
      return Array.isArray(data) ? data : (data?.revisions ?? []);
    },
    enabled: open && !!voucher && isStockTransferVoucher,
    retry: 1,
  });

  const { data: poSupplierBalance = null } = useQuery<string | null>({
    queryKey: purchaseOrderData?.supplierId
      ? companyDataKey(
          `/api/suppliers/${purchaseOrderData.supplierId}/balance`,
          selectedCompany?.id,
          "optional-voucher-po-supplier-balance"
        )
      : [],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/suppliers/${purchaseOrderData!.supplierId}/balance`);
      if (!response.ok) return null;
      const data = await response.json();
      return data?.balance?.toString() ?? null;
    },
    enabled: open && !!purchaseOrderData?.supplierId,
    ...frontendQueryPolicies.live,
  });

  const cashAccountId = useMemo(
    () => selectCashAccountId(voucher, viewVoucherEntries),
    [voucher, viewVoucherEntries]
  );

  useEffect(() => {
    setCashAccountBalance("0");
    setEntryBalances({});
    setSelectedDialogRow(null);
    setViewProfitFilter("all");
  }, [voucher?.id, open]);

  useEffect(() => {
    if (!open || !cashAccountId) return;
    fetch(`/api/accounts/ledger/${cashAccountId}/balance`, {
      credentials: "include",
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setCashAccountBalance(data?.balance?.toString() || "0"))
      .catch(() => {});
  }, [cashAccountId, open]);

  useEffect(() => {
    if (!open || !voucher) {
      setEntryBalances({});
      return;
    }

    const displayEntries = selectBalanceDisplayEntries(voucher.voucherType, viewVoucherEntries);
    const results: Record<number, string> = {};

    Promise.all(
      displayEntries.map(async (entry) => {
        const url = entryBalanceUrl(entry);
        if (!url) return;
        try {
          const response = await fetch(url, {
            credentials: "include",
            cache: "no-store",
          });
          if (response.ok) {
            const data = await response.json();
            results[entry.id] = data.balance?.toString() || "0";
          }
        } catch {
          // Balance lookups are supplementary; voucher details still render without them.
        }
      })
    ).then(() => setEntryBalances(results));
  }, [open, voucher, viewVoucherEntries]);

  return (
    <VoucherDetailsDialog
      open={open}
      onOpenChange={onOpenChange}
      selectedVoucher={voucher}
      viewEntriesLoading={viewEntriesLoading}
      viewVoucherEntries={viewVoucherEntries}
      isStockTransferVoucher={isStockTransferVoucher}
      voucherRevisions={voucherRevisions}
      revisionsLoading={revisionsLoading}
      revisionsError={revisionsError}
      revisionsErrorMessage={revisionsErrorDetail instanceof Error ? revisionsErrorDetail.message : undefined}
      retryVoucherRevisions={() => void retryVoucherRevisions()}
      formatAmount={formatAmount}
      formatDisplayDate={formatDisplayDate}
      formatDisplayTime={formatDisplayTime}
      cashAccountBalance={cashAccountBalance}
      entryBalances={entryBalances}
      purchaseOrderData={purchaseOrderData}
      poSupplierBalance={poSupplierBalance}
      selectedDialogRow={selectedDialogRow}
      setSelectedDialogRow={setSelectedDialogRow}
      viewProfitFilter={viewProfitFilter}
      setViewProfitFilter={setViewProfitFilter}
      user={currentUser}
      handleEdit={onEdit}
      canEdit={() => true}
      navigate={navigate}
      employees={employees}
      ledgerAccounts={ledgerAccounts}
      bankAccounts={bankAccounts}
    />
  );
}
