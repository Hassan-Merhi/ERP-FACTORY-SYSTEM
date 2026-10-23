/**
 * Phase 8: link existing EXPENSE lines to rental units/contracts, in USD base.
 * Never touch voucher_entries, fiscal periods, payments or historical FX.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { fxDay } from "../accounting/monetaryFxRates";
import { writeAuditEvent } from "../audit";
import type { RentalOriginModule } from "../accounting/unifiedAccountingFoundation";

export class RentalAccountingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "RentalAccountingError";
  }
}
export type ExpenseCategory =
  "maintenance" | "repairs" | "utilities" | "insurance" | "property_tax" | "other_property_cost";
export const RENTAL_EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  "maintenance",
  "repairs",
  "utilities",
  "insurance",
  "property_tax",
  "other_property_cost",
];
const money = (v: unknown) => new Decimal(String(v ?? "0"));
const fmt = (v: Decimal) => v.toFixed(6);
const validId = (n: number, label: string) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new RentalAccountingError("RENTAL_INVALID_ID", `Invalid ${label}`, 400);
  return n;
};
interface VoucherCostRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  voucher_number: string;
  effective_on: string;
  posted_cost_usd: string;
  deleted_at: string | null;
  optional: boolean;
}
interface ContractRow extends Record<string, unknown> {
  id: number;
  unit_id: number;
  module: RentalOriginModule;
}
interface LinkRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  module: RentalOriginModule;
  contract_id: number;
  unit_id: number;
  voucher_id: number;
  category: ExpenseCategory;
  allocated_usd: string;
  note: string | null;
  tagged_at: string;
  voided_at: string | null;
  voucher_number: string | null;
  source_status?: "active" | "retired" | "optional" | "reversed";
}
async function verifyContract(
  tx: DbTransaction,
  input: {
    companyId: number;
    module: RentalOriginModule;
    contractId: number;
  }
): Promise<ContractRow> {
  validId(input.companyId, "companyId");
  validId(input.contractId, "contractId");
  await assertTransactionCompanyScope(tx, input.companyId);
  const rows = resultRows<ContractRow>(
    await tx.execute(sql`
 SELECT id,unit_id,module FROM property_contracts
 WHERE id=${input.contractId} AND company_id=${input.companyId} AND module=${input.module}
 LIMIT 1
 `)
  );
  if (!rows.length)
    throw new RentalAccountingError(
      "RENTAL_CONTRACT_NOT_FOUND",
      "This contract is not owned by your selected company and rental module",
      404
    );
  return rows[0];
}
async function voucherExpenseTx(tx: DbTransaction, companyId: number, voucherId: number): Promise<VoucherCostRow> {
  const row = resultRows<VoucherCostRow>(
    await tx.execute(sql`
 SELECT v.id,v.company_id,v.voucher_number,
   COALESCE(v.effective_date,v.voucher_date)::text AS effective_on,
   v.deleted_at::text,v.optional,
   COALESCE(SUM(
     CASE WHEN LOWER(TRIM(la.account_type)) LIKE '%expense%'
          AND la.company_id=v.company_id
          AND COALESCE(UPPER(la.code),'') !~ '^(RENT-EXP|SHOP-RENT-EXP|FX-REALIZED)(-|$)'
          THEN
       GREATEST(COALESCE(e.base_debit_amount,e.debit_amount,0)-
         COALESCE(e.base_credit_amount,e.credit_amount,0),0)
       ELSE 0 END),0)::text AS posted_cost_usd
 FROM vouchers v
 LEFT JOIN voucher_entries e ON e.voucher_id=v.id
 LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id
 WHERE v.company_id=${companyId} AND v.id=${voucherId}
 GROUP BY v.id
 `)
  )[0];
  if (!row || row.deleted_at || row.optional)
    throw new RentalAccountingError(
      "RENTAL_VOUCHER_UNPOSTED",
      "A live posted voucher from this company is required",
      400
    );
  if (!money(row.posted_cost_usd).gt(0))
    throw new RentalAccountingError(
      "RENTAL_VOUCHER_NOT_EXPENSE",
      "The source voucher has no positive expense account debit to allocate",
      400
    );
  return row;
}
export async function listRentalExpenseLinksTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    module: RentalOriginModule;
    contractId: number;
    asOfDate: string;
  }
) {
  await verifyContract(tx, input);
  const date = fxDay(input.asOfDate);
  return resultRows<LinkRow>(
    await tx.execute(sql`
  SELECT l.id,l.company_id,l.module,l.contract_id,l.unit_id,l.voucher_id,l.category,
   l.allocated_usd::text,l.note,l.tagged_at::text,l.voided_at::text,
   v.voucher_number,
   CASE WHEN v.deleted_at IS NOT NULL AND v.deleted_at::date<=${date}::date THEN 'retired'
        WHEN COALESCE(v.optional,false)=true THEN 'optional'
        WHEN EXISTS (
          SELECT 1 FROM vouchers reversal
          WHERE reversal.company_id=v.company_id AND reversal.reversal_of_voucher_id=v.id
           AND reversal.deleted_at IS NULL AND reversal.optional=false
           AND COALESCE(reversal.effective_date,reversal.voucher_date)<=${date}::date
        ) THEN 'reversed'
        ELSE 'active' END AS source_status
  FROM accounting_rental_expense_links l
  JOIN vouchers v ON v.id=l.voucher_id AND v.company_id=l.company_id
  WHERE l.company_id=${input.companyId} AND l.module=${input.module}
    AND l.contract_id=${input.contractId}
    AND l.tagged_at::date<=${date}::date
    AND (l.voided_at IS NULL OR l.voided_at::date>${date}::date)
    AND COALESCE(v.effective_date,v.voucher_date)<=${date}::date
  ORDER BY l.id DESC LIMIT 500
 `)
  );
}
export async function linkRentalExpenseTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    module: RentalOriginModule;
    contractId: number;
    voucherId: number;
    category: ExpenseCategory;
    amountUsd: string;
    note?: string | null;
    clientRequestKey: string;
    actor: { userId: string; username: string };
  }
) {
  validId(input.voucherId, "voucherId");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.clientRequestKey))
    throw new RentalAccountingError(
      "RENTAL_REQUEST_KEY_INVALID",
      "Provide a stable 8–128 character request ID for retries",
      400
    );
  if (!RENTAL_EXPENSE_CATEGORIES.includes(input.category))
    throw new RentalAccountingError("RENTAL_CATEGORY_INVALID", "Invalid property expense category", 400);
  const amount = money(input.amountUsd);
  if (!amount.isFinite() || !amount.gt(0) || amount.decimalPlaces() > 6 || amount.abs().gte("100000000000000"))
    throw new RentalAccountingError(
      "RENTAL_AMOUNT_INVALID",
      "Enter a positive USD base allocation with up to 6 decimals",
      400
    );
  if ((input.note ?? "").length > 1000)
    throw new RentalAccountingError("RENTAL_NOTE_TOO_LONG", "Note maximum is 1,000 characters", 400);
  const contract = await verifyContract(tx, input);
  // Serialize allocation across all contracts on one voucher; an ordinary
  // row lock on one rental contract would not prevent overallocations across
  // different units. Requiring voucher lock also coordinates posting changes.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`rental-voucher-allocation:${input.companyId}:${input.voucherId}`}))`
  );
  await tx.execute(sql`SELECT id FROM vouchers WHERE company_id=${input.companyId}
   AND id=${input.voucherId} FOR UPDATE`);
  const previous = resultRows<
    {
      id: number;
      contract_id: number;
      voucher_id: number;
      module: string;
      category: string;
      allocated_usd: string;
      note: string | null;
      voided_at: string | null;
    } & Record<string, unknown>
  >(
    await tx.execute(sql`
    SELECT id,contract_id,voucher_id,module,category,allocated_usd::text,note,voided_at::text
    FROM accounting_rental_expense_links WHERE company_id=${input.companyId}
      AND client_request_key=${input.clientRequestKey} LIMIT 1
  `)
  )[0];
  if (previous) {
    if (
      previous.voided_at ||
      Number(previous.contract_id) !== input.contractId ||
      Number(previous.voucher_id) !== input.voucherId ||
      previous.module !== input.module ||
      previous.category !== input.category ||
      !money(previous.allocated_usd).eq(amount) ||
      (previous.note ?? null) !== (input.note ?? null)
    )
      throw new RentalAccountingError(
        "RENTAL_REQUEST_CONFLICT",
        "The request ID already belongs to a different or cancelled attribution",
        409
      );
    return { id: Number(previous.id), amountUsd: fmt(amount), replayed: true };
  }
  const voucher = await voucherExpenseTx(tx, input.companyId, input.voucherId);
  const reversal = resultRows<{ id: number } & Record<string, unknown>>(
    await tx.execute(sql`
   SELECT id FROM vouchers WHERE company_id=${input.companyId}
    AND reversal_of_voucher_id=${input.voucherId} AND deleted_at IS NULL
    AND optional=false LIMIT 1
 `)
  )[0];
  if (reversal)
    throw new RentalAccountingError(
      "RENTAL_VOUCHER_REVERSED",
      "A reversed expense voucher cannot receive new property expense allocations",
      409
    );
  const effective = fxDay(voucher.effective_on);
  const today = await companyBusinessDate(input.companyId, tx);
  if (effective > today)
    throw new RentalAccountingError(
      "RENTAL_VOUCHER_FUTURE",
      "An expense voucher dated in the future cannot be attributed as incurred",
      400
    );
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${today}::date)`);
  const rows = resultRows<{ total: string } & Record<string, unknown>>(
    await tx.execute(sql`
   SELECT COALESCE(SUM(allocated_usd),0)::text AS total
   FROM accounting_rental_expense_links
   WHERE company_id=${input.companyId} AND voucher_id=${input.voucherId}
    AND voided_at IS NULL
 `)
  );
  const allocated = money(rows[0]?.total);
  const capacity = money(voucher.posted_cost_usd);
  if (allocated.plus(amount).gt(capacity.plus("0.000001")))
    throw new RentalAccountingError(
      "RENTAL_OVERALLOCATION",
      `Expense allocation exceeds this voucher's available expense debit USD (${capacity.minus(allocated).toFixed(6)} remaining)`,
      409
    );
  const inserted = resultRows<{ id: number } & Record<string, unknown>>(
    await tx.execute(sql`
  INSERT INTO accounting_rental_expense_links
   (company_id,module,contract_id,unit_id,voucher_id,category,allocated_usd,note,tagged_by,client_request_key)
  VALUES(${input.companyId},${input.module},${input.contractId},${contract.unit_id},
   ${input.voucherId},${input.category},${fmt(amount)}::numeric,
   ${input.note ?? null},${input.actor.userId},${input.clientRequestKey})
  RETURNING id
 `)
  )[0];
  if (!inserted) throw new RentalAccountingError("RENTAL_LINK_FAILED", "Property expense was not linked");
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "create",
      tableName: "accounting_rental_expense_links",
      recordId: Number(inserted.id),
      recordIdentifier: `property-expense:${input.contractId}:${input.voucherId}`,
      changes: {
        contractId: { new: input.contractId },
        voucherId: { new: input.voucherId },
        category: { new: input.category },
        allocatedUsd: { new: fmt(amount) },
        note: { new: input.note ?? null },
      },
    },
    tx
  );
  return { id: Number(inserted.id), amountUsd: fmt(amount), replayed: false };
}
export async function voidRentalExpenseLinkTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    linkId: number;
    reason: string;
    actor: { userId: string; username: string };
  }
) {
  validId(input.companyId, "companyId");
  validId(input.linkId, "linkId");
  const reason = input.reason.trim();
  if (!reason || reason.length > 1000)
    throw new RentalAccountingError("RENTAL_VOID_REASON", "Enter a reason (1 to 1,000 characters)", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  const row = resultRows<LinkRow>(
    await tx.execute(sql`
 SELECT id,company_id,module,contract_id,unit_id,voucher_id,category,
   allocated_usd::text,note,tagged_at::text,voided_at::text,NULL::text AS voucher_number
 FROM accounting_rental_expense_links WHERE id=${input.linkId}
  AND company_id=${input.companyId} FOR UPDATE
 `)
  )[0];
  if (!row) throw new RentalAccountingError("RENTAL_LINK_NOT_FOUND", "Expense link not found", 404);
  if (row.voided_at) throw new RentalAccountingError("RENTAL_LINK_ALREADY_VOID", "Expense link already cancelled");
  const date = await companyBusinessDate(input.companyId, tx);
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${date}::date)`);
  await tx.execute(sql`
 UPDATE accounting_rental_expense_links
 SET voided_at=NOW(),voided_by=${input.actor.userId},void_reason=${reason}
 WHERE company_id=${input.companyId} AND id=${input.linkId} AND voided_at IS NULL
 `);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "void",
      tableName: "accounting_rental_expense_links",
      recordId: input.linkId,
      recordIdentifier: `property-expense-link:${input.linkId}`,
      changes: { voided: { old: false, new: true }, reason: { new: reason } },
    },
    tx
  );
  return { linkId: input.linkId, voided: true };
}
