// Extracted from ./spMigrationPhase4RoutesFinalizeCutover.ts
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { pn } from "./spMigrationPhase2Common";
import { firstRow } from "../../lib/queryResult";
import { type TargetLiveActivity } from "./phase4WriteGuard";

export async function targetLiveActivity(targetId: number, activatedAt?: string | null): Promise<TargetLiveActivity> {
  const vouchers = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM vouchers v
    WHERE v.company_id = ${targetId}
      AND v.deleted_at IS NULL
      AND v.created_at > ${activatedAt}
      AND COALESCE(v.source_module, 'ERP') NOT IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY')
      AND v.voucher_number NOT LIKE ${`OB-${targetId}-%`}
      AND v.voucher_number NOT LIKE 'GC-PROFIT-OPN-%'
  `
      : sql`
    SELECT COUNT(*)::int AS count FROM vouchers v
    WHERE v.company_id = ${targetId}
      AND v.deleted_at IS NULL
      AND COALESCE(v.source_module, 'ERP') NOT IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY')
      AND v.voucher_number NOT LIKE ${`OB-${targetId}-%`}
      AND v.voucher_number NOT LIKE 'GC-PROFIT-OPN-%'
  `
  );
  const sales = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_sales s
    WHERE s.company_id = ${targetId} AND s.created_at > ${activatedAt}
  `
      : sql`SELECT COUNT(*)::int AS count FROM sp_sales s WHERE s.company_id = ${targetId}`
  );
  const offloads = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_offloads o
    WHERE o.company_id = ${targetId} AND o.created_at > ${activatedAt}
  `
      : sql`SELECT COUNT(*)::int AS count FROM sp_offloads o WHERE o.company_id = ${targetId}`
  );
  const prepaid = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_prepaid_charges p
    WHERE p.company_id = ${targetId} AND p.created_at > ${activatedAt}
  `
      : sql`SELECT COUNT(*)::int AS count FROM sp_prepaid_charges p WHERE p.company_id = ${targetId}`
  );
  const containers = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_containers c
    WHERE c.company_id = ${targetId}
      AND c.created_at > ${activatedAt}
      AND COALESCE(c.notes, '') NOT ILIKE '%migrated from%erp container%'
  `
      : sql`
    SELECT COUNT(*)::int AS count FROM sp_containers c
    WHERE c.company_id = ${targetId}
      AND COALESCE(c.notes, '') NOT ILIKE '%migrated from%erp container%'
  `
  );
  const counts = {
    vouchers: pn(firstRow(vouchers)?.count),
    sales: pn(firstRow(sales)?.count),
    offloads: pn(firstRow(offloads)?.count),
    prepaid: pn(firstRow(prepaid)?.count),
    containers: pn(firstRow(containers)?.count),
  };
  return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}
