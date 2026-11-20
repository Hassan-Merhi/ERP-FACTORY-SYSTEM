/**
 * Phase 16 HADI remittance replay lookup: an exact cross-company replay
 * returns both vouchers; a reused clientRequestId with different routing, a
 * missing/altered voucher, altered lines and a one-sided marker pair are 409
 * conflicts; no markers means no replay. Also covers the tracked HADI sales
 * cash pool. Runs inside one rolled-back transaction.
 */
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import type { DatabaseTransaction } from "../server/routes/sp/goldenCoastPhase16LegacyHadiRetiredPayload";
import { findReplay, trackedHadiSalesCash } from "../server/routes/sp/spGoldenCoastPhase16HadiTransferGuardFindReplay";
import { GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE } from "../server/services/accounting/goldenCoastFreshStartHadiPayment";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  goldenCoastPhase7IdempotencyKey,
  goldenCoastPhase7SourceId,
  type GoldenCoastPhase7TransferInput,
} from "../server/services/accounting/goldenCoastPhase7HadiTransfer";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const DIGEST = "d".repeat(64);
const tx = db as unknown as DatabaseTransaction;
type Role = "golden_coast" | "hadi";

interface World {
  client: PoolClient;
  gc: number;
  hadi: number;
  gcCash: number;
  gcIc: number;
  hadiIc: number;
  hadiBank: number;
}

async function idOf(result: Promise<QueryResult<{ id: number }>>): Promise<number> {
  return Number((await result).rows[0].id);
}

async function withWorld(work: (world: World) => Promise<void>) {
  await withRolledBackPool(async (client) => {
    const tag = `P16${process.pid}${Date.now().toString(36)}`.toUpperCase().slice(0, 16);
    const company = (suffix: string) =>
      idOf(
        client.query<{ id: number }>(
          `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
          [`${tag}${suffix}`]
        )
      );
    const gc = await company("G");
    const hadi = await company("H");
    const ledger = (companyId: number, code: string, type: string) =>
      idOf(
        client.query<{ id: number }>(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
          [companyId, `${tag}${code}`, type]
        )
      );
    const world: World = {
      client,
      gc,
      hadi,
      gcCash: await ledger(gc, "C", "Cash"),
      gcIc: await ledger(gc, "I", "Asset"),
      hadiIc: await ledger(hadi, "I", "Liability"),
      hadiBank: await idOf(
        client.query<{ id: number }>(
          `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'HB', 'HB', '1') RETURNING id`,
          [hadi, `${tag}B`]
        )
      ),
    };
    await work(world);
  });
}

const pair = (w: World) => ({
  goldenCoastCompanyId: w.gc,
  goldenCoastCompanyName: "GC",
  hadiCompanyId: w.hadi,
  hadiCompanyName: "HADI",
});
const accounts = (w: World) => ({
  gcSalesCashAccountId: 1,
  goldenCoastHadiIntercompanyAccountId: w.gcIc,
  hadiGoldenCoastIntercompanyAccountId: w.hadiIc,
});
const transfer = (w: World, over: Partial<GoldenCoastPhase7TransferInput> = {}): GoldenCoastPhase7TransferInput => ({
  companyId: w.gc,
  parentCompanyId: 1,
  operation: "remit_from_hadi",
  transferDate: "2026-09-11",
  amountUsd: "250.00",
  clientRequestId: "remit-001",
  reference: null,
  hadiCashAccount: { kind: "bank", id: w.hadiBank },
  goldenCoastCashAccount: { kind: "ledger", id: w.gcCash },
  ...over,
});

interface Line {
  ledger?: number;
  bank?: number;
  dr: string;
  cr: string;
}

async function voucher(w: World, companyId: number, total: string, lines: Line[], deleted = false) {
  const id = await idOf(
    w.client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
     VALUES ($1, $2, 'Journal', '2026-09-11', $3, $4) RETURNING id`,
      [companyId, `P16-${Math.random().toString(36).slice(2, 10)}`, total, deleted ? new Date() : null]
    )
  );
  for (const line of lines) {
    await w.client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, line.ledger ?? null, line.bank ?? null, line.dr, line.cr]
    );
  }
  return id;
}

async function marker(w: World, role: Role, voucherId: number, sourceId?: string) {
  const companyId = role === "golden_coast" ? w.gc : w.hadi;
  await w.client.query(
    `INSERT INTO accounting_posting_requests (company_id, idempotency_key, request_fingerprint, source_id, source_type, voucher_id)
     VALUES ($1, $2, 'fp', $3, $4, $5)`,
    [
      companyId,
      goldenCoastPhase7IdempotencyKey(w.gc, "remit-001", role),
      sourceId ?? goldenCoastPhase7SourceId("remit_from_hadi", DIGEST, role),
      GOLDEN_COAST_PHASE7_SOURCE_TYPE,
      voucherId,
    ]
  );
}

const gcLines = (w: World): Line[] => [
  { ledger: w.gcCash, dr: "250", cr: "0" },
  { ledger: w.gcIc, dr: "0", cr: "250" },
];
const hadiLines = (w: World): Line[] => [
  { ledger: w.hadiIc, dr: "250", cr: "0" },
  { bank: w.hadiBank, dr: "0", cr: "250" },
];

const replay = (w: World, over: Partial<GoldenCoastPhase7TransferInput> = {}) =>
  findReplay(tx, pair(w), transfer(w, over), accounts(w), DIGEST);

describe("Phase 16 HADI remittance findReplay", () => {
  it("returns null when neither company holds a marker", async () => {
    await withWorld(async (w) => {
      expect(await replay(w)).toBeNull();
    });
  });

  it("returns both vouchers on an exact replay", async () => {
    await withWorld(async (w) => {
      const gcVoucher = await voucher(w, w.gc, "250", gcLines(w));
      const hadiVoucher = await voucher(w, w.hadi, "250", hadiLines(w));
      await marker(w, "golden_coast", gcVoucher);
      await marker(w, "hadi", hadiVoucher);
      const found = await replay(w);
      expect(found?.map((row) => [row.role, Number(row.voucher.id), row.entries.length])).toEqual([
        ["golden_coast", gcVoucher, 2],
        ["hadi", hadiVoucher, 2],
      ]);
    });
  });

  it("refuses a reused clientRequestId with different routing", async () => {
    await withWorld(async (w) => {
      const gcVoucher = await voucher(w, w.gc, "250", gcLines(w));
      await marker(w, "golden_coast", gcVoucher, "remit_from_hadi:other:golden_coast");
      await expect(replay(w)).rejects.toMatchObject({ code: "GC_PHASE16_IDEMPOTENCY_CONFLICT", status: 409 });
    });
  });

  it("refuses a marker whose voucher is deleted or carries another amount", async () => {
    await withWorld(async (w) => {
      await marker(w, "golden_coast", await voucher(w, w.gc, "250", gcLines(w), true));
      await expect(replay(w)).rejects.toMatchObject({
        code: "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
        message: expect.stringContaining("missing or altered voucher"),
      });
    });
    await withWorld(async (w) => {
      await marker(w, "golden_coast", await voucher(w, w.gc, "251", gcLines(w)));
      await expect(replay(w)).rejects.toMatchObject({ code: "GC_PHASE16_IDEMPOTENCY_INCONSISTENT" });
    });
  });

  it("refuses a voucher with the wrong number of lines", async () => {
    await withWorld(async (w) => {
      await marker(w, "golden_coast", await voucher(w, w.gc, "250", gcLines(w).slice(0, 1)));
      await expect(replay(w)).rejects.toMatchObject({ message: expect.stringContaining("entries were altered") });
    });
  });

  it("refuses altered Golden Coast lines, including a request without a Golden Coast cash account", async () => {
    await withWorld(async (w) => {
      await marker(
        w,
        "golden_coast",
        await voucher(w, w.gc, "250", [
          { ledger: w.gcCash, dr: "250", cr: "0" },
          { ledger: w.gcCash, dr: "0", cr: "250" },
        ])
      );
      await expect(replay(w)).rejects.toMatchObject({
        message: expect.stringContaining("Golden Coast remittance replay entries were altered"),
      });
    });
    await withWorld(async (w) => {
      await marker(w, "golden_coast", await voucher(w, w.gc, "250", gcLines(w)));
      await expect(replay(w, { goldenCoastCashAccount: null })).rejects.toMatchObject({
        message: expect.stringContaining("Golden Coast remittance replay entries were altered"),
      });
    });
  });

  it("refuses altered HADI lines", async () => {
    await withWorld(async (w) => {
      await marker(w, "golden_coast", await voucher(w, w.gc, "250", gcLines(w)));
      await marker(
        w,
        "hadi",
        await voucher(w, w.hadi, "250", [
          { ledger: w.hadiIc, dr: "250", cr: "0" },
          { ledger: w.hadiIc, dr: "0", cr: "250" },
        ])
      );
      await expect(replay(w)).rejects.toMatchObject({
        message: expect.stringContaining("HADI remittance replay entries were altered"),
      });
    });
  });

  it("refuses a partial cross-company replay pair", async () => {
    await withWorld(async (w) => {
      await marker(w, "hadi", await voucher(w, w.hadi, "250", hadiLines(w)));
      await expect(replay(w)).rejects.toMatchObject({ message: expect.stringContaining("partial cross-company") });
    });
  });
});

describe("trackedHadiSalesCash", () => {
  async function posted(w: World, sourceType: string, sourceId: string, total: string, key: string, deleted = false) {
    const id = await voucher(w, w.gc, total, [], deleted);
    await w.client.query(
      `INSERT INTO accounting_posting_requests (company_id, idempotency_key, request_fingerprint, source_id, source_type, voucher_id)
       VALUES ($1, $2, 'fp', $3, $4, $5)`,
      [w.gc, key, sourceId, sourceType, id]
    );
  }

  it("nets collections against remittances and direct Fresh Start payments", async () => {
    await withWorld(async (w) => {
      expect((await trackedHadiSalesCash(tx, w.gc)).toFixed(2)).toBe("0.00");
      await posted(w, GOLDEN_COAST_PHASE7_SOURCE_TYPE, "collect_via_hadi:x:golden_coast", "600", "k1");
      await posted(w, GOLDEN_COAST_PHASE7_SOURCE_TYPE, "collect_via_hadi:x:hadi", "999", "k2");
      await posted(w, GOLDEN_COAST_PHASE7_SOURCE_TYPE, "collect_via_hadi:y:golden_coast", "999", "k3", true);
      await posted(w, GOLDEN_COAST_PHASE7_SOURCE_TYPE, "remit_from_hadi:x:golden_coast", "250", "k4");
      await posted(w, GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE, "payment:x:golden_coast", "100", "k5");
      expect((await trackedHadiSalesCash(tx, w.gc)).toFixed(2)).toBe("250.00");
      await posted(w, GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE, "payment:z:golden_coast", "900", "k6");
      expect((await trackedHadiSalesCash(tx, w.gc)).toFixed(2)).toBe("0.00");
    });
  });
});
