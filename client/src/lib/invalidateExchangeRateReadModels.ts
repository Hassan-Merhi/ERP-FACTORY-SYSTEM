/**
 * Both the Settings form and the daily popup save to the same backend route.
 * After a committed save they must refresh the same rate-dependent reads.
 * Historical voucher values remain immutable: no mutations to query data or
 * voucher payloads are made here.
 */
import type { QueryClient } from "@tanstack/react-query";
import { isFxRateDependentQuery } from "@shared/fxRateQueryInvalidation";
import { queryClient } from "./queryClient";
import { invalidateBandwidthReadCaches } from "./bandwidthInvalidationPolicy";

export async function invalidateExchangeRateReadModels(
  savedCompanyId: number,
  client: QueryClient = queryClient
): Promise<void> {
  if (!Number.isSafeInteger(savedCompanyId) || savedCompanyId <= 0) return;
  // Drop cached API response bodies first. Otherwise React Query may refetch
  // and still receive the previous rate's account/customer payload.
  invalidateBandwidthReadCaches("all");
  await client.invalidateQueries({
    predicate: (query) => isFxRateDependentQuery(query.queryKey, savedCompanyId),
    // Mounted rate cards and current monetary reports refetch immediately;
    // inactive cached queries remain stale until reopened.
    refetchType: "active",
  });
}
