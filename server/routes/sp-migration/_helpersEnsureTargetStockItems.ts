// Extracted from ./_helpers.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { pn, trackRow } from "./_helpersEnsureSpAccounts";

// ── Stock master migration (creates REAL target-company stock_items, never reuses source IDs) ──
export async function ensureTargetStockItems(
  sourceId: number,
  targetId: number,
  runId: string
): Promise<{
  map: Map<number, number>;
  groupsCreated: number;
  gradesCreated: number;
  categoriesCreated: number;
  itemsCreated: number;
  itemsReused: number;
}> {
  const map = new Map<number, number>();
  let groupsCreated = 0;
  let gradesCreated = 0;
  let categoriesCreated = 0;
  let itemsCreated = 0;
  let itemsReused = 0;

  // 1. Stock groups — mirror by code
  const groupMap = new Map<number, number>();
  const sourceGroups = (
    await db.execute(sql`
    SELECT id, code, name FROM stock_groups WHERE company_id = ${sourceId} AND deleted_at IS NULL
  `)
  ).rows;
  for (const g of sourceGroups) {
    const existingGroup = (
      await db.execute(sql`
      SELECT id FROM stock_groups WHERE company_id = ${targetId} AND code = ${g.code} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];
    if (existingGroup) {
      groupMap.set(pn(g.id), pn(existingGroup.id));
    } else {
      const [row] = (
        await db.execute(sql`
        INSERT INTO stock_groups (company_id, code, name, active)
        VALUES (${targetId}, ${g.code}, ${g.name}, true)
        RETURNING id
      `)
      ).rows;
      const newGroupId = pn(row.id);
      groupMap.set(pn(g.id), newGroupId);
      await trackRow(runId, "stock_groups", newGroupId);
      await db.execute(sql`
        INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
        VALUES (${runId}, 'stock_groups', ${pn(g.id)}, 'stock_groups', ${newGroupId})
      `);
      groupsCreated++;
    }
  }

  // 1b. Stock grades / categories — mirror by name (both tables are simple name+active lookups)
  const gradeMap = new Map<number, number>();
  const sourceGrades = // Mirror ALL grades referenced by source items with positive inventory (not just active ones) so
    // grade_id on a migrated item never silently drops to null just because the grade was deactivated.
    (
      await db.execute(sql`
      SELECT DISTINCT g.id, g.name FROM stock_grades g
      WHERE g.company_id = ${sourceId}
        AND (g.active = true OR g.id IN (
          SELECT si.grade_id FROM stock_items si
          JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
          WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0 AND si.grade_id IS NOT NULL
        ))
    `)
    ).rows;
  for (const g of sourceGrades) {
    const existingGrade = (
      await db.execute(sql`SELECT id FROM stock_grades WHERE company_id = ${targetId} AND name = ${g.name} LIMIT 1`)
    ).rows[0];
    if (existingGrade) {
      gradeMap.set(pn(g.id), pn(existingGrade.id));
    } else {
      const [row] = (
        await db.execute(
          sql`INSERT INTO stock_grades (company_id, name, active) VALUES (${targetId}, ${g.name}, true) RETURNING id`
        )
      ).rows;
      const newGradeId = pn(row.id);
      gradeMap.set(pn(g.id), newGradeId);
      await trackRow(runId, "stock_grades", newGradeId);
      gradesCreated++;
    }
  }

  const categoryMap = new Map<number, number>();
  const sourceCategories =
    // Same rationale as grades above — include inactive categories still referenced by migratable items.
    (
      await db.execute(sql`
      SELECT DISTINCT c.id, c.name FROM stock_categories c
      WHERE c.company_id = ${sourceId}
        AND (c.active = true OR c.id IN (
          SELECT si.category_id FROM stock_items si
          JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
          WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0 AND si.category_id IS NOT NULL
        ))
    `)
    ).rows;
  for (const c of sourceCategories) {
    const existingCategory = (
      await db.execute(sql`SELECT id FROM stock_categories WHERE company_id = ${targetId} AND name = ${c.name} LIMIT 1`)
    ).rows[0];
    if (existingCategory) {
      categoryMap.set(pn(c.id), pn(existingCategory.id));
    } else {
      const [row] = (
        await db.execute(
          sql`INSERT INTO stock_categories (company_id, name, active) VALUES (${targetId}, ${c.name}, true) RETURNING id`
        )
      ).rows;
      const newCategoryId = pn(row.id);
      categoryMap.set(pn(c.id), newCategoryId);
      await trackRow(runId, "stock_categories", newCategoryId);
      categoriesCreated++;
    }
  }

  // 2. Stock items with positive inventory in source
  const sourceItems = (
    await db.execute(sql`
    SELECT si.id, si.code, si.name, si.uom, si.stock_group_id, si.grade_id, si.category_id,
           si.opening_qty, si.opening_rate, si.opening_value, si.reorder_level, si.selling_price, si.active
    FROM stock_items si
    JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
    WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0
    ORDER BY si.code
  `)
  ).rows;

  for (const item of sourceItems) {
    const srcId = pn(item.id);

    // Already linked by a prior run?
    const priorLink = (
      await db.execute(sql`
      SELECT target_id FROM sp_migration_source_links
      WHERE source_table = 'stock_items' AND source_id = ${srcId} AND target_table = 'stock_items'
      LIMIT 1
    `)
    ).rows[0];
    if (priorLink) {
      // Verify it still exists in target (defensive — should always be true)
      const stillExists = (
        await db.execute(sql`
        SELECT id FROM stock_items WHERE id = ${pn(priorLink.target_id)} AND company_id = ${targetId} AND deleted_at IS NULL LIMIT 1
      `)
      ).rows[0];
      if (stillExists) {
        map.set(srcId, pn(priorLink.target_id));
        itemsReused++;
        continue;
      }
    }

    // Fall back to matching by code (handles manual pre-existing target items)
    const existingByCode = (
      await db.execute(sql`
      SELECT id FROM stock_items WHERE company_id = ${targetId} AND code = ${item.code} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];

    let targetItemId: number;
    if (existingByCode) {
      targetItemId = pn(existingByCode.id);
      itemsReused++;
    } else {
      const targetGroupId = item.stock_group_id ? (groupMap.get(pn(item.stock_group_id)) ?? null) : null;
      const targetGradeId = item.grade_id ? (gradeMap.get(pn(item.grade_id)) ?? null) : null;
      const targetCategoryId = item.category_id ? (categoryMap.get(pn(item.category_id)) ?? null) : null;
      const [row] = (
        await db.execute(sql`
        INSERT INTO stock_items
          (company_id, code, name, uom, stock_group_id, grade_id, category_id,
           opening_qty, opening_rate, opening_value, reorder_level, selling_price, active)
        VALUES
          (${targetId}, ${item.code}, ${item.name}, ${item.uom}, ${targetGroupId}, ${targetGradeId}, ${targetCategoryId},
           ${item.opening_qty ?? "0"}, ${item.opening_rate ?? "0"}, ${item.opening_value ?? "0"},
           ${item.reorder_level ?? "0"}, ${item.selling_price ?? "0"}, ${item.active ?? true})
        RETURNING id
      `)
      ).rows;
      targetItemId = pn(row.id);
      await trackRow(runId, "stock_items", targetItemId);
      itemsCreated++;
    }

    await db.execute(sql`
      INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
      VALUES (${runId}, 'stock_items', ${srcId}, 'stock_items', ${targetItemId})
    `);
    map.set(srcId, targetItemId);
  }

  return { map, groupsCreated, gradesCreated, categoriesCreated, itemsCreated, itemsReused };
}
