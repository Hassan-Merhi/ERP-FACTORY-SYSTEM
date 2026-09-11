import { pool } from "../../db";

type EntryRow = {
  __supplierId: number;
  entryId: number;
  voucherId: number;
  debitAmount: string | null;
  creditAmount: string | null;
  narration: string | null;
  transactionCurrency: string | null;
  transactionDebitAmount: string | null;
  transactionCreditAmount: string | null;
  baseDebitAmount: string | null;
  baseCreditAmount: string | null;
  voucherNumber: string | null;
  voucherType: string | null;
  voucherDate: string | null;
  voucherDescription: string | null;
  companyId: number;
  currency: string | null;
};

type PublicEntryRow = Omit<EntryRow, "__supplierId">;

type Resolver = {
  resolve: (rows: PublicEntryRow[]) => void;
  reject: (error: unknown) => void;
};

type PendingBatch = {
  supplierIds: Set<number>;
  resolvers: Map<number, Resolver[]>;
  scheduled: boolean;
};

const pendingByCompany = new Map<string, PendingBatch>();

function companyKey(companyId?: number): string {
  return companyId ? `company:${companyId}` : "all-companies";
}

function stripInternalSupplierId(row: EntryRow) {
  const { __supplierId: _supplierId, ...entry } = row;
  return entry;
}

async function flushBatch(key: string, companyId: number | undefined, batch: PendingBatch): Promise<void> {
  pendingByCompany.delete(key);
  const supplierIds = [...batch.supplierIds];

  if (supplierIds.length === 0) {
    for (const resolvers of batch.resolvers.values()) {
      for (const resolver of resolvers) resolver.resolve([]);
    }
    return;
  }

  try {
    const params: unknown[] = [supplierIds];
    let companyFilter = "";
    if (companyId) {
      params.push(companyId);
      companyFilter = ` AND v.company_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         ve.supplier_id                                               AS "__supplierId",
         ve.id                                                        AS "entryId",
         ve.voucher_id                                                AS "voucherId",
         ve.debit_amount                                              AS "debitAmount",
         ve.credit_amount                                             AS "creditAmount",
         ve.narration,
         ve.transaction_currency                                      AS "transactionCurrency",
         ve.transaction_debit_amount                                  AS "transactionDebitAmount",
         ve.transaction_credit_amount                                 AS "transactionCreditAmount",
         ve.base_debit_amount                                         AS "baseDebitAmount",
         ve.base_credit_amount                                        AS "baseCreditAmount",
         v.voucher_number                                             AS "voucherNumber",
         v.voucher_type                                               AS "voucherType",
         COALESCE(v.effective_date::date, v.voucher_date::date)       AS "voucherDate",
         v.description                                                AS "voucherDescription",
         v.company_id                                                 AS "companyId",
         v.currency
       FROM voucher_entries ve
       JOIN vouchers v ON ve.voucher_id = v.id
       WHERE ve.supplier_id = ANY($1::int[])
         AND v.optional = false
         AND v.deleted_at IS NULL
         ${companyFilter}
       ORDER BY ve.supplier_id, COALESCE(v.effective_date::date, v.voucher_date::date) DESC, v.id DESC`,
      params
    );

    const rowsBySupplier = new Map<number, PublicEntryRow[]>();
    for (const row of result.rows as EntryRow[]) {
      const supplierId = Number(row.__supplierId);
      if (!rowsBySupplier.has(supplierId)) rowsBySupplier.set(supplierId, []);
      rowsBySupplier.get(supplierId)!.push(stripInternalSupplierId(row));
    }

    for (const [supplierId, resolvers] of batch.resolvers) {
      const rows = rowsBySupplier.get(supplierId) || [];
      for (const resolver of resolvers) resolver.resolve(rows);
    }
  } catch (error) {
    for (const resolvers of batch.resolvers.values()) {
      for (const resolver of resolvers) resolver.reject(error);
    }
  }
}

/**
 * Coalesces concurrent supplier-balance reads for the same company into one SQL
 * query. Accounts, payables, and supplier summary endpoints already request
 * balances with Promise.all, so the previous one-query-per-supplier pattern is
 * reduced to one bounded query without changing the returned entry contract.
 */
export function getVoucherEntriesBySupplierBatched(supplierId: number, companyId?: number) {
  const key = companyKey(companyId);
  let batch = pendingByCompany.get(key);
  if (!batch) {
    batch = {
      supplierIds: new Set<number>(),
      resolvers: new Map<number, Resolver[]>(),
      scheduled: false,
    };
    pendingByCompany.set(key, batch);
  }

  batch.supplierIds.add(supplierId);

  const promise = new Promise<PublicEntryRow[]>((resolve, reject) => {
    const resolvers = batch!.resolvers.get(supplierId) || [];
    resolvers.push({ resolve, reject });
    batch!.resolvers.set(supplierId, resolvers);
  });

  if (!batch.scheduled) {
    batch.scheduled = true;
    queueMicrotask(() => {
      void flushBatch(key, companyId, batch!);
    });
  }

  return promise;
}
