import { useQuery } from "@tanstack/react-query";

/**
 * The approved company USD/ZMW rate effective on the SALE DATE.
 *
 * Zambia posting never uses the browser's current rate for an earlier sale
 * date, and an edited sale keeps the voucher's locked rate instead (the query
 * is disabled while editing). Cash and credit sales share this lookup.
 */
export function usePosZmwSaleRate(input: {
  companyId: number | undefined;
  displayCurrency: string | null;
  saleDate: string;
  editVoucherId: string | number | undefined;
}) {
  const { companyId, displayCurrency, saleDate, editVoucherId } = input;
  const { data, isFetching } = useQuery<{ rate: string } | null>({
    queryKey: ["/api/exchange-rates/latest", companyId, "USD", "ZMW", saleDate],
    queryFn: async () => {
      const query = new URLSearchParams({
        companyId: String(companyId),
        fromCurrency: "USD",
        toCurrency: "ZMW",
        asOf: saleDate,
      });
      const response = await fetch("/api/exchange-rates/latest?" + query, { credentials: "include" });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!companyId && displayCurrency === "ZMW" && !!saleDate && !editVoucherId,
    staleTime: 0,
  });
  return { datedZmwRate: data, isFetchingDatedZmwRate: isFetching };
}
