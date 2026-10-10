import { db, pool } from "../../db";
import {
  customerLedgerNetBefore,
  loadCustomerNotInLedger,
} from "../../services/accounting/balances/customerLedgerStatement";
import { customerOwnedLinePredicate, liveVoucherPredicate } from "../../services/accounting/balances/partyLineRules";
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
  // The statement lists the lines the balance engine attributes to the
  // customer (services/accounting/balances/partyLineRules.ts), so opening +
  // these rows equals the engine closing: the trial balance's customer row,
  // /api/customers/stats and the voucher sidebar. Amounts not yet in the
  // ledger come in a separate `notInLedger` section on the first page/chunk.
  const values: unknown[] = [customerId, companyId];
  const bindBase = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions = [customerOwnedLinePredicate("ve", "$2", "$1"), liveVoucherPredicate("v", "$2")];
  if (dates.rawStart) {
    conditions.push(`COALESCE(v.effective_date::date, v.voucher_date::date) >= ${bindBase(dates.rawStart)}::date`);
  }
  if (dates.effectiveEndDate) {
    conditions.push(
      `COALESCE(v.effective_date::date, v.voucher_date::date) <= ${bindBase(dates.effectiveEndDate)}::date`
    );
  }

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

  // The engine's carried-forward movement before the period (0 without a start).
  const loadPrePeriodNet = (): Promise<number> =>
    customerLedgerNetBefore(db, companyId, customerId, dates.rawStart ?? null);
  const loadNotInLedger = () =>
    loadCustomerNotInLedger(db, {
      companyId,
      customerId,
      from: dates.rawStart ?? null,
      to: dates.effectiveEndDate,
    });

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
    const response = buildContinuousResponse({
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
    return cursor ? response : { ...response, notInLedger: await loadNotInLedger() };
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

  const [pageResult, summaryResult, precedingResult, prePeriodNet, notInLedger] = await Promise.all([
    pool.query(pageQuery, [...values, pagination.limit, pagination.offset]),
    pool.query(summaryQuery, values),
    precedingQuery
      ? pool.query(precedingQuery, [...values, pagination.offset])
      : Promise.resolve({ rows: [{ net: "0" }] }),
    loadPrePeriodNet(),
    loadNotInLedger(),
  ]);
  const rows = pageResult.rows.map(({ sort_date: _date, sort_id: _id, ...row }) => row);
  return {
    ...buildPageResponse(
      rows,
      summaryResult.rows[0],
      Number.parseFloat(precedingResult.rows[0]?.net || "0") || 0,
      prePeriodNet,
      pagination,
      dates
    ),
    notInLedger,
  };
}
