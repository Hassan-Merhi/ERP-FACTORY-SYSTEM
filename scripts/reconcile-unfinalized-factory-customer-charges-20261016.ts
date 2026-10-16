/**
 * Repair historical CHARGE-PRE voucher postings made before invoice finalization.
 *
 * DRY RUN (no writes):
 *   npx tsx scripts/reconcile-unfinalized-factory-customer-charges-20261016.ts --company-id=12
 * APPLY after independently auditing each reported voucher:
 *   npx tsx scripts/reconcile-unfinalized-factory-customer-charges-20261016.ts --company-id=12 \
 *     --apply --confirm-voucher-ids=123,456
 *
 * Optional --customer-id=42 scopes dry-run/apply to a single customer.
 * No startup execution. No status changes, invoice changes or payment deletes.
 * The existing voucher-retirement service records an audit event and retains
 * every historical journal line, while removing both sides from live balances.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { toMoney } from "../server/lib/money";
import { retireVouchersTx } from "../server/services/accounting/voucherRetirement";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

interface Candidate {
  voucher_id: number;
  voucher_number: string;
  company_id: number;
  order_id: number;
  order_status: string;
  customer_id: number;
  customer_name: string;
  charge_id: number;
  charge_voucher_id: number | null;
  charge_amount: string;
  debits: string;
  credits: string;
  customer_debits: string;
  charge_account_credits: string;
  entry_count: number;
}

function positiveId(name: string): number | null {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  if (!raw && name === "customer-id") return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--${name}=<positive-id> is required`);
  return n;
}
const companyId = positiveId("company-id");
if (companyId === null) throw new Error("--company-id is required");
const customerId = positiveId("customer-id");
const apply = process.argv.includes("--apply");
const confirmation = process.argv.find((arg) => arg.startsWith("--confirm-voucher-ids="))
  ?.slice("--confirm-voucher-ids=".length) ?? "";
const confirmedIds = confirmation
  ? confirmation.split(",").map(Number).sort((a, b) => a - b)
  : [];

async function auditCandidates(): Promise<Candidate[]> {
  const result = await db.execute(sql`
    SELECT v.id AS voucher_id, v.voucher_number, v.company_id,
           o.id AS order_id, o.status AS order_status, o.customer_id,
           c.legal_name AS customer_name, ch.id AS charge_id,
           ch.voucher_id AS charge_voucher_id, ch.amount::text AS charge_amount,
           COUNT(ve.id)::int AS entry_count,
           COALESCE(SUM(COALESCE(ve.debit_amount,0)),0)::text AS debits,
           COALESCE(SUM(COALESCE(ve.credit_amount,0)),0)::text AS credits,
           COALESCE(SUM(COALESCE(ve.debit_amount,0)) FILTER (WHERE
               (ve.ledger_account_id = c.ledger_account_id AND c.ledger_account_id IS NOT NULL)
               OR (ve.ledger_account_id IS NULL AND ve.customer_id = c.id
                   AND ve.bank_account_id IS NULL AND ve.fixed_asset_id IS NULL
                   AND ve.supplier_id IS NULL AND ve.employee_id IS NULL
                   AND ve.factory_supplier_id IS NULL)
           ),0)::text AS customer_debits,
           COALESCE(SUM(COALESCE(ve.credit_amount,0)) FILTER (WHERE
               ve.ledger_account_id = ch.ledger_account_id
           ),0)::text AS charge_account_credits
      FROM customer_orders o
      JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
      JOIN customer_order_charges ch ON ch.order_id = o.id
      JOIN vouchers v ON v.company_id = o.company_id
                     AND v.voucher_number = 'CHARGE-PRE-' || o.id::text || '-' || ch.id::text
                     AND v.deleted_at IS NULL AND v.optional = false
      JOIN voucher_entries ve ON ve.voucher_id = v.id
     WHERE o.company_id = ${companyId}
       AND o.status IN ('DRAFT','LOADING','PENDING_VERIFICATION','VERIFIED','CANCELLED')
       AND (${customerId}::integer IS NULL OR o.customer_id = ${customerId})
     GROUP BY v.id, v.voucher_number, v.company_id, o.id, o.status, o.customer_id,
              c.legal_name, c.ledger_account_id, ch.id, ch.voucher_id,
              ch.ledger_account_id, ch.amount
     ORDER BY o.customer_id, o.id, ch.id
  `);
  return result.rows as unknown as Candidate[];
}

function errors(candidate: Candidate): string[] {
  const out: string[] = [];
  const amount = toMoney(candidate.charge_amount);
  if (!amount.greaterThan(0)) out.push("charge amount is not positive");
  if (candidate.entry_count !== 2) out.push("expected exactly two journal entries");
  if (candidate.charge_voucher_id !== null && Number(candidate.charge_voucher_id) !== Number(candidate.voucher_id))
    out.push("charge FK points to another voucher");
  if (!toMoney(candidate.debits).eq(amount)) out.push("voucher debits differ from charge amount");
  if (!toMoney(candidate.credits).eq(amount)) out.push("voucher credits differ from charge amount");
  if (!toMoney(candidate.customer_debits).eq(amount)) out.push("customer debit does not match");
  if (!toMoney(candidate.charge_account_credits).eq(amount)) out.push("charge-account credit does not match");
  return out;
}

async function run() {
  const snapshot = await auditCandidates();
  let blocked = 0;
  const ids = snapshot.map((v) => Number(v.voucher_id)).sort((a,b) => a-b);
  console.log(`Company ${companyId}, customer ${customerId ?? "ALL"}, mode ${apply ? "APPLY" : "DRY RUN"}`);
  for (const c of snapshot) {
    const failures = errors(c);
    if (failures.length) blocked++;
    console.log(JSON.stringify({
      voucherId: c.voucher_id, voucherNumber: c.voucher_number,
      customer: c.customer_name, customerId: c.customer_id,
      order: c.order_id, status: c.order_status,
      amount: c.charge_amount,
      safe: failures.length === 0,
      ...(failures.length ? { failures } : {}),
    }));
  }
  console.log(`Candidates=${snapshot.length}; blocked=${blocked}; voucherIDs=${ids.join(",")}`);
  if (!apply) {
    console.log("DRY RUN ONLY. Confirm these IDs against the ledger before applying any retirement.");
    return;
  }
  if (!ids.length || blocked) throw new Error("No safe set of vouchers to apply; refusing all writes");
  if (confirmedIds.length !== ids.length || confirmedIds.some((id, i) => id !== ids[i]))
    throw new Error("Confirmation ID set differs from current audited candidates; refusing all writes");
  await db.transaction(async (tx) => {
    // Lock the source invoices to prevent finalization during reconciliation.
    const lock = await tx.execute(sql`
      SELECT o.id, o.status
        FROM customer_orders o
       WHERE o.company_id = ${companyId}
         AND o.id IN (${sql.join(snapshot.map((v) => sql`${v.order_id}`), sql`, `)})
       ORDER BY o.id FOR UPDATE
    `);
    if (lock.rows.some((r) => r.status === "FINALIZED"))
      throw new Error("An invoice was finalized during reconciliation");
    const again = await auditCandidates();
    const liveIds = again.map((v) => Number(v.voucher_id)).sort((a,b) => a-b);
    if (liveIds.length !== ids.length || liveIds.some((id, i) => id !== ids[i]) ||
        again.some((v) => errors(v).length))
      throw new Error("Voucher evidence changed during reconciliation; refusing all writes");
    const retired = await retireVouchersTx(tx, {
      companyId, voucherIds: ids,
      reason: "unfinalized-factory-customer-charge-reconciliation-20261016",
      metadata: { customerId, orderIds: [...new Set(snapshot.map((v) => v.order_id))] },
    });
    if (retired.length !== ids.length)
      throw new Error("Not all vouchers were retired; rolling back");
    // No stale pointer may later cause an edit to revive a retired PRE voucher.
    for (const c of snapshot) {
      await tx.execute(sql`
        UPDATE customer_order_charges
           SET voucher_id = NULL
         WHERE id = ${c.charge_id} AND order_id = ${c.order_id}
           AND (voucher_id IS NULL OR voucher_id = ${c.voucher_id})
      `);
    }
  });
  console.log(`APPLIED ${ids.length} audited retirements. Review customer balances, trial balance and net position.`);
}

void runWithDatabaseScopeRuntimeContext(
  createTenantDatabaseScope(companyId), run
).catch((e) => { console.error(e); process.exitCode = 1; })
 .finally(() => pool.end());
