/**
 * Company scope for POST /api/admin/repair-balances/undo.
 *
 * The undo snapshot comes from the request body, so every row it names is
 * checked against the active company before the undo writes anything. A row
 * that exists in another company refuses the whole undo; a row that no longer
 * exists is skipped (a repeated undo stays harmless).
 */
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import type { ApplySnapshot } from "./_helpers";

/** The retirement reason apply records for an orphaned transfer voucher. */
export const ORPHAN_RETIREMENT_REASON = "balance-repair-orphaned-transfer-voucher";

export class UndoOutsideCompanyError extends Error {
  constructor(what: string) {
    super(`The undo snapshot names ${what} that is not in the active company`);
    this.name = "UndoOutsideCompanyError";
  }
}

function ids(values: unknown[], what: string): number[] {
  return values.map((value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new UndoOutsideCompanyError(what);
    return id;
  });
}

async function rowsOwnedBy(
  exec: DatabaseOrTransaction,
  table: "vouchers" | "ledger_accounts",
  wanted: Array<{ id: number | null; companyId: number }>
): Promise<boolean> {
  for (const { id, companyId } of wanted) {
    if (id === null) continue;
    const found =
      table === "vouchers"
        ? await exec.execute(sql`SELECT 1 FROM vouchers WHERE id = ${id} AND company_id = ${companyId}`)
        : await exec.execute(sql`SELECT 1 FROM ledger_accounts WHERE id = ${id} AND company_id = ${companyId}`);
    if (resultRows(found).length === 0) return false;
  }
  return true;
}

export async function assertUndoInCompany(
  exec: DatabaseOrTransaction,
  companyId: number,
  snapshot: ApplySnapshot
): Promise<void> {
  const ledgerIds = ids(
    (snapshot.ledgerSnapshots ?? []).map((s) => s?.id),
    "a ledger row"
  );
  if (ledgerIds.length > 0) {
    const foreign = resultRows(
      await exec.execute(
        sql`SELECT id FROM property_monthly_ledger WHERE id = ANY(${sqlArray(ledgerIds)}) AND company_id <> ${companyId}`
      )
    );
    if (foreign.length > 0) throw new UndoOutsideCompanyError("a ledger row");
  }

  const contractIds = ids(
    (snapshot.depositSnapshots ?? []).map((s) => s?.contractId),
    "a contract"
  );
  if (contractIds.length > 0) {
    const foreign = resultRows(
      await exec.execute(
        sql`SELECT id FROM property_contracts WHERE id = ANY(${sqlArray(contractIds)}) AND company_id <> ${companyId}`
      )
    );
    if (foreign.length > 0) throw new UndoOutsideCompanyError("a contract");
  }

  const entryIds = ids(snapshot.voucherEntriesAdded ?? [], "a voucher line");
  if (entryIds.length > 0) {
    const foreign = resultRows(
      await exec.execute(
        sql`SELECT e.id FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
           WHERE e.id = ANY(${sqlArray(entryIds)}) AND v.company_id <> ${companyId}`
      )
    );
    if (foreign.length > 0) throw new UndoOutsideCompanyError("a voucher line");
  }

  const undeletedIds = ids(
    (snapshot.vouchersUndeleted ?? []).map((v) => v?.id),
    "a voucher"
  );
  if (undeletedIds.length > 0) {
    const foreign = resultRows(
      await exec.execute(
        sql`SELECT id FROM vouchers WHERE id = ANY(${sqlArray(undeletedIds)}) AND company_id <> ${companyId}`
      )
    );
    if (foreign.length > 0) throw new UndoOutsideCompanyError("a voucher");
  }

  // A transfer must involve the active company, and its vouchers and ledger
  // accounts must belong to the companies on the side that names them.
  const transfers = snapshot.transfersDeleted ?? [];
  for (const t of transfers) {
    const [, fromCompanyId, toCompanyId] = ids([t?.id, t?.fromCompanyId, t?.toCompanyId], "a transfer");
    if (fromCompanyId !== companyId && toCompanyId !== companyId) throw new UndoOutsideCompanyError("a transfer");
    const optionalId = (value: unknown) =>
      value === null || value === undefined ? null : ids([value], "a transfer")[0];
    const vouchersOwned = await rowsOwnedBy(exec, "vouchers", [
      { id: optionalId(t.fromVoucherId), companyId: fromCompanyId },
      { id: optionalId(t.toVoucherId), companyId: toCompanyId },
    ]);
    const accountsOwned = await rowsOwnedBy(exec, "ledger_accounts", [
      { id: ids([t.fromLedgerAccountId], "a transfer")[0], companyId: fromCompanyId },
      { id: ids([t.toLedgerAccountId], "a transfer")[0], companyId: toCompanyId },
    ]);
    if (!vouchersOwned || !accountsOwned) throw new UndoOutsideCompanyError("a transfer");
  }

  // An orphaned voucher of another company may only come back as the other
  // side of a transfer of the active company named in the same snapshot.
  for (const ov of snapshot.orphanedVouchersDeleted ?? []) {
    const voucherId = Number(ov?.id);
    if (!Number.isInteger(voucherId) || voucherId <= 0 || typeof ov.voucherNumber !== "string") continue;
    const [row] = resultRows<{ company_id: number }>(
      await exec.execute(sql`SELECT company_id FROM vouchers WHERE id = ${voucherId}`)
    );
    if (!row || Number(row.company_id) === companyId) continue;
    const owner = Number(row.company_id);
    const linked = transfers.some(
      (t) =>
        (Number(t.fromVoucherId) === voucherId && Number(t.fromCompanyId) === owner) ||
        (Number(t.toVoucherId) === voucherId && Number(t.toCompanyId) === owner)
    );
    if (!linked) throw new UndoOutsideCompanyError("a voucher");
  }
}
