import { pool } from "../../db";
import {
  ContinuousCursorError,
  continuousCursorScope,
  decodeContinuousCursor,
  encodeContinuousCursor,
} from "../../lib/continuousCursor";
import type {
  AccountKind,
  ContinuousStatementMeta,
  ContinuousWindow,
  DateContext,
  Pagination,
  StatementPage,
  StatementQueryResult,
  VoucherEntryCursor,
} from "./_helpers";
import {
  buildContinuousResponse,
  buildPageResponse,
  continuousMeta,
  cursorDate,
  finiteNumber,
  isVoucherEntryCursor,
  statementRowNet,
  summaryFromContinuousMeta,
} from "./_helpers";

export function genericFilteredCte(
  kind: AccountKind,
  accountId: number,
  companyId: number | undefined,
  dates: DateContext
): { cte: string; values: unknown[]; order: string; column: string } {
  const columnByKind: Record<AccountKind, string> = {
    ledger: "ledger_account_id",
    bank: "bank_account_id",
    "fixed-asset": "fixed_asset_id",
    supplier: "supplier_id",
    employee: "employee_id",
  };
  const column = columnByKind[kind];
  const values: unknown[] = [accountId];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions = [`ve.${column} = $1`, "v.optional = false", "v.deleted_at IS NULL"];
  if (companyId) conditions.push(`v.company_id = ${bind(companyId)}`);
  if (dates.rawStart) {
    conditions.push(`COALESCE(v.effective_date::date, v.voucher_date::date) >= ${bind(dates.rawStart)}::date`);
  }
  conditions.push(`COALESCE(v.effective_date::date, v.voucher_date::date) <= ${bind(dates.effectiveEndDate)}::date`);
  const baseFrom = `FROM voucher_entries ve JOIN vouchers v ON ve.voucher_id = v.id WHERE ${conditions.join(" AND ")}`;

  if (kind === "ledger") {
    return {
      column,
      values,
      order: "sort_date ASC, sort_id ASC",
      cte: `filtered AS (
        SELECT
          v.id AS "voucherId",
          MIN(ve.id) AS "entryId",
           COALESCE(SUM(ve.debit_amount::numeric), 0)::text AS "debitAmount",
           COALESCE(SUM(ve.credit_amount::numeric), 0)::text AS "creditAmount",
           COALESCE(SUM(ve.transaction_debit_amount::numeric), 0)::text AS "transactionDebitAmount",
           COALESCE(SUM(ve.transaction_credit_amount::numeric), 0)::text AS "transactionCreditAmount",
           CASE WHEN COUNT(ve.base_debit_amount) = COUNT(ve.id)
             THEN COALESCE(SUM(ve.base_debit_amount::numeric), 0)::text END AS "baseDebitAmount",
           CASE WHEN COUNT(ve.base_credit_amount) = COUNT(ve.id)
             THEN COALESCE(SUM(ve.base_credit_amount::numeric), 0)::text END AS "baseCreditAmount",
           MAX(ve.transaction_currency) AS "transactionCurrency",
           MAX(ve.historical_exchange_rate) AS "historicalExchangeRate",
           MAX(ve.rate_convention) AS "rateConvention",
          STRING_AGG(DISTINCT NULLIF(TRIM(ve.narration), ''), ' | ') AS narration,
          v.voucher_number AS "voucherNumber",
          v.voucher_type AS "voucherType",
          COALESCE(v.effective_date::date, v.voucher_date::date)::text AS "voucherDate",
          v.description AS "voucherDescription",
           v.currency,
          COALESCE(v.effective_date::date, v.voucher_date::date) AS sort_date,
          v.id AS sort_id
        ${baseFrom}
        GROUP BY
          v.id,
          v.voucher_number,
          v.voucher_type,
          v.voucher_date,
          v.effective_date,
          v.description,
          v.currency
      )`,
    };
  }

  return {
    column,
    values,
    order: "sort_date ASC, sort_id ASC, sort_entry_id ASC",
    cte: `filtered AS (
      SELECT
        ve.id AS "entryId",
        ve.voucher_id AS "voucherId",
         ve.debit_amount AS "debitAmount",
         ve.credit_amount AS "creditAmount",
         ve.transaction_currency AS "transactionCurrency",
         ve.transaction_debit_amount AS "transactionDebitAmount",
         ve.transaction_credit_amount AS "transactionCreditAmount",
         ve.base_debit_amount AS "baseDebitAmount",
         ve.base_credit_amount AS "baseCreditAmount",
         ve.historical_exchange_rate AS "historicalExchangeRate",
         ve.rate_convention AS "rateConvention",
        ve.narration,
        v.voucher_number AS "voucherNumber",
        v.voucher_type AS "voucherType",
        COALESCE(v.effective_date::date, v.voucher_date::date)::text AS "voucherDate",
        v.description AS "voucherDescription",
        v.company_id AS "companyId",
        v.currency,
        COALESCE(v.effective_date::date, v.voucher_date::date) AS sort_date,
        v.id AS sort_id,
        ve.id AS sort_entry_id
      ${baseFrom}
    )`,
  };
}

export async function loadVoucherPrePeriodNet(options: {
  accountId: number;
  companyId?: number;
  column: string;
  dates: DateContext;
}): Promise<number> {
  const { accountId, companyId, column, dates } = options;
  if (!dates.rawStart) return 0;
  const preValues: unknown[] = [accountId];
  let companyCondition = "";
  if (companyId) {
    preValues.push(companyId);
    companyCondition = `AND v.company_id = $${preValues.length}`;
  }
  preValues.push(dates.rawStart);
  const preResult = await pool.query(
    `SELECT COALESCE(
       SUM(ve.debit_amount::numeric - ve.credit_amount::numeric),
       0
     )::text AS net
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE ve.${column} = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyCondition}
       AND COALESCE(v.effective_date::date, v.voucher_date::date) < $${preValues.length}::date`,
    preValues
  );
  return Number.parseFloat(preResult.rows[0]?.net || "0") || 0;
}

export async function runVoucherEntryStatement(options: {
  kind: AccountKind;
  accountId: number;
  companyId?: number;
  pagination: Pagination;
  dates: DateContext;
  continuous?: ContinuousWindow;
}): Promise<StatementPage> {
  const { kind, accountId, companyId, pagination, dates, continuous } = options;
  const { cte, values, order, column } = genericFilteredCte(kind, accountId, companyId, dates);
  const baseCount = values.length;
  const summaryQuery = `WITH ${cte}
    SELECT
      COUNT(*)::int AS total,
      COALESCE(SUM("debitAmount"::numeric), 0)::text AS "debitTotal",
      COALESCE(SUM("creditAmount"::numeric), 0)::text AS "creditTotal"
    FROM filtered`;

  if (continuous) {
    const scope = continuousCursorScope("account-statement", {
      kind,
      accountId,
      companyId: companyId ?? null,
      startDate: dates.rawStart ?? null,
      endDate: dates.effectiveEndDate,
    });
    let cursor: VoucherEntryCursor | null = null;
    if (continuous.token) {
      const decoded = decodeContinuousCursor<unknown>(scope, continuous.token);
      if (!isVoucherEntryCursor(decoded, kind)) throw new ContinuousCursorError();
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
      if (kind !== "ledger") {
        const entryParam = bind(cursor.sortEntryId);
        cursorCondition = `(sort_date > ${dateParam}::date OR (sort_date = ${dateParam}::date AND (sort_id > ${idParam} OR (sort_id = ${idParam} AND sort_entry_id > ${entryParam}))))`;
      }
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
        loadVoucherPrePeriodNet({ accountId, companyId, column, dates }),
      ]);
      chunkResult = firstChunkResult;
      meta = continuousMeta(summaryResult.rows[0], prePeriodNet);
    }

    const hasMore = chunkResult.rows.length > continuous.limit;
    const visibleRaw = chunkResult.rows.slice(0, continuous.limit);
    const rows = visibleRaw.map(({ sort_date: _date, sort_id: _id, sort_entry_id: _entry, ...row }) => row);
    const previousChunkNet = cursor?.net ?? 0;
    const chunkNet = rows.reduce((sum, row) => sum + statementRowNet(row), 0);
    const last = visibleRaw.at(-1);
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const sortDate = cursorDate(last.sort_date);
      const sortId = finiteNumber(last.sort_id);
      const sortEntryId = finiteNumber(last.sort_entry_id);
      if (!sortDate || sortId === null) {
        throw new Error("account-statement-cursor-row-invalid");
      }
      const net = previousChunkNet + chunkNet;
      let payload: VoucherEntryCursor;
      if (kind === "ledger") {
        payload = { sortDate, sortId, net, meta };
      } else {
        if (sortEntryId === null) {
          throw new Error("account-statement-cursor-row-invalid");
        }
        payload = { sortDate, sortId, sortEntryId, net, meta };
      }
      nextCursor = encodeContinuousCursor(scope, payload);
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

  const pageValues = [...values, pagination.limit, pagination.offset];
  const pageQuery = `WITH ${cte}
    SELECT *
    FROM filtered
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
    pool.query(pageQuery, pageValues),
    pool.query(summaryQuery, values),
    precedingQuery
      ? pool.query(precedingQuery, [...values, pagination.offset])
      : Promise.resolve({ rows: [{ net: "0" }] }),
    loadVoucherPrePeriodNet({ accountId, companyId, column, dates }),
  ]);
  const rows = pageResult.rows.map(({ sort_date: _date, sort_id: _id, sort_entry_id: _entry, ...row }) => row);
  return buildPageResponse(
    rows,
    summaryResult.rows[0],
    Number.parseFloat(precedingResult.rows[0]?.net || "0") || 0,
    prePeriodNet,
    pagination,
    dates
  );
}
