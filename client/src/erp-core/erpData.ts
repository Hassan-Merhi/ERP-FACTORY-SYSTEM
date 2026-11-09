import type { QueryClient } from "@tanstack/react-query";

import {
  canonicalApiUrl,
  companyDataKey,
  invalidateApiFamily,
  unwrapList,
  unwrapPage,
  type CompanyIdentity,
  type QueryParams,
} from "@/lib/frontendDataArchitecture";
import { companyKeys, referenceKeys, stockItemKeys } from "@/lib/queryKeys";

/**
 * ERP-mode adoption surface for existing request identity/response helpers.
 *
 * Do not move SQL, financial arithmetic, or security permissions into this
 * module. URL is first in every query key; company ID is second. This avoids
 * cached results leaking between companies, and lets the default queryFn fetch
 * the actual URL rather than a synthetic cache discriminator.
 */
export const erpDataKeys = companyKeys;
export const erpReferenceKeys = referenceKeys;
export const erpStockItemKeys = stockItemKeys;
export const erpRequestUrl = canonicalApiUrl;
export const erpCompanyDataKey = companyDataKey;
export const erpUnwrapList = unwrapList;
export const erpUnwrapPage = unwrapPage;
export type { CompanyIdentity as ErpCompanyIdentity, QueryParams as ErpQueryParams };

/**
 * One safe invalidation path for both legacy URL-first keys and newly scoped
 * URL-first keys, including filtered URLs with query parameters.
 *
 * This is invalidation only: data is never copied between company caches.
 * Backend events and authorization remain responsible for actual writes.
 */
export async function invalidateErpDataFamilies(
  queryClient: QueryClient,
  families: readonly string[],
): Promise<void> {
  await Promise.all([...new Set(families)].map((family) => invalidateApiFamily(queryClient, family)));
}

/** Type-level compile checks ensure this facade stays attached to real helpers. */
export type ErpCompanyId = CompanyIdentity;
export type ErpQueryParams = QueryParams;
