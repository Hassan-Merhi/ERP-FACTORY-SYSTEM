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
  // The statement lists the customer's posted voucher lines under the shared
  // ledger rules (storage/accounting/customer-ledger-balance.ts), so opening +
  // these rows equals the balance /api/customers/stats and the voucher sidebar
  // report. It used to list the customer_balances cache only, which misses
  // voucher receipts and double-reads nothing the ledger already carries.
  const customerResult = await pool.query<{ ledger_account_id: number | null }>(
    `SELECT ledger_account_id FROM customers WHERE id = $1 AND company_id = $2`,
    [customerId, companyId]
  );
  const ledgerAccountId = customerResult.rows[0]?.ledger_account_id ?? null;

  const values: unknown[] = [customerId, companyId];
  const bindBase = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const lineFilter =
    ledgerAccountId !== null
      ? `(ve.ledger_account_id = ${bindBase(ledgerAccountId)} OR (ve.customer_id = $1 AND ve.ledger_account_id IS NULL))`
      : "ve.customer_id = $1";
  const postedConditions = [lineFilter, "v.company_id = $2", "v.optional = false", "v.deleted_at IS NULL"];
  const lineValues = [...values];
  const conditions = [...postedConditions];
  if (dates.rawStart) {
    conditions.push(`COALESCE(v.effective_date::date, v.voucher_date::date) >= ${bindBase(dates.rawStart)}::date`);
  }
  conditions.push(
    `COALESCE(v.effective_date::date, v.voucher_date::date) <= ${bindBase(dates.effectiveEndDate)}::date`
  );

  const cte = `filtered AS (
    SELECT
      ve.id AS "entryId",
      ve.voucher_id AS "voucherId",
      v.voucher_number AS "voucherNumber",
      v.voucher_type AS "voucherType",
      COALESCE(v.effective_date::date, v.voucher_date::date)::text AS "voucherDate",
      COALESCE(v.description, '') AS "voucherDescription",
      COALESCE(ve.narration, v.description, '') AS narration,
      ve.debit_amount AS "debitAmount",
      ve.credit_amount AS "creditAmount",
      ve.transaction_currency AS "transactionCurrency",
      ve.transaction_debit_amount AS "transactionDebitAmount",
      ve.transaction_credit_amount AS "transactionCreditAmount",
      ve.base_debit_amount AS "baseDebitAmount",
      ve.base_credit_amount AS "baseCreditAmount",
      ve.historical_exchange_rate AS "historicalExchangeRate",
      ve.rate_convention AS "rateConvention",
      v.currency AS currency,
      COALESCE(v.effective_date::date, v.voucher_date::date) AS sort_date,
      ve.id AS sort_id
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
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
    const preValues = [...lineValues, dates.rawStart];
    const preResult = await pool.query(
      `SELECT COALESCE(
         SUM(ve.debit_amount::numeric - ve.credit_amount::numeric),
         0
       )::text AS net
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       WHERE ${postedConditions.join(" AND ")}
         AND COALESCE(v.effective_date::date, v.voucher_date::date) < $${preValues.length}::date`,
      preValues
    );
    return Number(preResult.rows[0]?.net || "0") || 0;
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
