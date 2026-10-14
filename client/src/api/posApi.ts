import { queryClient } from "@/lib/queryClient";

export function posDraftsUrl(locationId: number): string {
  return `/api/pos/drafts?locationId=${locationId}`;
}

interface DraftSummaryItem {
  quantity?: string | number;
  amount?: string | number;
}

interface DraftSummarySource {
  id?: number | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
}

interface PosDraftSummary {
  id: number;
  location_id: number;
  locationId: number;
  created_at: string;
  createdAt: string;
  updated_at: string;
  updatedAt: string;
  item_count: number;
  itemCount: number;
  total_qty: number;
  totalQty: number;
  total_amount: number;
  totalAmount: number;
}

/**
 * Keep the lightweight draft-list cache current after save/autosave without
 * downloading the whole list again. Draft details are still fetched by id when
 * the user explicitly opens a draft.
 */
export function upsertPosDraftSummary(
  locationId: number | null | undefined,
  draft: DraftSummarySource,
  items: DraftSummaryItem[] = []
): void {
  if (!locationId || typeof draft.id !== "number") return;
  const itemCount = items.length;
  const totalQty = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const totalAmount = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const now = new Date().toISOString();
  const summary: PosDraftSummary = {
    id: draft.id,
    location_id: locationId,
    locationId,
    created_at: draft.created_at ?? draft.createdAt ?? now,
    createdAt: draft.createdAt ?? draft.created_at ?? now,
    updated_at: draft.updated_at ?? draft.updatedAt ?? now,
    updatedAt: draft.updatedAt ?? draft.updated_at ?? now,
    item_count: itemCount,
    itemCount,
    total_qty: totalQty,
    totalQty,
    total_amount: totalAmount,
    totalAmount,
  };

  queryClient.setQueryData<PosDraftSummary[]>([posDraftsUrl(locationId)], (current) => {
    const rows = Array.isArray(current) ? current : [];
    return [summary, ...rows.filter((row) => row.id !== draft.id)];
  });
}

export function removePosDraftSummary(locationId: number | null | undefined, draftId: number): void {
  if (!locationId) return;
  queryClient.setQueryData<PosDraftSummary[]>([posDraftsUrl(locationId)], (current) =>
    Array.isArray(current) ? current.filter((row) => row.id !== draftId) : []
  );
}
