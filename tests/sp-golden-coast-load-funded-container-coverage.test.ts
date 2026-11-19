/**
 * Golden Coast Phase 8 funded-container loader
 * (server/routes/sp/loadFundedContainer.ts) against the real schema in a
 * rolled-back transaction: wrong company, unfunded, cancelled and ambiguous
 * containers, every funding-shape corruption check for Phase 8, cutover and
 * Fresh Start origins, stock-item and line reconciliation refusals, and the
 * three successful origins.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { handleReadiness, loadFundedContainer } from "../server/routes/sp/loadFundedContainer";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;
type Line = [ledgerOrBank: { ledger?: number; bank?: number }, debit: number, credit: number];

async function world(client: PoolClient) {
  const tag = `GC${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
  // Every statement is a literal at its call site; this only reads the returned id.
  const one = async (pending: Promise<{ rows: Array<{ id: unknown }> }>) => Number((await pending).rows[0].id);
  const companyId = await one(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [tag])
  );
  const otherCompanyId = await one(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${tag}X`])
  );
  const ledger = (code: string, type: string, subType: string | null = null) =>
    one(
      client.query(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
        [companyId, `${tag}${code}`, type, subType]
      )
    );
  const accounts = {
    stockOtwAccountId: await ledger("OTW", "Asset"),
    stockInHandAccountId: await ledger("SIH", "Asset"),
    containerReserveAccountId: await ledger("RES", "Asset"),
    hassanEquityAccountId: await ledger("EQ", "Equity"),
    hassanSavingsAccountId: await ledger("SAV", "Asset"),
  };
  const cash = await ledger("CASH", "Cash");
  const clearing = await ledger("CLR", "Liability", "sp_otw_clearing");
  const bank = await one(
    client.query(
      `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name) VALUES ($1, $2, 'Main', '1', 'Bank') RETURNING id`,
      [companyId, `${tag}BK`]
    )
  );
  const itemId = await one(
    client.query(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'kg') RETURNING id`, [
      companyId,
      `${tag}SI`,
    ])
  );

  async function container(opts: {
    lines?: Line[];
    marker?: string | string[];
    migration?: boolean;
    status?: string;
    supplierName?: string;
    invoiceTotal?: string;
    containerLines?: Array<[qty: string, rate: string, stockItemId?: number]>;
    funded?: boolean;
  }) {
    const n = ++seq;
    let voucherId: number | null = null;
    if (opts.funded !== false) {
      voucherId = await one(
        client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, source_module)
         VALUES ($1, $2, 'Journal', '2026-06-01', 0, $3) RETURNING id`,
          [
            companyId,
            opts.migration ? `GC-OTW-${companyId}-${n}` : `${tag}-V${n}`,
            opts.migration ? "SP_MIGRATION" : null,
          ]
        )
      );
      for (const [target, debit, credit] of opts.lines ?? []) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
          [voucherId, target.ledger ?? null, target.bank ?? null, debit, credit]
        );
      }
      const markers = opts.marker === undefined ? [] : Array.isArray(opts.marker) ? opts.marker : [opts.marker];
      for (const [i, marker] of markers.entries()) {
        await client.query(
          `INSERT INTO accounting_posting_requests (company_id, source_type, source_id, voucher_id, idempotency_key, request_fingerprint)
           VALUES ($1, 'golden-coast-phase8-container', $2, $3, $4, $5)`,
          [companyId, marker, voucherId, `${tag}-${n}-${i}`, `${tag}${n}${i}`.padEnd(64, "0").slice(0, 64)]
        );
      }
    }
    const containerId = await one(
      client.query(
        `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, status, goods_otw_voucher_id, invoice_total_usd)
       VALUES ($1, '2026-06-01', $2, $3, $4, $5, $6) RETURNING id`,
        [
          companyId,
          `${tag}-INV${n}`,
          opts.supplierName ?? "Mill",
          opts.status ?? "open",
          voucherId,
          opts.invoiceTotal ?? "0",
        ]
      )
    );
    for (const [qty, rate, stockItemId] of opts.containerLines ?? [["10", "10"]]) {
      await client.query(
        `INSERT INTO sp_container_lines (company_id, container_id, stock_item_id, article_code, qty, unit_rate_usd)
         VALUES ($1, $2, $3, 'ART', $4, $5)`,
        [companyId, containerId, stockItemId ?? itemId, qty, rate]
      );
    }
    return containerId;
  }

  const load = (containerId: number, company = companyId) =>
    db.transaction((tx) => loadFundedContainer(tx as never, company, containerId, accounts));
  return { client, companyId, otherCompanyId, accounts, cash, clearing, bank, itemId, container, load };
}

const run = <T>(work: (w: Awaited<ReturnType<typeof world>>) => Promise<T>) =>
  withRolledBackPool(async (client) => work(await world(client)));

const refused = (promise: Promise<unknown>, code: string, status = 409) =>
  expect(promise).rejects.toMatchObject({ code, status });

describe("loadFundedContainer refusals before the funding shape", () => {
  it("refuses missing, foreign, unfunded and cancelled containers", () =>
    run(async (w) => {
      await refused(w.load(2_000_000_000), "GC_PHASE8_CONTAINER_NOT_FOUND", 404);
      const funded = await w.container({ marker: "x:fund", lines: [] });
      await refused(w.load(funded, w.otherCompanyId), "GC_PHASE8_CONTAINER_NOT_FOUND", 404);
      await refused(w.load(await w.container({ funded: false })), "GC_PHASE8_CONTAINER_NOT_FUNDED");
      await refused(w.load(await w.container({ status: "cancelled" })), "GC_PHASE8_CONTAINER_CLOSED");
    }));

  it("refuses ambiguous markers and unmarked non-migration vouchers", () =>
    run(async (w) => {
      await refused(w.load(await w.container({ marker: ["a:fund", "b:fund"] })), "GC_PHASE8_CONTAINER_NOT_FUNDED");
      await refused(w.load(await w.container({ marker: "a:other" })), "GC_PHASE8_CONTAINER_NOT_FUNDED");
      await refused(w.load(await w.container({})), "GC_PHASE8_CONTAINER_NOT_FUNDED");
    }));
});

describe("loadFundedContainer funding shapes", () => {
  it("loads a Phase 8 container funded from a bank with a reserve", () =>
    run(async (w) => {
      const id = await w.container({
        marker: "c1:fund",
        lines: [
          [{ ledger: w.accounts.stockOtwAccountId }, 100, 0],
          [{ ledger: w.accounts.containerReserveAccountId }, 20, 0],
          [{ bank: w.bank }, 0, 120],
        ],
      });
      expect(await w.load(id)).toMatchObject({
        origin: "phase8",
        goodsCostUsd: "100.00",
        reserveUsd: "20.00",
        fundingAccount: { kind: "bank", id: w.bank },
        lines: [{ stockItemId: w.itemId, qty: expect.any(String) }],
      });
    }));

  it("refuses broken Phase 8 shapes, funding accounts and balances", () =>
    run(async (w) => {
      const stock = { ledger: w.accounts.stockOtwAccountId };
      const twoStock = await w.container({
        marker: "a:fund",
        lines: [
          [stock, 50, 0],
          [stock, 50, 0],
          [{ ledger: w.cash }, 0, 100],
        ],
      });
      await refused(w.load(twoStock), "GC_PHASE8_FUNDING_CORRUPT");
      const nonCash = await w.container({
        marker: "b:fund",
        lines: [
          [stock, 100, 0],
          [{ ledger: w.accounts.hassanEquityAccountId }, 0, 100],
        ],
      });
      await refused(w.load(nonCash), "GC_PHASE8_FUNDING_ACCOUNT_INVALID", 400);
      await w.client.query(`UPDATE bank_accounts SET active = false WHERE id = $1`, [w.bank]);
      const inactiveBank = await w.container({
        marker: "c:fund",
        lines: [
          [stock, 100, 0],
          [{ bank: w.bank }, 0, 100],
        ],
      });
      await refused(w.load(inactiveBank), "GC_PHASE8_FUNDING_ACCOUNT_INVALID", 400);
      const unbalanced = await w.container({
        marker: "d:fund",
        lines: [
          [stock, 100, 0],
          [{ ledger: w.cash }, 0, 90],
        ],
      });
      await refused(w.load(unbalanced), "GC_PHASE8_FUNDING_CORRUPT");
      const noLines = await w.container({
        marker: "e:fund",
        lines: [
          [stock, 100, 0],
          [{ ledger: w.cash }, 0, 100],
        ],
        containerLines: [],
      });
      await expect(w.load(noLines)).rejects.toThrow("Funded container has no lines");
      const drift = await w.container({
        marker: "f:fund",
        lines: [
          [stock, 100, 0],
          [{ ledger: w.cash }, 0, 100],
        ],
        containerLines: [["10", "9"]],
      });
      await expect(w.load(drift)).rejects.toThrow(/no longer reconcile/);
      const inactiveItem = await w.client.query(
        `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Old', 'kg', false) RETURNING id`,
        [w.companyId, `OLD-${seq}`]
      );
      const badItem = await w.container({
        marker: "g:fund",
        lines: [
          [stock, 100, 0],
          [{ ledger: w.cash }, 0, 100],
        ],
        containerLines: [["10", "10", Number(inactiveItem.rows[0].id)]],
      });
      await refused(w.load(badItem), "GC_PHASE8_STOCK_ITEM_INVALID", 400);
    }));

  it("loads a cutover container and refuses a cutover reserve", () =>
    run(async (w) => {
      const stock = { ledger: w.accounts.stockOtwAccountId };
      const ok = await w.container({
        migration: true,
        lines: [
          [stock, 100, 0],
          [{ ledger: w.clearing }, 0, 100],
        ],
      });
      expect(await w.load(ok)).toMatchObject({ origin: "cutover", fundingAccount: { kind: "ledger", id: w.clearing } });
      const reserve = await w.container({
        migration: true,
        lines: [
          [stock, 100, 0],
          [{ ledger: w.accounts.containerReserveAccountId }, 5, 0],
          [{ ledger: w.clearing }, 0, 105],
        ],
      });
      await expect(w.load(reserve)).rejects.toThrow(/cannot carry a Phase 8 container reserve/);
      const broken = await w.container({ migration: true, lines: [[{ ledger: w.clearing }, 0, 100]] });
      await expect(w.load(broken)).rejects.toThrow(/Cutover Goods OTW voucher no longer has/);
    }));

  it("checks Fresh Start invoices against the clearing account, supplier and total", () =>
    run(async (w) => {
      const stock = { ledger: w.accounts.stockOtwAccountId };
      const fresh = (opts: {
        credit?: number;
        supplierName?: string;
        invoiceTotal?: string;
        lines?: Array<[string, string]>;
      }) =>
        w.container({
          marker: "inv:fresh-start-excel:fund",
          lines: [
            [stock, 100, 0],
            [{ ledger: opts.credit ?? w.clearing }, 0, 100],
          ],
          supplierName: opts.supplierName ?? "Fresh Start FZE",
          invoiceTotal: opts.invoiceTotal ?? "100",
          containerLines: opts.lines,
        });
      const ok = await fresh({ lines: [["1", "1"]] });
      expect(await w.load(ok)).toMatchObject({ origin: "fresh_start_excel", reserveUsd: "0.00" });
      await expect(w.load(await fresh({ credit: w.cash }))).rejects.toThrow(/Goods OTW Clearing/);
      await expect(w.load(await fresh({ supplierName: "Someone Else" }))).rejects.toThrow(/unexpected supplier link/);
      await expect(w.load(await fresh({ invoiceTotal: "90" }))).rejects.toThrow(/differs from Goods OTW voucher/);
    }));
});

describe("handleReadiness", () => {
  function fakeRes() {
    const res = { statusCode: 200, body: undefined as unknown };
    return Object.assign(res, {
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
    });
  }
  const call = async (companyId: number | undefined) => {
    const res = fakeRes();
    await handleReadiness({ session: { currentCompanyId: companyId } } as never, res as never);
    return res;
  };

  it("refuses missing and non supplier-partner companies, and reports blockers", () =>
    run(async (w) => {
      expect((await call(undefined)).statusCode).toBe(400);
      expect((await call(w.companyId)).statusCode).toBe(403);
      await w.client.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      await w.container({ funded: false });
      const ready = await call(w.companyId);
      expect(ready.statusCode).toBe(200);
      expect(ready.body).toMatchObject({ phase: 8, openContainers: 1, canPost: false });
      expect((ready.body as { blockers: string[] }).blockers.length).toBeGreaterThan(0);
    }));
});
