import type { QueryClient } from "@tanstack/react-query";
import { companyQueryKey } from "@/lib/companyQueryScope";

import { fetchAllStockEntryHistoryPages } from "./utils";
import type { BaleDetail, GroupRow } from "./types";

interface GroupBaleQueryResult {
  data?: BaleDetail[];
  isLoading: boolean;
}

interface CreateGroupBaleHelpersInput {
  useLite: boolean;
  expandedGroupBaleKeys: string[];
  groupBaleQueries: GroupBaleQueryResult[];
  queryClient: QueryClient;
  params: URLSearchParams;
  companyId: number | string | null | undefined;
}

export function groupKey(group: GroupRow) {
  return `${group.stockEntryDate}|${group.erpLocationId}|${group.workerId}|${group.productId}`;
}

export function createStockEntryHistoryGroupBaleHelpers({
  useLite,
  expandedGroupBaleKeys,
  groupBaleQueries,
  queryClient,
  params,
  companyId,
}: CreateGroupBaleHelpersInput) {
  function getGroupBales(group: GroupRow): BaleDetail[] {
    if (!useLite) return group.bales;
    const key = groupKey(group) + "-bales";
    const index = expandedGroupBaleKeys.indexOf(key);
    if (index < 0) return [];
    return groupBaleQueries[index]?.data ?? [];
  }

  async function resolveGroupBaleIds(group: GroupRow): Promise<number[]> {
    const cached = getGroupBales(group);
    if (cached.length > 0) return cached.map((bale) => bale.id);
    if (!useLite) return group.bales.map((bale) => bale.id);

    const groupParams = new URLSearchParams();
    groupParams.set("startDate", group.stockEntryDate);
    groupParams.set("endDate", group.stockEntryDate);
    if (group.workerId) groupParams.set("workerId", String(group.workerId));
    if (group.productId) groupParams.set("productId", String(group.productId));
    if (group.erpLocationId) groupParams.set("locationId", String(group.erpLocationId));

    const activeStatus = params.get("status");
    const activeSearch = params.get("search");
    if (activeStatus) groupParams.set("status", activeStatus);
    if (activeSearch) groupParams.set("search", activeSearch);

    const rows = await queryClient.fetchQuery<GroupRow[]>({
      queryKey: companyQueryKey("/api/factory/bales/stock-entry-history/group", companyId, groupParams.toString()),
      queryFn: () => fetchAllStockEntryHistoryPages(groupParams),
      staleTime: 5 * 60 * 1000,
    });
    return rows.flatMap((row) => row.bales ?? []).map((bale) => bale.id);
  }

  function isGroupBalesLoading(group: GroupRow): boolean {
    if (!useLite) return false;
    const key = groupKey(group) + "-bales";
    const index = expandedGroupBaleKeys.indexOf(key);
    if (index < 0) return false;
    return groupBaleQueries[index]?.isLoading ?? false;
  }

  async function fetchGroupsWithBales(): Promise<GroupRow[]> {
    const fullParams = new URLSearchParams(params);
    fullParams.delete("lite");
    fullParams.delete("page");
    fullParams.delete("limit");
    return fetchAllStockEntryHistoryPages(fullParams);
  }

  return { getGroupBales, resolveGroupBaleIds, isGroupBalesLoading, fetchGroupsWithBales };
}
