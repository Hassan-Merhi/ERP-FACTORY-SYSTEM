import { useQuery } from "@tanstack/react-query";
import { stockItemKeys } from "@/lib/queryKeys";
import { unwrapAccountsResponse } from "@/lib/apiResponseAdapters";
import { VoucherData, BankAccount, LedgerAccount, Supplier, StockItem, Location } from "./VoucherEditHelpers";
import { AccountWithBalance } from "./VoucherAccountHelpers";

interface UseVoucherEditQueriesOptions {
  id: string | undefined;
  selectedCompanyId: number | undefined;
}

export function useVoucherEditQueries({ id, selectedCompanyId }: UseVoucherEditQueriesOptions) {
  const {
    data: voucher,
    isLoading: voucherLoading,
    error: voucherError,
  } = useQuery<VoucherData>({
    queryKey: [`/api/vouchers/${id}`],
    enabled: !!id,
  });

  const { data: bankAccounts = [] } = useQuery<BankAccount[]>({
    queryKey: ["/api/bank-accounts"],
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?profile=voucher-picker"],
  });

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers"],
  });

  // Voucher edit only consumes id/code/name/uom. Keep the real profile URL as
  // queryKey[0] so the shared queryFn fetches the compact contract and all
  // voucher edit instances reuse the same company-scoped cache entry.
  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: stockItemKeys.identity(selectedCompanyId),
    enabled: !!selectedCompanyId,
    staleTime: 30 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: allAccountsData = [] } = useQuery<
    AccountWithBalance[] | { accounts?: AccountWithBalance[] },
    Error,
    AccountWithBalance[]
  >({
    queryKey: ["/api/accounts/all", selectedCompanyId],
    enabled: !!selectedCompanyId,
    select: unwrapAccountsResponse<AccountWithBalance>,
  });

  return {
    voucher,
    voucherLoading,
    voucherError,
    bankAccounts,
    ledgerAccounts,
    suppliers,
    stockItems,
    locations,
    allAccountsData,
  };
}
