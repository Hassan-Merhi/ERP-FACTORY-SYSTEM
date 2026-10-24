import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

/**
 * Company/date-scoped USD/ZMW posting rate. Unlike daily currency-display
 * context, this query is keyed to the voucher's own financial date.
 */
export function useZmwVoucherRate(voucherDate: string | null | undefined) {
  const { selectedCompany } = useCompany();
  const { displayCurrency } = useCurrencyContext();
  const isZmw = displayCurrency === "ZMW";
  const companyId = selectedCompany?.id;
  const { data, isFetching, isError } = useQuery<{ rate: string } | null>({
    queryKey: ["/api/exchange-rates/latest", companyId, "USD", "ZMW", voucherDate, "voucher-entry"],
    queryFn: async () => {
      const query = new URLSearchParams({
        companyId: String(companyId),
        fromCurrency: "USD",
        toCurrency: "ZMW",
        asOf: voucherDate!,
      });
      const response = await fetch("/api/exchange-rates/latest?" + query.toString(), { credentials: "include" });
      if (!response.ok) throw new Error("No approved company/date USD/ZMW rate available");
      return response.json();
    },
    enabled: isZmw && !!companyId && !!voucherDate,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const rate = Number(data?.rate);
  return {
    isZmw,
    rate: isZmw && !isFetching && !isError && data && Number.isFinite(rate) && rate > 0 ? rate : null,
    unavailable: isZmw && (!!isError || (!isFetching && !data)),
    isFetching,
  };
}
