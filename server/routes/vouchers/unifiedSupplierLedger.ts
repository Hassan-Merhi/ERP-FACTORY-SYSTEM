/**
 * The unified ERP supplier ledger (GET /api/suppliers/:id/unified-ledger) on
 * the one supplier rule (accounting audit wave 14; wave 13 owner decision 2).
 *
 *   - Lines: per company read (the companyId filter, else every company the
 *     caller may see), the lines the balance engine attributes to the
 *     supplier (partyLineRules.higherPriorityTargetsAbsent: a supplier-tagged
 *     line on a ledger account, bank or fixed asset belongs to that account),
 *     dated COALESCE(effective_date, voucher_date).
 *   - Opening: the supplier's opening with its side, counted only in the
 *     supplier's own company (the posting company), plus, with a startDate,
 *     the lines before it — the engine's period opening. It used to be the
 *     unsided master opening, shown only when the viewing company was the
 *     parent by the global parentCompanyId setting.
 *   - So for an ordinary company the closing balance equals the engine's
 *     (getSupplierBalanceForContext), whatever the global setting says.
 *   - Supplier-partner companies (documented design): their supplier credits
 *     are posted on the SP payable ledger with the supplier tagged, and this
 *     page is their supplier-tagged payable evidence (the SP reconciliation
 *     reads the same lines). In those companies every supplier-tagged line is
 *     listed and counted; a line the engine gives to the account carries
 *     `spPayableEvidence: true`.
 */
import { pool } from "../../db";
import { storage } from "../../storage";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { higherPriorityTargetsAbsent } from "../../services/accounting/balances/partyLineRules";
import { getSupplierBalanceForContext } from "../helpers/supplierBalanceHelpers";

/**
 * One line of the supplier statement.
 *
 * The synthetic "opening" row carries no voucher, so the voucher-derived fields
 * are nullable on this shape even though the underlying columns are NOT NULL.
 */
export interface SupplierStatementTransaction {
  type: "voucher" | "opening";
  date: string | null;
  companyId: number | null;
  companyName: string;
  docNumber: string;
  voucherId: number | null;
  description: string;
  voucherType: string;
  debit: number;
  credit: number;
  /** Supplier-partner companies only: a supplier-tagged line the engine gives to its account. */
  spPayableEvidence?: true;
}

/**
 * A statement line with its running balance. Container fields are filled in
 * afterwards for rows whose narration mentions an ISO 6346 container number.
 */
export interface SupplierStatementRow extends SupplierStatementTransaction {
  balance: number;
  containerNumber?: string;
  containerId?: number | null;
}

const SUPPLIER_OWNED_LINE = higherPriorityTargetsAbsent("ve", "supplier_id");

/** Cr-positive net of supplier-tagged lines the engine gives to another target, before `startDate`. */
async function evidenceBroughtForward(supplierId: number, companyId: number, startDate: string) {
  const result = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0)::text AS net
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
      WHERE ve.supplier_id = $1 AND v.company_id = $2
        AND v.optional = false AND v.deleted_at IS NULL
        AND NOT (${SUPPLIER_OWNED_LINE})
        AND COALESCE(v.effective_date::date, v.voucher_date::date) < $3::date`,
    [supplierId, companyId, startDate]
  );
  return toMoney(result.rows[0]?.net ?? 0);
}

export async function buildUnifiedSupplierLedger(input: {
  supplierId: number;
  companyIds: readonly number[];
  startDate?: string;
  endDate?: string;
}): Promise<SupplierStatementRow[]> {
  const { supplierId, companyIds, startDate, endDate } = input;
  if (startDate && endDate && startDate > endDate) return [];
  const [supplier, companyRows] = await Promise.all([
    storage.getSupplierById(supplierId),
    Promise.all(companyIds.map((companyId) => storage.getCompanyById(companyId))),
  ]);
  const companyMap = new Map(companyRows.filter(Boolean).map((company) => [company!.id, company!] as const));

  const transactions: SupplierStatementTransaction[] = [];
  let opening = new MoneyDecimal(0);
  const perCompany = await Promise.all(
    companyIds.map(async (companyId) => {
      const supplierPartner = companyMap.get(companyId)?.companyType === "supplier_partner";
      const [owned, all, engine, carried] = await Promise.all([
        storage.getVoucherEntriesBySupplier(supplierId, companyId, startDate, endDate, { ownedOnly: true }),
        supplierPartner
          ? storage.getVoucherEntriesBySupplier(supplierId, companyId, startDate, endDate)
          : Promise.resolve(null),
        supplier ? getSupplierBalanceForContext(supplier, companyId, { startDate, endDate }) : Promise.resolve(null),
        supplierPartner && startDate
          ? evidenceBroughtForward(supplierId, companyId, startDate)
          : Promise.resolve(new MoneyDecimal(0)),
      ]);
      return { companyId, owned, all, engine, carried };
    })
  );

  for (const { companyId, owned, all, engine, carried } of perCompany) {
    // The engine's period opening (Cr positive): the opening with its side in
    // the supplier's own company only, plus owned lines before startDate.
    opening = opening.plus(engine?.periodOpeningBalance ?? 0).plus(carried);
    const ownedIds = new Set(owned.map((entry) => entry.entryId));
    const company = companyMap.get(companyId);
    for (const entry of all ?? owned) {
      transactions.push({
        type: "voucher",
        date: entry.voucherDate,
        companyId: entry.companyId,
        companyName: company?.name || "Unknown",
        docNumber: entry.voucherNumber,
        voucherId: entry.voucherId,
        description: entry.narration || entry.voucherDescription || "",
        voucherType: entry.voucherType,
        debit: toMoney(entry.debitAmount || 0).toNumber(),
        credit: toMoney(entry.creditAmount || 0).toNumber(),
        ...(ownedIds.has(entry.entryId) ? {} : { spPayableEvidence: true as const }),
      });
    }
  }

  // Oldest first for the running balance.
  transactions.sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateA - dateB;
  });

  const result: SupplierStatementRow[] = [];
  if (!opening.isZero()) {
    result.push({
      type: "opening",
      date: null,
      companyId: null,
      companyName: "Opening Balance",
      docNumber: "-",
      voucherId: null,
      description: "Opening Balance",
      voucherType: "Opening",
      debit: 0,
      credit: 0,
      balance: opening.toNumber(),
    });
  }
  let balance = opening;
  for (const t of transactions) {
    balance = balance.plus(t.credit).minus(t.debit);
    result.push({ ...t, balance: balance.toNumber() });
  }
  return result;
}
