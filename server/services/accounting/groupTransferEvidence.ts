/**
 * Paired intercompany Cash/Loan transfer source integrity (Phase 9).
 * Each transfer's actual journal leg is fetched inside its OWN company scope.
 * Never auto-create missing counterparty vouchers, never silently repair GL.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { runWithGroupCompanyScope } from "../../helpers/groupNetPosition";
type TransferSource = Record<string, unknown> & {
  id: number;
  from_company_id: number;
  to_company_id: number;
  from_ledger_account_id: number;
  to_ledger_account_id: number;
  from_voucher_id: number | null;
  to_voucher_id: number | null;
  transfer_date: string;
  amount: string;
  transfer_type: string;
};
type VoucherLeg = Record<string, unknown> & {
  id: number;
  voucher_number: string;
  booked_on: string;
  deleted_at: string | null;
  optional: boolean;
  ledger_signed: string | null;
  source_company: number;
};
export interface TransferEvidence {
  transferId: number;
  type: string;
  fromCompanyId: number;
  toCompanyId: number;
  transferDate: string;
  amountSourceUsd: string;
  fromVoucherId: number | null;
  toVoucherId: number | null;
  fromVoucherNumber: string | null;
  toVoucherNumber: string | null;
  sourceSideUsd: string | null;
  destinationSideUsd: string | null;
  status:
    | "matched"
    | "missing_from_voucher"
    | "missing_to_voucher"
    | "retired_leg"
    | "amount_mismatch"
    | "direction_mismatch"
    | "date_mismatch"
    | "missing_ledger_leg";
  explanation: string;
}
const usd = (d: Decimal.Value) => new Decimal(d ?? "0").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fmt = (d: Decimal) => d.toFixed(2);
async function sourceTx(companyId: number, asOf: string) {
  return db.transaction(async (tx) => {
    await assertTransactionCompanyScope(tx, companyId);
    return resultRows<TransferSource>(
      await tx.execute(sql`
  SELECT t.id,t.from_company_id,t.to_company_id,t.from_ledger_account_id,
    t.to_ledger_account_id,t.from_voucher_id,t.to_voucher_id,
    t.transfer_date::text,t.amount::text,t.transfer_type
   FROM inter_company_transfers t
   WHERE t.from_company_id=${companyId} AND t.transfer_date<=${asOf}::date
   ORDER BY t.transfer_date DESC,t.id DESC LIMIT 251
 `)
    );
  });
}
async function voucherTx(
  companyId: number,
  voucherId: number,
  accountId: number,
  asOf: string
): Promise<VoucherLeg | null> {
  return db.transaction(async (tx) => {
    await assertTransactionCompanyScope(tx, companyId);
    return (
      resultRows<VoucherLeg>(
        await tx.execute(sql`
   SELECT v.id,v.voucher_number,COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
     v.deleted_at::text,v.optional,v.company_id AS source_company,
     (SELECT SUM(COALESCE(e.base_debit_amount,e.debit_amount,0)-
        COALESCE(e.base_credit_amount,e.credit_amount,0))::text
       FROM voucher_entries e WHERE e.voucher_id=v.id AND e.ledger_account_id=${accountId})
        AS ledger_signed
   FROM vouchers v WHERE v.id=${voucherId} AND v.company_id=${companyId}
     AND COALESCE(v.effective_date,v.voucher_date)<=${asOf}::date
   LIMIT 1
  `)
      )[0] ?? null
    );
  });
}
export async function intercompanyTransferEvidence(input: {
  companyIds: readonly number[];
  allowedCompanyIds: ReadonlySet<number>;
  asOfDate: string;
}) {
  const allowed = new Set(input.companyIds);
  if (
    input.companyIds.length === 0 ||
    input.companyIds.length > 50 ||
    input.companyIds.some((id) => !Number.isSafeInteger(id) || !input.allowedCompanyIds.has(id))
  )
    throw new Error("Intercompany transfer audit only accepts authorized group members");
  const all: TransferSource[] = [];
  let truncated = false;
  for (const companyId of input.companyIds) {
    const rows = await runWithGroupCompanyScope(companyId, input.allowedCompanyIds, () =>
      sourceTx(companyId, input.asOfDate)
    );
    if (rows.length >= 251) truncated = true;
    all.push(...rows.slice(0, 250).filter((t) => allowed.has(Number(t.to_company_id))));
  }
  const results: TransferEvidence[] = [];
  for (const r of all) {
    const fromCompanyId = Number(r.from_company_id),
      toCompanyId = Number(r.to_company_id);
    const fromVoucherId = r.from_voucher_id === null ? null : Number(r.from_voucher_id);
    const toVoucherId = r.to_voucher_id === null ? null : Number(r.to_voucher_id);
    const from =
      fromVoucherId === null
        ? null
        : await runWithGroupCompanyScope(fromCompanyId, input.allowedCompanyIds, () =>
            voucherTx(fromCompanyId, fromVoucherId, Number(r.from_ledger_account_id), input.asOfDate)
          );
    const to =
      toVoucherId === null
        ? null
        : await runWithGroupCompanyScope(toCompanyId, input.allowedCompanyIds, () =>
            voucherTx(toCompanyId, toVoucherId, Number(r.to_ledger_account_id), input.asOfDate)
          );
    const base = {
      transferId: Number(r.id),
      type: r.transfer_type,
      fromCompanyId,
      toCompanyId,
      transferDate: r.transfer_date,
      amountSourceUsd: fmt(usd(r.amount)),
      fromVoucherId,
      toVoucherId,
      fromVoucherNumber: from?.voucher_number ?? null,
      toVoucherNumber: to?.voucher_number ?? null,
      sourceSideUsd: from?.ledger_signed === null || !from ? null : fmt(usd(from.ledger_signed)),
      destinationSideUsd: to?.ledger_signed === null || !to ? null : fmt(usd(to.ledger_signed)),
    };
    let status: TransferEvidence["status"] = "matched",
      explanation = "Both live same-day linked transfer legs have opposite equal historical USD balances";
    if (!from) {
      status = "missing_from_voucher";
      explanation = "Source company's voucher leg is missing, out of date scope or inaccessible";
    } else if (!to) {
      status = "missing_to_voucher";
      explanation = "Destination company's linked voucher leg is missing, out of date scope or inaccessible";
    } else if (from.deleted_at || to.deleted_at || from.optional || to.optional) {
      status = "retired_leg";
      explanation = "One or both source vouchers are deleted/optional; not a live paired transfer";
    } else if (from.ledger_signed === null || to.ledger_signed === null) {
      status = "missing_ledger_leg";
      explanation = "At least one voucher lacks the specifically linked intercompany ledger account";
    } else if (from.booked_on !== r.transfer_date || to.booked_on !== r.transfer_date) {
      status = "date_mismatch";
      explanation = "A voucher's effective posting date differs from the intercompany transfer's date";
    } else if (usd(from.ledger_signed).times(usd(to.ledger_signed)).gte(0)) {
      status = "direction_mismatch";
      explanation = "Intercompany account legs must have opposite debit/credit signs";
    } else if (
      usd(from.ledger_signed).plus(to.ledger_signed).abs().gt("0.01") ||
      usd(from.ledger_signed).abs().minus(r.amount).abs().gt("0.01")
    ) {
      status = "amount_mismatch";
      explanation = "One or both ledger-side USD amounts differ from the transfer source record";
    }
    results.push({ ...base, status, explanation });
  }
  return {
    asOfDate: input.asOfDate,
    companyIds: input.companyIds,
    rows: results,
    summary: {
      total: results.length,
      matched: results.filter((x) => x.status === "matched").length,
      flagged: results.filter((x) => x.status !== "matched").length,
      truncated,
    },
    policy:
      "Read-only audit of explicit Cash/Loan transfer source vouchers and their linked ledger account lines. Other intercompany POS, parent credits, rental links and cross-company invoices are reconciled by account pair but require independent source-specific certification. No vouchers were changed.",
  };
}
