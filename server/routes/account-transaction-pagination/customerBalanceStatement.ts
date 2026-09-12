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
  CustomerCursor,
  DateContext,
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
  isCustomerCursor,
  statementRowNet,
  summaryFromContinuousMeta,
} from "./_helpers";

export async function runCustomerBalanceStatement(options: {
  customerId: number;
  companyId: number;
  pagination: Pagination;
  dates: DateContext;
  continuous?: ContinuousWindow;
}): Promise<StatementPage> {
  const { customerId, companyId, pagination, dates, continuous } = options;
  const values: unknown[] = [customerId, companyId];
  const conditions = ["cb.customer_id = $1", "cb.company_id = $2"];
  if (dates.rawStart) {
    values.push(dates.rawStart);
    conditions.push(`cb.transaction_date >= $${values.length}::date`);
  }
  values.push(dates.effectiveEndDate);
  conditions.push(`cb.transaction_date <= $${values.length}::date`);

  const cte = `filtered AS (
    SELECT
      cb.id AS "entryId",
      COALESCE(cb.reference_id, cb.id) AS "voucherId",
      CASE
        WHEN cb.reference_type IS NOT NULL
          THEN cb.reference_type || '-' || COALESCE(cb.reference_id, cb.id)::text
        ELSE 'CB-' || cb.id::text
      END AS "voucherNumber",
      cb.transaction_type AS "voucherType",
      cb.transaction_date::text AS "voucherDate",
      COALESCE(cb.description, '') AS "voucherDescription",
      COALESCE(cb.description, '') AS narration,
      cb.debit_amount AS "debitAmount",
      cb.credit_amount AS "creditAmount",
      cb.currency AS currency,
      cb.transaction_date AS sort_date,
      cb.id AS sort_id
    FROM customer_balances cb
    WHERE ${conditions.join(" AND ")}
  )`;
  const baseCount = values.length;
  const summaryQuery = `WITH ${cte}
    SELECT
      COUNT(*)::int AS total,
      COALESCE(SUM("debitAmount"::numeric), 0)::text AS "debitTotal",
      COALESCE(SUM("creditAmount"::numeric), 0)::text AS "creditTotal"
    FROM filtered`;

  const loadPrePeriodNet = async (): Promise<number> => {
    if (!dates.rawStart) return 0;
    const preResult = await pool.query(
      `SELECT COALESCE(
         SUM(cb.debit_amount::numeric - cb.credit_amount::numeric),
         0
       )::text AS net
       FROM customer_balances cb
       WHERE cb.customer_id = $1
         AND cb.company_id = $2
         AND cb.transaction_date < $3::date`,
      [customerId, companyId, dates.rawStart]
    );
    return Number.parseFloat(preResult.rows[0]?.net || "0") || 0;
  };

  if (continuous) {
    const scope = continuousCursorScope("customer-statement", {
      customerId,
      companyId,
      startDate: dates.rawStart ?? null,
      endDate: dates.effectiveEndDate,
    });
    let cursor: CustomerCursor | null = null;
    if (continuous.token) {
      const decoded = decodeContinuousCursor<unknown>(scope, continuous.token);
      if (!isCustomerCursor(decoded)) throw new ContinuousCursorError();
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
      const idParam = bind(cursor.sortId);
      cursorCondition = `(sort_date > ${dateParam}::date OR (sort_date = ${dateParam}::date AND sort_id > ${idParam}))`;
    }
    const limitParam = bind(continuous.limit + 1);
    const chunkQuery = `WITH ${cte}
      SELECT * FROM filtered
      WHERE ${cursorCondition}
      ORDER BY sort_date ASC, sort_id ASC
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
    const rows = visibleRaw.map(({ sort_date: _date, sort_id: _id, ...row }) => row);
    const previousChunkNet = cursor?.net ?? 0;
    const chunkNet = rows.reduce((sum, row) => sum + statementRowNet(row), 0);
    const last = visibleRaw.at(-1);
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const sortDate = cursorDate(last.sort_date);
      const sortId = finiteNumber(last.sort_id);
      if (!sortDate || sortId === null) throw new Error("customer-statement-cursor-row-invalid");
      nextCursor = encodeContinuousCursor(scope, {
        sortDate,
        sortId,
        net: previousChunkNet + chunkNet,
        meta,
      } satisfies CustomerCursor);
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
    ORDER BY sort_date ASC, sort_id ASC
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
           SELECT * FROM filtered
           ORDER BY sort_date ASC, sort_id ASC
           LIMIT $${baseCount + 1}
         ) previous`;

  const [pageResult, summaryResult, precedingResult, prePeriodNet] = await Promise.all([
    pool.query(pageQuery, [...values, pagination.limit, pagination.offset]),
    pool.query(summaryQuery, values),
    precedingQuery
      ? pool.query(precedingQuery, [...values, pagination.offset])
      : Promise.resolve({ rows: [{ net: "0" }] }),
    loadPrePeriodNet(),
  ]);
  const rows = pageResult.rows.map(({ sort_date: _date, sort_id: _id, ...row }) => row);
  return buildPageResponse(
    rows,
    summaryResult.rows[0],
    Number.parseFloat(precedingResult.rows[0]?.net || "0") || 0,
    prePeriodNet,
    pagination,
    dates
  );
}
