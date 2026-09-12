import { pool } from "../../db";
import {
  ContinuousCursorError,
  continuousCursorScope,
  decodeContinuousCursor,
  encodeContinuousCursor,
} from "../../lib/continuousCursor";
import type {
  ContinuousStatementMeta,
  ContinuousWindow,
  DateContext,
  FactoryCustomerCursor,
  Pagination,
  StatementPage,
  StatementQueryResult,
} from "./_helpers";
import {
  buildContinuousResponse,
  buildPageResponse,
  continuousMeta,
  cursorDate,
  finiteNumber,
  isFactoryCustomerCursor,
  statementRowNet,
  summaryFromContinuousMeta,
} from "./_helpers";

export function factoryCustomerAllRowsCte(): string {
  return `all_rows AS (
    SELECT
      'co-' || co.id::text AS id,
      (-1000000 - co.id) AS "voucherId",
      COALESCE(co.invoice_number, 'INV-' || co.id::text) AS "voucherNumber",
      'Sales'::text AS "voucherType",
      co.order_date::date AS voucher_date,
      COALESCE('Invoice — ' || NULLIF(co.destination, ''), 'Invoice') AS "voucherDescription",
      COALESCE('Invoice — ' || NULLIF(co.destination, ''), 'Invoice') AS narration,
      COALESCE(co.grand_total, 0)::text AS "debitAmount",
      '0'::text AS "creditAmount",
      1 AS source_rank,
      co.id AS source_id
    FROM customer_orders co
    WHERE co.company_id = $1
      AND co.customer_id = $2
      AND co.status = 'FINALIZED'

    UNION ALL

    SELECT
      'cb-' || cb.id::text,
      (-2000000 - cb.id),
      CASE
        WHEN cb.reference_type IS NOT NULL
          THEN cb.reference_type || '-' || COALESCE(cb.reference_id, cb.id)::text
        ELSE 'CB-' || cb.id::text
      END,
      COALESCE(cb.transaction_type, 'Payment'),
      cb.transaction_date::date,
      COALESCE(cb.description, ''),
      COALESCE(cb.description, ''),
      COALESCE(cb.debit_amount, 0)::text,
      COALESCE(cb.credit_amount, 0)::text,
      2,
      cb.id
    FROM customer_balances cb
    WHERE cb.company_id = $1
      AND cb.customer_id = $2
      AND (cb.reference_type <> 'INVOICE' OR cb.reference_type IS NULL)

    UNION ALL

    SELECT
      've-' || ve.id::text,
      ve.voucher_id,
      COALESCE(v.voucher_number, ''),
      COALESCE(v.voucher_type, 'Voucher'),
      v.voucher_date::date,
      COALESCE(v.description, ''),
      COALESCE(NULLIF(ve.narration, ''), v.description, ''),
      COALESCE(ve.debit_amount, 0)::text,
      COALESCE(ve.credit_amount, 0)::text,
      3,
      ve.id
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE v.company_id = $1
      AND v.optional = false
      AND v.deleted_at IS NULL
      AND v.voucher_number NOT LIKE 'CHARGE-%'
      AND (
        ve.ledger_account_id = $3
        OR (ve.customer_id = $2 AND ve.ledger_account_id IS NULL)
      )
  )`;
}

export async function runFactoryCustomerLedgerStatement(options: {
  customerId: number;
  ledgerAccountId: number;
  companyId: number;
  pagination: Pagination;
  dates: DateContext;
  continuous?: ContinuousWindow;
}): Promise<StatementPage> {
  const { customerId, ledgerAccountId, companyId, pagination, dates, continuous } = options;
  const values: unknown[] = [companyId, customerId, ledgerAccountId, dates.effectiveEndDate];
  const filteredConditions = ["voucher_date <= $4::date"];
  if (dates.rawStart) {
    values.push(dates.rawStart);
    filteredConditions.push(`voucher_date >= $${values.length}::date`);
  }
  const allRows = factoryCustomerAllRowsCte();
  const cte = `${allRows},
    filtered AS (
      SELECT *, voucher_date::text AS "voucherDate"
      FROM all_rows
      WHERE ${filteredConditions.join(" AND ")}
    )`;
  const baseCount = values.length;
  const order = `voucher_date ASC, "voucherNumber" ASC, source_rank ASC, source_id ASC`;
  const summaryQuery = `WITH ${cte}
    SELECT
      COUNT(*)::int AS total,
      COALESCE(SUM("debitAmount"::numeric), 0)::text AS "debitTotal",
      COALESCE(SUM("creditAmount"::numeric), 0)::text AS "creditTotal"
    FROM filtered`;

  const loadPrePeriodNet = async (): Promise<number> => {
    if (!dates.rawStart) return 0;
    const preResult = await pool.query(
      `WITH ${allRows}
       SELECT COALESCE(
         SUM("debitAmount"::numeric - "creditAmount"::numeric),
         0
       )::text AS net
       FROM all_rows
       WHERE voucher_date < $4::date`,
      [companyId, customerId, ledgerAccountId, dates.rawStart]
    );
    return Number.parseFloat(preResult.rows[0]?.net || "0") || 0;
  };

  if (continuous) {
    const scope = continuousCursorScope("factory-customer-statement", {
      customerId,
      ledgerAccountId,
      companyId,
      startDate: dates.rawStart ?? null,
      endDate: dates.effectiveEndDate,
    });
    let cursor: FactoryCustomerCursor | null = null;
    if (continuous.token) {
      const decoded = decodeContinuousCursor<unknown>(scope, continuous.token);
      if (!isFactoryCustomerCursor(decoded)) throw new ContinuousCursorError();
      cursor = decoded;
    }
    const chunkValues = [...values];
    const bind = (value: unknown): string => {
      chunkValues.push(value);
      return `$${chunkValues.length}`;
    };
    let cursorCondition = "TRUE";
    if (cursor) {
      const dateParam = bind(cursor.sortDate);
      const voucherParam = bind(cursor.voucherNumber);
      const rankParam = bind(cursor.sourceRank);
      const sourceParam = bind(cursor.sourceId);
      cursorCondition = `(
        voucher_date > ${dateParam}::date OR
        (voucher_date = ${dateParam}::date AND (
          "voucherNumber" > ${voucherParam} OR
          ("voucherNumber" = ${voucherParam} AND (
            source_rank > ${rankParam} OR
            (source_rank = ${rankParam} AND source_id > ${sourceParam})
          ))
        ))
      )`;
    }
    const limitParam = bind(continuous.limit + 1);
    const chunkQuery = `WITH ${cte}
      SELECT * FROM filtered
      WHERE ${cursorCondition}
      ORDER BY ${order}
      LIMIT ${limitParam}`;

    let chunkResult: StatementQueryResult;
    let meta: ContinuousStatementMeta;
    if (cursor) {
      chunkResult = await pool.query(chunkQuery, chunkValues);
      meta = cursor.meta;
    } else {
      const [firstChunkResult, summaryResult, prePeriodNet] = await Promise.all([
        pool.query(chunkQuery, chunkValues),
        pool.query(summaryQuery, values),
        loadPrePeriodNet(),
      ]);
      chunkResult = firstChunkResult;
      meta = continuousMeta(summaryResult.rows[0], prePeriodNet);
    }

    const hasMore = chunkResult.rows.length > continuous.limit;
    const visibleRaw = chunkResult.rows.slice(0, continuous.limit);
    const rows = visibleRaw.map(({ voucher_date: _date, source_rank: _rank, source_id: _source, ...row }) => row);
    const previousChunkNet = cursor?.net ?? 0;
    const chunkNet = rows.reduce((sum, row) => sum + statementRowNet(row), 0);
    const last = visibleRaw.at(-1);
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const sortDate = cursorDate(last.voucher_date);
      const voucherNumber = typeof last.voucherNumber === "string" ? last.voucherNumber : null;
      const sourceRank = finiteNumber(last.source_rank);
      const sourceId = finiteNumber(last.source_id);
      if (!sortDate || voucherNumber === null || sourceRank === null || sourceId === null) {
        throw new Error("factory-customer-cursor-row-invalid");
      }
      nextCursor = encodeContinuousCursor(scope, {
        sortDate,
        voucherNumber,
        sourceRank,
        sourceId,
        net: previousChunkNet + chunkNet,
        meta,
      } satisfies FactoryCustomerCursor);
    }
    return buildContinuousResponse({
      rows,
      summary: summaryFromContinuousMeta(meta),
      prePeriodNet: meta.prePeriodNet,
      previousChunkNet,
      limit: continuous.limit,
      dates,
      hadCursor: !!cursor,
      hasMore,
      nextCursor,
    });
  }

  const pageQuery = `WITH ${cte}
    SELECT * FROM filtered
    ORDER BY ${order}
    LIMIT $${baseCount + 1} OFFSET $${baseCount + 2}`;
  const precedingQuery =
    pagination.offset === 0
      ? null
      : `WITH ${cte}
         SELECT COALESCE(
           SUM(previous."debitAmount"::numeric - previous."creditAmount"::numeric),
           0
         )::text AS net
         FROM (
           SELECT * FROM filtered ORDER BY ${order} LIMIT $${baseCount + 1}
         ) previous`;

  const [pageResult, summaryResult, precedingResult, prePeriodNet] = await Promise.all([
    pool.query(pageQuery, [...values, pagination.limit, pagination.offset]),
    pool.query(summaryQuery, values),
    precedingQuery
      ? pool.query(precedingQuery, [...values, pagination.offset])
      : Promise.resolve({ rows: [{ net: "0" }] }),
    loadPrePeriodNet(),
  ]);
  const rows = pageResult.rows.map(({ voucher_date: _date, source_rank: _rank, source_id: _source, ...row }) => row);
  return buildPageResponse(
    rows,
    summaryResult.rows[0],
    Number.parseFloat(precedingResult.rows[0]?.net || "0") || 0,
    prePeriodNet,
    pagination,
    dates
  );
}
