/**
 * One-time, owner-approved HMD Kinshasa / EUROGULF freight reclassification.
 * Only a new October journal is created. Historical vouchers are never edited.
 *
 * Source: PO 618 / MRSU4898018, company 8:
 *   voucher 12869 credits EUROGULF $53,764.32 and double-debits Purchases by freight;
 *   voucher 13554 transfers only $41,793.20 from EUROGULF to parent credit.
 * The remaining $11,971.12 is parent-paid freight already credited separately
 * to HADI L'SHI Credit, leaving an erroneous subsidiary supplier payable.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { toMoney } from "../lib/money";
// prettier-ignore
import {
  postFactoryPartyLineVoucherTx,
} from "../services/factory/factoryVoucherPosting";
// prettier-ignore
import {
  createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext,
} from "../services/security/databaseScopeRuntimeContext";
// prettier-ignore
import { runAsSystemAuditActor, runWithAuditReason } from "../services/audit/auditActorContext";

const ENV = "ERP_HMD_EUROGULF_FREIGHT_REPAIR_20261018";
const ENABLE = "approved-company8-po618";
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const NUMBER = "ERP-HMD-EUROGULF-FREIGHT-RECLASS-20261018-599";
const AMOUNT = "11971.12";
const ORIGINAL = "11971.12";

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value);
// prettier-ignore
const eqMoney = (value: unknown, expected: string) =>
  toMoney(String(value ?? 0)).eq(expected);

// prettier-ignore
function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("HMD_ERR" + "_" + message);
}

// prettier-ignore
async function inspect(tx: DbTransaction): Promise<{ corrected: boolean; payable: string }> {
  const [company] = (await tx.execute(sql`
    SELECT id, parent_company_id, company_type FROM companies WHERE id=8
  `)).rows as Row[];
  must(company && n(company.parent_company_id) === 1 && company.company_type === "erp", "COMPANY_CHANGED");

  const [supplier] = (await tx.execute(sql`
    SELECT id, company_id, legal_name, deleted_at FROM suppliers WHERE id=5
  `)).rows as Row[];
  must(supplier && n(supplier.company_id) === 1 &&
    supplier.legal_name === "EUROGULF" && supplier.deleted_at == null, "SUPPLIER_CHANGED");

  const [container] = (await tx.execute(sql`
    SELECT id, company_id, supplier_id, container_number, grand_total,
           items_total, charges_total, status
    FROM containers WHERE company_id=8 AND id=599 FOR SHARE
  `)).rows as Row[];
  must(container && n(container.supplier_id) === 5 &&
    container.container_number === "MRSU4898018" &&
    container.status === "OTW" && eqMoney(container.grand_total, "53764.32") &&
    eqMoney(container.items_total, "41723.20") &&
    eqMoney(container.charges_total, "12041.12"), "CONTAINER_CHANGED");

  const [po] = (await tx.execute(sql`
    SELECT id, company_id, container_id, supplier_id, voucher_id, po_number,
           currency, items_total, freight, document_charges, freight_paid_by,
           freight_parent_account_id
    FROM purchase_orders WHERE company_id=8 AND id=618 FOR SHARE
  `)).rows as Row[];
  must(po && n(po.container_id) === 599 && n(po.supplier_id) === 5 &&
    n(po.voucher_id) === 12869 && po.po_number === "PO-2024-304" &&
    po.currency === "USD" && po.freight_paid_by === "parent" &&
    n(po.freight_parent_account_id) === 912 &&
    eqMoney(po.items_total, "41723.20") &&
    eqMoney(po.document_charges, "70.00") &&
    eqMoney(po.freight, AMOUNT), "PURCHASE_ORDER_CHANGED");

  const originalLines = (await tx.execute(sql`
    SELECT v.id AS voucher_id, v.voucher_number, v.voucher_type, v.deleted_at,
      v.optional, v.currency, e.id AS line_id, e.ledger_account_id, e.supplier_id,
      e.bank_account_id, e.customer_id, e.employee_id, e.fixed_asset_id,
      e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=8 AND v.id IN (12869,13554)
    ORDER BY v.id,e.id FOR SHARE OF v,e
  `)).rows as Row[];
  const expected = [
    [45229,12869,"PO-PO-2024-304-1787748634786","Purchase","ledger",355,"53764.32","0"],
    [45230,12869,"PO-PO-2024-304-1787748634786","Purchase","supplier",5,"0","53764.32"],
    [48532,12869,"PO-PO-2024-304-1787748634786","Purchase","ledger",355,"11971.12","0"],
    [48533,12869,"PO-PO-2024-304-1787748634786","Purchase","ledger",357,"0","11971.12"],
    [47691,13554,"INTERCO-PO-2024-304-SQLFIX-20260907","Journal","supplier",5,"41793.20","0"],
    [47692,13554,"INTERCO-PO-2024-304-SQLFIX-20260907","Journal","ledger",357,"0","41793.20"],
  ] as const;
  must(originalLines.length === expected.length, "SOURCE_LINE_COUNT_CHANGED");
  for (const [lineId, voucherId, voucherNumber, voucherType, kind, targetId, debit, credit] of expected) {
    const line = originalLines.find(r => n(r.line_id) === lineId);
    must(line && n(line.voucher_id) === voucherId &&
      line.voucher_number === voucherNumber &&
      line.voucher_type === voucherType &&
      line.deleted_at == null && line.optional === false && line.currency === "USD" &&
      n(line[kind === "ledger" ? "ledger_account_id" : "supplier_id"]) === targetId &&
      (kind === "supplier" ? line.ledger_account_id == null : line.supplier_id == null) &&
      line.bank_account_id == null && line.customer_id == null &&
      line.employee_id == null && line.fixed_asset_id == null &&
      eqMoney(line.debit_amount, debit) && eqMoney(line.credit_amount, credit),
      "ORIGINAL_LINE_CHANGED_" + lineId);
  }

  const repairLines = (await tx.execute(sql`
    SELECT v.id AS voucher_id, v.voucher_number, v.voucher_type, v.voucher_date,
       v.deleted_at, v.optional, v.currency, e.id AS line_id, e.ledger_account_id,
       e.supplier_id, e.bank_account_id, e.customer_id, e.employee_id,
       e.fixed_asset_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=8 AND v.voucher_number='ERP-HMD-EUROGULF-FREIGHT-RECLASS-20261018-599'
    ORDER BY e.id FOR SHARE OF v,e
  `)).rows as Row[];
  const corrected = repairLines.length !== 0;
  if (corrected) {
    must(repairLines.length === 2 &&
      repairLines.every(r => r.deleted_at == null && r.optional === false &&
        r.currency === "USD" && r.voucher_type === "Journal" &&
        r.bank_account_id == null && r.customer_id == null &&
        r.employee_id == null && r.fixed_asset_id == null), "REPAIR_EXISTS_BUT_DIFFERS");
    const dr = repairLines.find(r => n(r.supplier_id) === 5);
    const cr = repairLines.find(r => n(r.ledger_account_id) === 355);
    must(dr && cr && dr !== cr && dr.ledger_account_id == null &&
      cr.supplier_id == null && eqMoney(dr.debit_amount, AMOUNT) &&
      eqMoney(dr.credit_amount, "0") && eqMoney(cr.credit_amount, AMOUNT) &&
      eqMoney(cr.debit_amount, "0"), "REPAIR_LINE_MISMATCH");
  }

  const [sum] = (await tx.execute(sql`
    SELECT COALESCE(SUM(e.credit_amount-e.debit_amount),0)::text AS payable
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.company_id=8 AND v.deleted_at IS NULL AND v.optional=false
      AND e.supplier_id=5 AND e.ledger_account_id IS NULL
      AND e.bank_account_id IS NULL AND e.customer_id IS NULL
      AND e.employee_id IS NULL AND e.fixed_asset_id IS NULL
  `)).rows as Row[];
  const payable = toMoney(String(sum?.payable ?? 0)).toFixed(2);
  must(payable === (corrected ? "0.00" : ORIGINAL), "SUPPLIER_BALANCE_CHANGED_" + payable);

  const [net] = (await tx.execute(sql`
    SELECT
      COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER
        (WHERE e.ledger_account_id=355),0)::text AS purchases,
      COALESCE(SUM(e.credit_amount-e.debit_amount) FILTER
        (WHERE e.ledger_account_id=357),0)::text AS parent_credit
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    WHERE v.company_id=8 AND v.deleted_at IS NULL AND v.optional=false
      AND (v.id IN (12869,13554) OR
        v.voucher_number='ERP-HMD-EUROGULF-FREIGHT-RECLASS-20261018-599')
  `)).rows as Row[];
  must(eqMoney(net?.purchases, corrected ? "53764.32" : "65735.44") &&
    eqMoney(net?.parent_credit, "53764.32"), "JOURNAL_NETS_CHANGED");
  return { corrected, payable };
}

// prettier-ignore
export async function runApprovedHmdEurogulfFreightRepair(): Promise<void> {
  if (process.env[ENV] !== ENABLE) return;
  must(process.env.RENDER_SERVICE_ID === SERVICE, "WRONG_RENDER_SERVICE");
  const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
  must(database.rows[0]?.name === DATABASE, "WRONG_DATABASE");

  const result = await runAsSystemAuditActor("owner-approved-hmd-eurogulf-freight-20261018", () =>
    runWithAuditReason("Owner-approved PO-2024-304/MRSU4898018 freight duplicate reclassification; original vouchers preserved", () =>
      runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(8), () =>
        db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hmd-eurogulf-freight-20261018'))`);
          const before = await inspect(tx);
          if (before.corrected) return { posted: false, payable: before.payable };
          const posted = await postFactoryPartyLineVoucherTx(tx, {
            companyId: 8,
            voucherType: "Journal",
            voucherNumber: NUMBER,
            voucherDate: "2026-10-18",
            description: ["EUROGULF PO-2024-304/MRSU4898018:", "owner-approved duplicate freight correction.", "Clear $11,971.12 subsidiary payable and duplicated Purchases cost.", "Keep HADI L'SHI Credit unchanged."].join(" "),
            currency: "USD",
            sourceModule: "ERP",
            source: { sourceType: "erp-hmd-eurogulf-parent-freight-correction", sourceId: "8:618:599", phase: "owner-approved-20261018" },
            lines: [
              { supplierId: 5, debit: AMOUNT, narration: "Clear erroneous residual EUROGULF payable for parent-paid freight" },
              { ledgerAccountId: 355, credit: AMOUNT, narration: "Reverse duplicated freight debit in Purchases for PO-2024-304" },
            ],
          });
          must(!posted.replayed, "UNEXPECTED_POSTING_REPLAY");
          const after = await inspect(tx);
          must(after.corrected && after.payable === "0.00", "POSTCHECK_FAILED");
          return { posted: true, payable: after.payable, voucherId: posted.voucherId };
        })
      )
    )
  );
  logger.info("HMD_EUROGULF_FREIGHT_REPAIR_VERIFIED", result);
}
