// Extracted from ./factoryPressingReportRoutes.ts to keep that module under the source-size cap.
import { pool } from "../../db";
import type { PressingReportFilters } from "@shared/pressingReportContracts";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";
import {
  PRESSING_LOCAL_DATE_SQL,
  conditions,
  statusPredicate,
  type QueryCtx,
} from "./factoryPressingReportRoutesConditions";

export async function report(ctx: QueryCtx, filters: PressingReportFilters) {
  // Freeze all pages and summary at a server-derived cutoff, not the phone clock.
  const asOf = filters.asOf ?? new Date().toISOString();
  filters = { ...filters, asOf };
  const { args, where } = conditions(ctx, filters);
  const currentStatus = statusPredicate(filters.status);
  if (currentStatus) where.push(currentStatus);
  const from = " FROM factory_pressing_confirmations c WHERE " + where.join(" AND ");
  const detail = [
    "c.id",
    'c.reference_number AS "referenceNumber"',
    'c.article_code AS "articleCode"',
    'c.product_name AS "productName"',
    'c.weight_kg AS "weightKg"',
    'c.machine_id AS "machineId"',
    'c.machine_name_snapshot AS "machineName"',
    'c.user_id AS "operatorUserId"',
    'c.user_name_snapshot AS "operatorName"',
    'c.shift_id AS "shiftId"',
    PRESSING_LOCAL_DATE_SQL + '::text AS "productionDate"',
    'c.confirmed_at AS "confirmedAt"',
    'c.device_captured_at AS "deviceCapturedAt"',
    'c.voided_at AS "voidedAt"',
    "'" + PRESSING_TIME_ZONE + '\' AS "timezoneName"',
    "(c.voided_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM factory_pressing_confirmations active " +
      "WHERE active.company_id = c.company_id AND active.bale_id = c.bale_id " +
      'AND active.voided_at IS NULL)) AS "canReturn"',
    // Previous accepted bale on the same machine is independent of current
    // date/employee/article filters; voided confirmations are excluded.
    "(SELECT FLOOR(EXTRACT(EPOCH FROM (c.confirmed_at - p.confirmed_at)))::bigint " +
      "FROM factory_pressing_confirmations p WHERE p.company_id = c.company_id " +
      "AND p.machine_id = c.machine_id AND p.voided_at IS NULL " +
      "AND (p.confirmed_at,p.id) < (c.confirmed_at,c.id) " +
      'ORDER BY p.confirmed_at DESC,p.id DESC LIMIT 1) AS "secondsSincePrevious"',
  ].join(", ");
  const condensed = [
    PRESSING_LOCAL_DATE_SQL + '::text AS "productionDate"',
    'c.machine_id AS "machineId"',
    'MAX(c.machine_name_snapshot) AS "machineName"',
    'c.user_id AS "operatorUserId"',
    'MAX(c.user_name_snapshot) AS "operatorName"',
    'c.shift_id AS "shiftId"',
    'c.article_code AS "articleCode"',
    'c.product_name AS "productName"',
    "'" + PRESSING_TIME_ZONE + '\' AS "timezoneName"',
    '(c.voided_at IS NOT NULL) AS "voided"',
    'COUNT(*)::integer AS "bales"',
    'COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS "weightKg"',
    'MIN(c.confirmed_at) AS "firstScanAt"',
    'MAX(c.confirmed_at) AS "lastScanAt"',
  ].join(", ");
  // Keep distinct bale names separate, even when they share an article code.
  const group =
    " GROUP BY " +
    PRESSING_LOCAL_DATE_SQL +
    ",c.machine_id,c.user_id,c.shift_id,c.article_code,c.product_name,(c.voided_at IS NOT NULL)";
  const detailed = filters.mode === "detailed";
  const selectSql = detailed
    ? "SELECT " + detail + from + " ORDER BY c.confirmed_at DESC,c.id DESC"
    : "SELECT " +
      condensed +
      from +
      group +
      " ORDER BY " +
      PRESSING_LOCAL_DATE_SQL +
      " DESC,c.machine_id,c.user_id,c.product_name NULLS LAST,c.article_code NULLS LAST," +
      "c.shift_id NULLS LAST,(c.voided_at IS NOT NULL) ASC";
  const countSql = detailed
    ? "SELECT COUNT(*)::integer AS total" + from
    : "SELECT COUNT(*)::integer AS total FROM (SELECT 1" + from + group + ") t";
  const pageArgs = [...args, filters.limit, (filters.page - 1) * filters.limit];
  const sqlPage = selectSql + " LIMIT $" + (args.length + 1) + " OFFSET $" + (args.length + 2);

  // Production KPIs count only non-voided records even when the history
  // filter displays voided audit rows.
  const sumConditions = conditions(ctx, filters);
  const sumSqlFor = (where: string[]) =>
    'SELECT COUNT(*) FILTER (WHERE c.voided_at IS NULL)::integer AS "totalBales",' +
    'COALESCE(SUM(c.weight_kg) FILTER (WHERE c.voided_at IS NULL),0)::numeric(18,3) AS "totalKg",' +
    'COUNT(*) FILTER (WHERE c.voided_at IS NOT NULL)::integer AS "voidedBales"' +
    " FROM factory_pressing_confirmations c WHERE " +
    where.join(" AND ");
  // Always aggregate server-side across all matching records, never the 50
  // current groups on screen. Voided confirmations do not inflate the KPIs.
  const byOperatorSqlFor = (where: string[]) =>
    'SELECT c.user_id AS "userId",' +
    'MAX(c.user_name_snapshot) AS "name",' +
    'COUNT(*)::integer AS "totalBales",' +
    'COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS "totalKg"' +
    " FROM factory_pressing_confirmations c WHERE " +
    where.join(" AND ") +
    " AND c.voided_at IS NULL GROUP BY c.user_id ORDER BY c.user_id";
  const sumSql = sumSqlFor(sumConditions.where);
  const perOperatorSql = byOperatorSqlFor(sumConditions.where);
  const [rows, count, summary, byOperator] = await Promise.all([
    pool.query(sqlPage, pageArgs),
    pool.query(countSql, args),
    pool.query(sumSql, sumConditions.args),
    pool.query(perOperatorSql, sumConditions.args),
  ]);
  const filteredSummary = {
    ...(summary.rows[0] ?? { totalBales: 0, totalKg: "0", voidedBales: 0 }),
    byOperator: byOperator.rows,
  };
  // Filtering the table to P2 should not make P1/P3 or ALL WORKERS show
  // zero. Keep the dashboard across all operators for the selected date,
  // barcode, status and KG, while the history/export obey userId.
  let overview = filteredSummary;
  if (ctx.supervisor && filters.userId) {
    const allConditions = conditions(ctx, { ...filters, userId: undefined });
    const [allSummary, allOperators] = await Promise.all([
      pool.query(sumSqlFor(allConditions.where), allConditions.args),
      pool.query(byOperatorSqlFor(allConditions.where), allConditions.args),
    ]);
    overview = {
      ...(allSummary.rows[0] ?? { totalBales: 0, totalKg: "0", voidedBales: 0 }),
      byOperator: allOperators.rows,
    };
  }
  // Resolve current company-scoped display names for every historical row and
  // summary, so renamed workers are shown correctly without rewriting evidence.
  const operatorIds = [
    ...new Set<string>(
      [
        ...rows.rows.map((row) => row.operatorUserId),
        ...filteredSummary.byOperator.map((row: { userId: string }) => row.userId),
        ...overview.byOperator.map((row: { userId: string }) => row.userId),
      ].filter((value): value is string => typeof value === "string" && value.length > 0)
    ),
  ];
  const profiles = operatorIds.length
    ? await pool.query(
        'SELECT user_id AS "userId", NULLIF(BTRIM(display_name), \'\') AS "displayName" ' +
          "FROM factory_user_profiles WHERE company_id = $1 AND user_id = ANY($2::varchar[])",
        [ctx.companyId, operatorIds]
      )
    : { rows: [] };
  const names = new Map<string, string>(profiles.rows.map((row) => [row.userId, String(row.displayName || "").trim()]));
  const displayName = (id: string) => names.get(id) || "Display name not set";
  return {
    rows: rows.rows.map((row) => ({ ...row, operatorName: displayName(row.operatorUserId) })),
    total: Number(count.rows[0]?.total || 0),
    summary: {
      ...filteredSummary,
      byOperator: filteredSummary.byOperator.map((row: { userId: string }) => ({
        ...row,
        name: displayName(row.userId),
      })),
    },
    overview: {
      ...overview,
      byOperator: overview.byOperator.map((row: { userId: string }) => ({
        ...row,
        name: displayName(row.userId),
      })),
    },
    page: filters.page,
    limit: filters.limit,
    mode: filters.mode,
    asOf,
  };
}
