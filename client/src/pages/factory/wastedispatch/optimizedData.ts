import type { HistoryBale, WasteBale } from "./optimizedTypes";

export async function readWasteJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function groupBalesUrl(productId: number, search: string): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  const query = params.toString();
  return `/api/factory/waste-dispatch/group-bales/${productId}${query ? `?${query}` : ""}`;
}

export async function fetchGroupBales(productId: number, search: string): Promise<WasteBale[]> {
  const response = await readWasteJson<{ bales: WasteBale[] }>(groupBalesUrl(productId, search));
  return response.bales;
}

export async function fetchHistoryBales(dispatchId: number): Promise<HistoryBale[]> {
  const response = await readWasteJson<{ bales: HistoryBale[] }>(
    `/api/factory/waste-dispatch/history/${dispatchId}/bales`
  );
  return response.bales;
}

export function baleMatchesSearch(bale: WasteBale, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [bale.referenceNumber, bale.productName, bale.articleCode, bale.categoryName, bale.locationName].some(
    (value) =>
      String(value || "")
        .toLowerCase()
        .includes(needle)
  );
}
