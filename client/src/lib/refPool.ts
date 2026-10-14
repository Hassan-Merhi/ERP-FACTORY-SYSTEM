import { db } from "./db";
import { apiRequest } from "./queryClient";

const POOL_MIN_SIZE = 50;
const POOL_FETCH_SIZE = 200;

let _replenishing = false;

export async function getAvailableCount(): Promise<number> {
  try {
    return await db.refPool.where("status").equals("available").count();
  } catch {
    return 0;
  }
}

export async function replenishPool(count = POOL_FETCH_SIZE): Promise<void> {
  if (_replenishing) return;
  _replenishing = true;
  try {
    const res = await apiRequest("POST", "/api/bale-label-prints/allocate-pool", { count });
    if (!res.ok) return;
    const { refs } = (await res.json()) as { refs: string[] };
    if (!refs?.length) return;
    const now = Date.now();
    await db.refPool.bulkAdd(
      refs.map((r) => ({
        referenceNumber: r,
        status: "available" as const,
        allocatedAt: now,
        usedAt: null,
      }))
    );
  } catch {
    // Non-critical — offline pool top-up fails silently
  } finally {
    _replenishing = false;
  }
}

export async function ensurePoolReady(): Promise<void> {
  try {
    const available = await getAvailableCount();
    if (available < POOL_MIN_SIZE) {
      await replenishPool(POOL_FETCH_SIZE);
    }
  } catch {
    // Non-critical
  }
}
