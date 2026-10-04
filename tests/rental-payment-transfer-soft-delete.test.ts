/**
 * Deleting a rental payment takes its auto-transfer vouchers (one in each
 * company) out of the books. They used to be hard-deleted with their entries,
 * so the destination company lost the record of money it had been told it
 * received. They are now soft-deleted like the payment's own voucher: out of
 * every balance, still present with their entries for the audit trail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { deleteRentalPaymentGroup } from "../server/services/rental/rentalPaymentDeletionService";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const SOURCE = "rentsoftsrc";
const DEST = "rentsoftdst";

let src: TestContext;
let dst: TestContext;
let unitId: number;
const transferVoucherIds: number[] = [];

async function journal(companyId: number, number: string, debitAccountId: number, creditAccountId: number) {
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId,
      voucherNumber: number,
      voucherType: "Payment",
      voucherDate: "2026-06-01",
      totalAmount: "75.00",
    })
    .returning();
  await db.insert(schema.voucherEntries).values([
    { voucherId: voucher.id, ledgerAccountId: debitAccountId, debitAmount: "75.00", creditAmount: "0" },
    { voucherId: voucher.id, ledgerAccountId: creditAccountId, debitAmount: "0", creditAmount: "75.00" },
  ]);
  return voucher.id;
}

beforeAll(async () => {
  src = await seedTestData(SOURCE);
  dst = await seedTestData(DEST);

  const [unit] = await db
    .insert(schema.propertyUnits)
    .values({ companyId: src.companyId, unitType: "Shop", locationGroup: "Test", unitNumber: `${SOURCE}-U1` })
    .returning();
  unitId = unit.id;
}, 120000);

afterAll(async () => {
  await db
    .delete(schema.interCompanyTransfers)
    .where(inArray(schema.interCompanyTransfers.fromCompanyId, [src.companyId]));
  await db.delete(schema.propertyPayments).where(eq(schema.propertyPayments.companyId, src.companyId));
  await db.delete(schema.propertyUnits).where(eq(schema.propertyUnits.id, unitId));
  await cleanupTestData(SOURCE);
  await cleanupTestData(DEST);
  closeTestServer();
}, 90000);

describe("rental payment deletion", () => {
  it("soft-deletes the linked transfer vouchers in both companies and keeps their entries", async () => {
    const paymentVoucherId = await journal(src.companyId, `${SOURCE}-PAY`, src.cashAccountId, src.salesAccountId);
    const [payment] = await db
      .insert(schema.propertyPayments)
      .values({
        companyId: src.companyId,
        module: "PROPERTIES",
        contractId: 1,
        unitId,
        voucherId: paymentVoucherId,
        amount: "75.00",
        paymentDate: "2026-06-01",
        forYear: 2026,
        forMonth: 6,
      })
      .returning();

    const fromVoucherId = await journal(src.companyId, `${SOURCE}-TR-OUT`, src.salesAccountId, src.cashAccountId);
    const toVoucherId = await journal(dst.companyId, `${DEST}-TR-IN`, dst.cashAccountId, dst.salesAccountId);
    transferVoucherIds.push(fromVoucherId, toVoucherId);
    await db.insert(schema.interCompanyTransfers).values({
      transferType: "Cash",
      fromCompanyId: src.companyId,
      toCompanyId: dst.companyId,
      transferDate: "2026-06-01",
      amount: "75.00",
      fromLedgerAccountId: src.cashAccountId,
      toLedgerAccountId: dst.cashAccountId,
      fromVoucherId,
      toVoucherId,
      sourcePaymentId: payment.id,
    });

    const result = await deleteRentalPaymentGroup({
      companyId: src.companyId,
      module: "PROPERTIES",
      paymentId: payment.id,
    });
    expect(result.found).toBe(true);

    const transferVouchers = await db
      .select()
      .from(schema.vouchers)
      .where(inArray(schema.vouchers.id, transferVoucherIds));
    expect(transferVouchers).toHaveLength(2);
    for (const voucher of transferVouchers) expect(voucher.deletedAt).not.toBeNull();

    const entries = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM voucher_entries WHERE voucher_id = ANY($1::int[])",
      [transferVoucherIds]
    );
    expect(Number(entries.rows[0].count)).toBe(4);
  });
});
