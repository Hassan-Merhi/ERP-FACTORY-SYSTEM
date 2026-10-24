/**
 * Cross-company All Daybook feed. Like the company Daybook, this is a display
 * union of posted vouchers and container offload events. An offload is NOT a
 * voucher and must not create accounting entries or inflate journal debits.
 *
 * The union happens before counting/pagination, so dates, filters and page
 * totals represent the same rows as the table. Negative IDs are display-only
 * identifiers for offloads; positive IDs continue to identify vouchers.
 */
import { pool } from "../../db";
import { normalizeSearchText } from "@shared/searchNormalization";

type JournalInput = {
  targetCompanyIds: number[];
  startDate?: string;
  endDate?: string;
  voucherType?: string;
  currency?: string;
  optional?: string;
  search?: string;
  page: number;
  limit: number;
};

export async function getGlobalDaybookFeed(input: JournalInput) {
  const {
    targetCompanyIds, startDate, endDate, voucherType, currency,
    optional, search, page, limit,
  } = input;

  const values: unknown[] = [targetCompanyIds];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const voucherWhere: string[] = [
    "v.company_id = ANY($1::integer[])",
    "v.deleted_at IS NULL",
  ];
  const offloadWhere: string[] = ["c.company_id = ANY($1::integer[])"];

  if (startDate) {
    const placeholder = bind(startDate);
    voucherWhere.push(`v.voucher_date >= ${placeholder}::date`);
    offloadWhere.push(`co.offloaded_at >= ${placeholder}::date`);
  }
  if (endDate) {
    const placeholder = bind(endDate);
    voucherWhere.push(`v.voucher_date <= ${placeholder}::date`);
    offloadWhere.push(`co.offloaded_at < (${placeholder}::date + INTERVAL '1 day')`);
  }
  if (voucherType && voucherType !== "all") {
    if (voucherType === "Offload") {
      voucherWhere.push("FALSE");
    } else if (voucherType === "Stock Transfer" || voucherType === "StockTransfer") {
      voucherWhere.push("v.voucher_type IN ('Stock Transfer', 'StockTransfer')");
      offloadWhere.push("FALSE");
    } else {
      voucherWhere.push(`v.voucher_type = ${bind(voucherType)}`);
      offloadWhere.push("FALSE");
    }
  }
  if (currency && currency !== "all") {
    voucherWhere.push(`v.currency = ${bind(currency)}`);
    if (currency !== "USD") offloadWhere.push("FALSE");
  }
  if (optional === "active") {
    voucherWhere.push("v.optional = FALSE");
    offloadWhere.push("co.optional = FALSE");
  } else if (optional === "optional") {
    voucherWhere.push("v.optional = TRUE");
    offloadWhere.push("co.optional = TRUE");
  }
  if (search?.trim()) {
    const pattern = bind(`%${search.trim()}%`);
    const compactPattern = bind(`%${normalizeSearchText(search.trim())}%`);
    voucherWhere.push(`(
      v.voucher_number ILIKE ${pattern} OR v.description ILIKE ${pattern}
      OR REGEXP_REPLACE(LOWER(COALESCE(v.voucher_number,'')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
      OR REGEXP_REPLACE(LOWER(COALESCE(v.description,'')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
      OR EXISTS (
        SELECT 1 FROM voucher_entries ve_search WHERE ve_search.voucher_id = v.id
        AND (ve_search.narration ILIKE ${pattern}
          OR REGEXP_REPLACE(LOWER(COALESCE(ve_search.narration,'')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern})
      )
    )`);
    offloadWhere.push(`(
      c.container_number ILIKE ${pattern} OR l.name ILIKE ${pattern}
      OR REGEXP_REPLACE(LOWER(COALESCE(c.container_number,'')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
      OR REGEXP_REPLACE(LOWER(COALESCE(l.name,'')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
    )`);
  }

  // Internal Supplier Partner operational reversals are not user-facing
  // Daybook transactions (the normal /api/daybook feed also excludes these).
  voucherWhere.push(
    "v.voucher_number NOT LIKE 'SP-OTW-REV-%'",
    "v.voucher_number NOT LIKE 'SP-STOCK-%'",
    "v.voucher_number NOT LIKE 'SP-OPNSTK-%'",
  );

  const cte = `
    WITH combined AS (
      SELECT
        v.id::integer AS id,
        'voucher'::text AS "entryType",
        NULL::integer AS "offloadId",
        NULL::integer AS "containerId",
        v.company_id AS "companyId",
        comp.name::text AS "companyName",
        v.voucher_number::text AS "voucherNumber",
        v.voucher_type::text AS "voucherType",
        v.voucher_date::date AS "voucherDate",
        v.total_amount::text AS "totalAmount",
        v.currency::text AS currency,
        v.optional AS optional,
        v.description::text AS description,
        v.deleted_at AS "deletedAt",
        (
          SELECT ve.narration FROM voucher_entries ve
          WHERE ve.voucher_id = v.id
            AND ve.narration IS NOT NULL AND ve.narration != ''
          ORDER BY ve.id LIMIT 1
        )::text AS narration
      FROM vouchers v
      INNER JOIN companies comp ON comp.id = v.company_id
      WHERE ${voucherWhere.join(" AND ")}
      UNION ALL
      SELECT
        (-co.id)::integer AS id,
        'offload'::text AS "entryType",
        co.id AS "offloadId",
        co.container_id AS "containerId",
        c.company_id AS "companyId",
        comp.name::text AS "companyName",
        ('OFFLOAD-' || co.id)::text AS "voucherNumber",
        'Offload'::text AS "voucherType",
        co.offloaded_at::date AS "voucherDate",
        COALESCE((
          SELECT SUM(coi.total_value) FROM container_offload_items coi
          WHERE coi.offload_id = co.id
        ), 0)::text AS "totalAmount",
        'USD'::text AS currency,
        co.optional AS optional,
        (c.container_number ||
          CASE WHEN l.name IS NOT NULL AND l.name <> '' THEN ' — ' || l.name ELSE '' END)::text AS description,
        NULL::timestamp AS "deletedAt",
        NULL::text AS narration
      FROM container_offloads co
      INNER JOIN containers c ON c.id = co.container_id
      INNER JOIN companies comp ON comp.id = c.company_id
      LEFT JOIN locations l ON l.id = co.location_id
      WHERE ${offloadWhere.join(" AND ")}
    )`;

  const pageValues = [...values, limit, (page - 1) * limit];
  const pageSql = `${cte}
    SELECT * FROM combined
    ORDER BY "companyName" ASC, "voucherDate" DESC, id DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
  const [pageResult, countResult, summaryResult] = await Promise.all([
    pool.query(pageSql, pageValues),
    pool.query(`${cte} SELECT COUNT(*)::integer AS total FROM combined`, values),
    pool.query(`${cte}
      SELECT
        j."companyId" AS "companyId",
        j."companyName" AS "companyName",
        j.currency AS currency,
        COUNT(DISTINCT (j."entryType", j.id))::integer AS "voucherCount",
        COALESCE(SUM(CASE WHEN ve.debit_amount > 0 THEN ve.debit_amount ELSE 0 END), 0)::text AS "totalDebits",
        COALESCE(SUM(CASE WHEN ve.credit_amount > 0 THEN ve.credit_amount ELSE 0 END), 0)::text AS "totalCredits"
      FROM combined j
      LEFT JOIN voucher_entries ve
        ON j."entryType" = 'voucher' AND ve.voucher_id = j.id
      GROUP BY j."companyId", j."companyName", j.currency
      ORDER BY j."companyName"`, values),
  ]);

  const total = Number(countResult.rows[0]?.total ?? 0);
  return {
    vouchers: pageResult.rows,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    summary: summaryResult.rows,
  };
}
