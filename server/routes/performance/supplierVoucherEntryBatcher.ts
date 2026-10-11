import { db, pool } from "../../db";
import { getPartyBalances, type PartyBalance } from "../../services/accounting/balances/ledgerBalanceEngine";
import { higherPriorityTargetsAbsent } from "../../services/accounting/balances/partyLineRules";

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

type Resolver<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type PendingBatch<T> = {
  supplierIds: Set<number>;
  resolvers: Map<number, Resolver<T>[]>;
};

/**
 * Coalesces concurrent per-supplier reads that share a key into one load.
 * Accounts, payables and the supplier summary request balances with
 * Promise.all, so one query serves every supplier of the page.
 */
function createSupplierBatcher<T>(load: (key: string, supplierIds: number[]) => Promise<Map<number, T>>, empty: T) {
  const pending = new Map<string, PendingBatch<T>>();

  async function flush(key: string, batch: PendingBatch<T>): Promise<void> {
    pending.delete(key);
    const supplierIds = [...batch.supplierIds];
    try {
      const loaded = supplierIds.length === 0 ? new Map<number, T>() : await load(key, supplierIds);
      for (const [supplierId, resolvers] of batch.resolvers) {
        const value = loaded.get(supplierId) ?? empty;
        for (const resolver of resolvers) resolver.resolve(value);
      }
    } catch (error) {
      for (const resolvers of batch.resolvers.values()) {
        for (const resolver of resolvers) resolver.reject(error);
      }
    }
  }

  return (key: string, supplierId: number): Promise<T> => {
    let batch = pending.get(key);
    if (!batch) {
      const created: PendingBatch<T> = { supplierIds: new Set<number>(), resolvers: new Map() };
      pending.set(key, created);
      batch = created;
      queueMicrotask(() => {
        void flush(key, created);
      });
    }
    batch.supplierIds.add(supplierId);
    const target = batch;
    return new Promise<T>((resolve, reject) => {
      const resolvers = target.resolvers.get(supplierId) || [];
      resolvers.push({ resolve, reject });
      target.resolvers.set(supplierId, resolvers);
    });
  };
}

function stripInternalSupplierId(row: EntryRow): PublicEntryRow {
  const { __supplierId: _supplierId, ...entry } = row;
  return entry;
}

/** The supplier's own lines (engine attribution): not on a ledger account, bank or fixed asset. */
const SUPPLIER_OWNED_LINE = higherPriorityTargetsAbsent("ve", "supplier_id");

const entryBatcher = createSupplierBatcher<PublicEntryRow[]>(async (key, supplierIds) => {
  const companyId = Number(key);
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
       AND ${SUPPLIER_OWNED_LINE}
       AND v.optional = false
       AND v.deleted_at IS NULL
       AND v.company_id = $2
     ORDER BY ve.supplier_id, COALESCE(v.effective_date::date, v.voucher_date::date) DESC, v.id DESC`,
    [supplierIds, companyId]
  );
  const rowsBySupplier = new Map<number, PublicEntryRow[]>();
  for (const row of result.rows as EntryRow[]) {
    const supplierId = Number(row.__supplierId);
    const list = rowsBySupplier.get(supplierId) ?? [];
    list.push(stripInternalSupplierId(row));
    rowsBySupplier.set(supplierId, list);
  }
  return rowsBySupplier;
}, []);

/**
 * The supplier's posted lines in the voucher company, exactly the lines the
 * balance engine attributes to it (a supplier-tagged line on a ledger account,
 * bank or fixed asset belongs to that account). The company filter is always
 * applied: a line belongs to its voucher's company.
 */
export function getVoucherEntriesBySupplierBatched(supplierId: number, companyId: number) {
  return entryBatcher(String(companyId), supplierId);
}

export interface SupplierEngineWindow {
  /** Inclusive end; omitted for everything posted. */
  asOf?: string | null;
  /** Inclusive start; earlier movements are carried into the opening. */
  from?: string | null;
}

const balanceBatcher = createSupplierBatcher<PartyBalance | null>(async (key, supplierIds) => {
  const [company, asOf, from] = key.split("|");
  const result = await getPartyBalances(db, {
    companyId: Number(company),
    kind: "supplier",
    ids: supplierIds,
    asOf: asOf || null,
    from: from || null,
  });
  const byId = new Map<number, PartyBalance | null>();
  for (const party of result.parties) if (party.id !== null) byId.set(party.id, party);
  return byId;
}, null);

/**
 * The supplier's balance from the one balance engine (kind "supplier") in the
 * voucher company, batched like the entries above. Null when the supplier has
 * neither a master record nor lines in the company.
 */
export function getSupplierEngineBalanceBatched(
  supplierId: number,
  companyId: number,
  window: SupplierEngineWindow = {}
): Promise<PartyBalance | null> {
  return balanceBatcher(`${companyId}|${window.asOf ?? ""}|${window.from ?? ""}`, supplierId);
}
