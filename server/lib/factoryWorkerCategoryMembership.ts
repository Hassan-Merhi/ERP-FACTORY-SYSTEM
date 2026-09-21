import type { Database } from "../db";
import { and, eq, inArray } from "drizzle-orm";
import { factoryWorkerCategories, factoryWorkers } from "@shared/schema";

export function normalizeFactoryWorkerIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function filterActiveFactoryWorkerIds(
  db: Database,
  companyId: number,
  workerIds: unknown
): Promise<number[]> {
  const ids = normalizeFactoryWorkerIds(workerIds);
  if (ids.length === 0) return [];

  const rows = await db
    .select({ id: factoryWorkers.id })
    .from(factoryWorkers)
    .where(
      and(
        eq(factoryWorkers.companyId, companyId),
        eq(factoryWorkers.active, true),
        inArray(factoryWorkers.id, ids)
      )
    );

  const activeIds = new Set(rows.map((row) => row.id));
  return ids.filter((id) => activeIds.has(id));
}

export async function removeFactoryWorkerFromCategories(
  db: Database,
  companyId: number,
  workerId: number
): Promise<void> {
  const categories = await db
    .select({ id: factoryWorkerCategories.id, workerIds: factoryWorkerCategories.workerIds })
    .from(factoryWorkerCategories)
    .where(eq(factoryWorkerCategories.companyId, companyId));

  for (const category of categories) {
    const ids = normalizeFactoryWorkerIds(category.workerIds);
    if (!ids.includes(workerId)) continue;

    await db
      .update(factoryWorkerCategories)
      .set({ workerIds: ids.filter((id) => id !== workerId) })
      .where(
        and(
          eq(factoryWorkerCategories.id, category.id),
          eq(factoryWorkerCategories.companyId, companyId)
        )
      );
  }
}

export async function pruneInactiveFactoryWorkerCategoryMembers(
  db: Database,
  companyId: number
): Promise<(typeof factoryWorkerCategories.$inferSelect)[]> {
  const categories = await db
    .select()
    .from(factoryWorkerCategories)
    .where(eq(factoryWorkerCategories.companyId, companyId))
    .orderBy(factoryWorkerCategories.name);

  const requestedIds = Array.from(
    new Set(categories.flatMap((category) => normalizeFactoryWorkerIds(category.workerIds)))
  );
  const activeIds =
    requestedIds.length > 0
      ? new Set(await filterActiveFactoryWorkerIds(db, companyId, requestedIds))
      : new Set<number>();

  const cleaned = [];
  for (const category of categories) {
    const originalIds = normalizeFactoryWorkerIds(category.workerIds);
    const workerIds = originalIds.filter((id) => activeIds.has(id));

    if (
      workerIds.length !== originalIds.length ||
      workerIds.some((id, index) => id !== originalIds[index])
    ) {
      await db
        .update(factoryWorkerCategories)
        .set({ workerIds })
        .where(
          and(
            eq(factoryWorkerCategories.id, category.id),
            eq(factoryWorkerCategories.companyId, companyId)
          )
        );
    }

    cleaned.push({ ...category, workerIds });
  }

  return cleaned;
}
