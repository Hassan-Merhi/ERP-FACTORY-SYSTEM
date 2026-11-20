/**
 * Phase 10 Fresh Start payment replay lookup: exact replay returns the stored
 * voucher; a reused clientRequestId with a different payload, a missing
 * voucher and drifted voucher lines are refused as 409 conflicts; no marker
 * means no replay. Also covers the payment-account list and the GC Sales Cash
 * balance reader. Everything runs inside one rolled-back transaction.
 */
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import {
  findReplayedSettlement,
  gcSalesCashDebitBalance,
  listPaymentAccounts,
} from "../server/routes/sp/findReplayedSettlement";
import type { DatabaseTransaction } from "../server/routes/sp/spGoldenCoastPhase10SalesCashSettlementRoutesValidatePaymentAccount";
import {
  goldenCoastPhase10IdempotencyKey,
  type GoldenCoastPhase10SettlementInput,
} from "../server/services/accounting/goldenCoastPhase10SalesCashSettlement";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const DIGEST = "a".repeat(64);
const tx = db as unknown as DatabaseTransaction;

interface World {
  client: PoolClient;
  companyId: number;
  salesCash: number;
  cash: number;
  fee: number;
  bank: number;
}

async function idOf(result: Promise<QueryResult<{ id: number }>>): Promise<number> {
  return Number((await result).rows[0].id);
}

async function withWorld(work: (world: World) => Promise<void>) {
  await withRolledBackPool(async (client) => {
    const tag = `FRS${process.pid}${Date.now().toString(36)}`.toUpperCase().slice(0, 18);
    const companyId = await idOf(
      client.query<{ id: number }>(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [tag]
      )
    );
    const ledger = (code: string, name: string, type: string, opening: string, side: string, active = true) =>
      idOf(
        client.query<{ id: number }>(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [companyId, code, name, type, opening, side, active]
        )
      );
    const salesCash = await ledger(`${tag}S`, "GC Sales Cash", "Liability", "100", "Cr");
    const cash = await ledger(`${tag}C`, "Alpha Cash", "Cash", "0", "Dr");
    const fee = await ledger(`${tag}F`, "Shared Charges", "Expense", "0", "Dr");
    await ledger(`${tag}X`, "Inactive Bank", "Bank", "0", "Dr", false);
    const bank = await idOf(
      client.query<{ id: number }>(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Beta Bank', 'B', '1') RETURNING id`,
        [companyId, `${tag}B`]
      )
    );
    await work({ client, companyId, salesCash, cash, fee, bank });
  });
}

function settlement(world: World, over: Partial<GoldenCoastPhase10SettlementInput> = {}) {
  return {
    companyId: world.companyId,
    settlementDate: "2026-03-01",
    amountUsd: "40.00",
    transferFeeUsd: "0",
    clientRequestId: "req-1",
    paymentAccount: { kind: "ledger", id: world.cash },
    reference: null,
    ...over,
  } as GoldenCoastPhase10SettlementInput;
}

async function storeVoucher(
  world: World,
  total: string,
  lines: Array<{ ledger?: number; bank?: number; dr: string; cr: string }>,
  opts: { sourceId?: string; deleted?: boolean; date?: string } = {}
) {
  const voucherId = await idOf(
    world.client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
     VALUES ($1, $2, 'Payment', $3, $4, $5) RETURNING id`,
      [
        world.companyId,
        `FRS-${Math.random().toString(36).slice(2, 10)}`,
        opts.date ?? "2026-03-01",
        total,
        opts.deleted ? new Date() : null,
      ]
    )
  );
  for (const line of lines) {
    await world.client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [voucherId, line.ledger ?? null, line.bank ?? null, line.dr, line.cr]
    );
  }
  await world.client.query(
    `INSERT INTO accounting_posting_requests (company_id, idempotency_key, request_fingerprint, source_id, source_type, voucher_id)
     VALUES ($1, $2, 'fp', $3, 'gc_phase10', $4)`,
    [
      world.companyId,
      goldenCoastPhase10IdempotencyKey(world.companyId, "req-1"),
      opts.sourceId ?? `settlement:${DIGEST}`,
      voucherId,
    ]
  );
  return voucherId;
}

describe("findReplayedSettlement", () => {
  it("returns null when no idempotency marker exists", async () => {
    await withWorld(async (world) => {
      expect(await findReplayedSettlement(tx, world.companyId, settlement(world), world.salesCash, DIGEST)).toBeNull();
    });
  });

  it("refuses a reused clientRequestId with a different payload digest", async () => {
    await withWorld(async (world) => {
      await storeVoucher(world, "40.00", [], { sourceId: `settlement:${"b".repeat(64)}` });
      await expect(
        findReplayedSettlement(tx, world.companyId, settlement(world), world.salesCash, DIGEST)
      ).rejects.toMatchObject({ code: "GC_PHASE10_IDEMPOTENCY_CONFLICT", status: 409 });
    });
  });

  it("refuses a marker whose voucher was deleted", async () => {
    await withWorld(async (world) => {
      await storeVoucher(world, "40.00", [], { deleted: true });
      await expect(
        findReplayedSettlement(tx, world.companyId, settlement(world), world.salesCash, DIGEST)
      ).rejects.toMatchObject({ code: "GC_PHASE10_IDEMPOTENCY_INCONSISTENT", status: 409 });
    });
  });

  it("refuses a voucher whose line count or total drifted", async () => {
    await withWorld(async (world) => {
      await storeVoucher(world, "41.00", [
        { ledger: world.salesCash, dr: "40", cr: "0" },
        { ledger: world.cash, dr: "0", cr: "40" },
      ]);
      await expect(
        findReplayedSettlement(tx, world.companyId, settlement(world), world.salesCash, DIGEST)
      ).rejects.toMatchObject({ message: expect.stringContaining("no longer matches its idempotency marker") });
    });
  });

  it("refuses a voucher whose routing no longer matches the request", async () => {
    await withWorld(async (world) => {
      await storeVoucher(world, "40.00", [
        { ledger: world.salesCash, dr: "40", cr: "0" },
        { ledger: world.fee, dr: "0", cr: "40" },
      ]);
      await expect(
        findReplayedSettlement(tx, world.companyId, settlement(world), world.salesCash, DIGEST)
      ).rejects.toMatchObject({ message: expect.stringContaining("payment routing") });
    });
  });

  it("refuses a fee-bearing voucher whose fee line is missing", async () => {
    await withWorld(async (world) => {
      await storeVoucher(world, "45.00", [
        { ledger: world.salesCash, dr: "40", cr: "0" },
        { bank: world.bank, dr: "0", cr: "45" },
        { ledger: world.salesCash, dr: "5", cr: "0" },
      ]);
      const input = settlement(world, { transferFeeUsd: "5", paymentAccount: { kind: "bank", id: world.bank } });
      await expect(findReplayedSettlement(tx, world.companyId, input, world.salesCash, DIGEST)).rejects.toMatchObject({
        code: "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      });
    });
  });

  it("returns the stored voucher on an exact replay through a bank account with a fee", async () => {
    await withWorld(async (world) => {
      const voucherId = await storeVoucher(world, "45.00", [
        { ledger: world.salesCash, dr: "40", cr: "0" },
        { bank: world.bank, dr: "0", cr: "45" },
        { ledger: world.fee, dr: "5", cr: "0" },
      ]);
      const input = settlement(world, { transferFeeUsd: "5", paymentAccount: { kind: "bank", id: world.bank } });
      const replay = await findReplayedSettlement(tx, world.companyId, input, world.salesCash, DIGEST);
      expect(Number(replay?.voucher.id)).toBe(voucherId);
      expect(replay?.entries).toHaveLength(3);
    });
  });

  it("returns the stored voucher on an exact replay through a ledger cash account", async () => {
    await withWorld(async (world) => {
      const voucherId = await storeVoucher(world, "40.00", [
        { ledger: world.salesCash, dr: "40", cr: "0" },
        { ledger: world.cash, dr: "0", cr: "40" },
      ]);
      const replay = await findReplayedSettlement(tx, world.companyId, settlement(world), world.salesCash, DIGEST);
      expect(Number(replay?.voucher.id)).toBe(voucherId);
    });
  });
});

describe("Phase 10 payment accounts and GC Sales Cash balance", () => {
  it("lists only active cash/bank ledgers and active bank accounts", async () => {
    await withWorld(async (world) => {
      const accounts = await listPaymentAccounts(db, world.companyId);
      expect(accounts).toEqual([
        { kind: "ledger", id: world.cash, name: "Alpha Cash", type: "Cash" },
        { kind: "bank", id: world.bank, name: "Beta Bank", type: "Bank Account" },
      ]);
    });
  });

  it("signs a credit opening balance negative and honours the cutoff date", async () => {
    await withWorld(async (world) => {
      await storeVoucher(
        world,
        "40.00",
        [
          { ledger: world.salesCash, dr: "40", cr: "0" },
          { ledger: world.cash, dr: "0", cr: "40" },
        ],
        { date: "2026-03-10" }
      );
      expect(Number(await gcSalesCashDebitBalance(db, world.companyId, world.salesCash))).toBe(-60);
      expect(Number(await gcSalesCashDebitBalance(db, world.companyId, world.salesCash, "2026-03-01"))).toBe(-100);
      expect(Number(await gcSalesCashDebitBalance(db, world.companyId, world.cash))).toBe(-40);
    });
  });

  it("refuses with a 409 when the account is missing", async () => {
    await withWorld(async (world) => {
      await expect(gcSalesCashDebitBalance(db, world.companyId, world.salesCash + 999999)).rejects.toMatchObject({
        code: "GC_PHASE10_ACCOUNT_INVALID",
        status: 409,
      });
    });
  });
});
