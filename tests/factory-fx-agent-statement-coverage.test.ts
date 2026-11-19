/**
 * Native EUR statements for Factory FX agent wallets (JSON, PDF, XLSX) over
 * HTTP against PostgreSQL, one rolled-back transaction per test: opening
 * balance from pre-period movements, every operation kind, deleted payouts
 * shown from the audit trail on request, and every refused date range, wallet
 * or inconsistent history.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (id: number | string, ext = "") => `/api/factory/fx-agent-wallets/${id}/statement${ext}`;
let seq = 0;

async function walletWorld(w: FactoryWorld, accountName = "Agent Paris") {
  const ledgerId = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, $2, $3, 'Asset', '0', TRUE) RETURNING id`,
    [w.companyId, `${w.tag}FX`, accountName]
  );
  const beneficiary = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, $2, 'Freight Payable', 'Liability', '0', TRUE) RETURNING id`,
    [w.companyId, `${w.tag}BEN`]
  );
  const supplier = await w.one(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Lyon Rags') RETURNING id`,
    [w.companyId]
  );
  const walletId = await w.one(
    `INSERT INTO factory_fx_agent_wallets (company_id, ledger_account_id, activated_on, opening_usd)
     VALUES ($1, $2, '2025-01-01', 0) RETURNING id`,
    [w.companyId, ledgerId]
  );
  const voucher = () =>
    w.one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, 'Payment', '2025-01-01', 0) RETURNING id`,
      [w.companyId, `${w.tag}V${++seq}`]
    );
  async function op(kind: string, date: string, amount: string, target?: { kind: string; id: number }) {
    const shape =
      kind === "USD_TO_EUR"
        ? { source: "USD", targetCurrency: "EUR", voucher: null, reverses: null }
        : kind === "EUR_TO_USD_REVERSAL"
          ? { source: "EUR", targetCurrency: "USD", voucher: null, reverses: firstOp }
          : { source: "EUR", targetCurrency: "USD", voucher: await voucher(), reverses: null };
    const id = await w.one(
      `INSERT INTO factory_fx_agent_wallet_operations (company_id, wallet_id, kind, effective_date, source_currency,
         source_amount, source_book_usd, target_currency, target_amount, rate_usd_per_eur, target_kind, target_id,
         voucher_id, reverses_operation_id, narration, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $6, 1.1, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        w.companyId,
        walletId,
        kind,
        date,
        shape.source,
        amount,
        shape.targetCurrency,
        target?.kind ?? null,
        target?.id ?? null,
        shape.voucher,
        shape.reverses,
        `note ${seq}`,
        `${w.tag}-op-${++seq}`,
      ]
    );
    firstOp ??= id;
    return id;
  }
  let firstOp: number | null = null;
  return { walletId, beneficiary, supplier, op };
}

describe("FX agent EUR statement JSON", () => {
  it("carries pre-period movements into the opening balance and describes each operation", async () => {
    await withFactoryWorld(async (w) => {
      const x = await walletWorld(w);
      await x.op("USD_TO_EUR", "2025-01-05", "100");
      await x.op("USD_TO_EUR", "2025-02-05", "50");
      await x.op("EUR_SETTLEMENT", "2025-02-06", "30", { kind: "ledger", id: x.beneficiary });
      await x.op("EUR_SETTLEMENT", "2025-02-07", "20", { kind: "factorySupplier", id: x.supplier });
      await x.op("EUR_TO_USD_REVERSAL", "2025-02-08", "10");
      const res = await w.agent.get(url(x.walletId)).query({ startDate: "2025-02-01", endDate: "2025-02-28" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({
        accountName: "Agent Paris",
        activatedOn: "2025-01-01",
        openingEur: "100.000000",
        totalEurIn: "50.000000",
        totalEurOut: "60.000000",
        closingEur: "90.000000",
      });
      expect(res.body.rows.map((r: any) => r.description)).toEqual([
        "USD converted to EUR",
        "EUR payment to Freight Payable",
        "EUR payment to Lyon Rags",
        "EUR conversion reversed",
      ]);
      const allTime = await w.agent.get(url(x.walletId)).query({ endDate: "2025-12-31" });
      expect(allTime.body).toMatchObject({ fromDate: null, openingEur: "0.000000", closingEur: "90.000000" });
      expect(allTime.body.rows).toHaveLength(5);
    });
  });

  it("shows deleted payouts from the audit trail only on request and never in balances", async () => {
    await withFactoryWorld(async (w) => {
      const x = await walletWorld(w);
      await x.op("USD_TO_EUR", "2025-03-01", "40");
      const audit = (old: unknown) =>
        w.q(
          `INSERT INTO audit_log (user_id, username, company_id, action, table_name, changes)
           VALUES ($1, 'tester', $2, 'delete', 'factory_fx_agent_wallet_operations', $3::jsonb)`,
          [
            w.userId,
            w.companyId,
            JSON.stringify({ reason: { new: "fx-agent-payment-cancel" }, nativeSettlement: { old } }),
          ]
        );
      const wallet = String(x.walletId);
      await audit({
        walletId: wallet,
        id: 9001,
        date: "2025-03-02",
        eurPaid: "5",
        rateUsdPerEur: "1.2",
        voucherId: 77,
        narration: "cancelled",
      });
      await audit({ walletId: wallet, id: 9002, date: "2025-03-03" });
      await audit({ walletId: wallet, id: 9003, date: "bad-date", eurPaid: "1" });
      await audit({ walletId: wallet, id: 9004, date: "2026-12-31", eurPaid: "1" });
      await audit({ walletId: wallet, id: 9005, date: "2025-01-01", eurPaid: "1" });
      await audit({ walletId: wallet, id: "x", date: "2025-03-04", eurPaid: "1" });
      await audit({ walletId: "999999", id: 9006, date: "2025-03-05", eurPaid: "1" });
      await audit(null);
      const query = { startDate: "2025-02-01", endDate: "2025-12-31" };
      const hidden = await w.agent.get(url(x.walletId)).query(query);
      expect(hidden.body.rows).toHaveLength(1);
      const shown = await w.agent.get(url(x.walletId)).query({ ...query, showDeleted: "true" });
      expect(shown.body.closingEur).toBe("40.000000");
      expect(shown.body.rows.map((r: any) => [r.id, r.deleted])).toEqual([
        [expect.any(Number), false],
        [9001, true],
        [9002, true],
      ]);
      expect(shown.body.rows[1]).toMatchObject({ eurOut: "5.000000", balance: "", voucherId: 77, detail: "cancelled" });
      expect(shown.body.rows[2]).toMatchObject({ eurOut: "0.000000", rateUsdPerEur: "0", voucherId: null, detail: "" });
    });
  });

  it("refuses bad dates, unknown wallets and an impossible negative balance", async () => {
    await withFactoryWorld(async (w) => {
      const x = await walletWorld(w);
      for (const query of [
        { startDate: "2025/01/01" },
        { endDate: ["2025-01-01", "2025-01-02"] },
        { endDate: "2999-01-01" },
        { startDate: "2025-03-01", endDate: "2025-02-01" },
        { startDate: "2025-02-30", endDate: "2025-03-01" },
      ]) {
        const res = await w.agent.get(url(x.walletId)).query(query);
        expect(res.status, JSON.stringify(query)).toBe(400);
      }
      expect((await w.agent.get(url("abc"))).body.message).toBe("Select a valid FX wallet");
      expect((await w.agent.get(url(999999999))).body.message).toBe("FX wallet not found in this company");
      await x.op("EUR_SETTLEMENT", "2025-01-02", "5", { kind: "ledger", id: x.beneficiary });
      const negative = await w.agent.get(url(x.walletId)).query({ endDate: "2025-12-31" });
      expect(negative.status).toBe(400);
      expect(negative.body.message).toBe("Invalid negative EUR wallet balance");
      expect((await w.agent.get(url(x.walletId, ".pdf")).query({ endDate: "2025-12-31" })).status).toBe(400);
      expect((await w.agent.get(url(x.walletId, ".xlsx")).query({ endDate: "2025-12-31" })).status).toBe(400);
    });
  });
});

const binary = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

describe("FX agent EUR statement downloads", () => {
  it("renders a multi-page PDF and a workbook with deleted rows marked", async () => {
    await withFactoryWorld(async (w) => {
      const x = await walletWorld(w, "Agent / Paris & Co");
      await x.op("USD_TO_EUR", "2025-01-02", "500");
      for (let day = 3; day <= 28; day++) {
        await x.op("EUR_SETTLEMENT", `2025-01-${String(day).padStart(2, "0")}`, "1", {
          kind: "ledger",
          id: x.beneficiary,
        });
      }
      await w.q(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, changes)
         VALUES ($1, 'tester', $2, 'delete', 'factory_fx_agent_wallet_operations', $3::jsonb)`,
        [
          w.userId,
          w.companyId,
          JSON.stringify({
            reason: { new: "fx-agent-payment-cancel" },
            nativeSettlement: { old: { walletId: String(x.walletId), id: 9100, date: "2025-01-29", eurPaid: "3" } },
          }),
        ]
      );
      const query = { endDate: "2025-12-31", showDeleted: "true" };
      const pdf = await w.agent.get(url(x.walletId, ".pdf")).query(query).buffer(true).parse(binary);
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      expect(pdf.headers["content-disposition"]).toContain("Agent_Paris_Co_EUR_Statement.pdf");
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      expect((pdf.body as Buffer).toString("latin1").match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);

      const xlsx = await w.agent
        .get(url(x.walletId, ".xlsx"))
        .query({ ...query, startDate: "2025-01-10" })
        .buffer(true)
        .parse(binary);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers["content-disposition"]).toContain("_EUR_Statement.xlsx");
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(xlsx.body);
      const sheet = book.getWorksheet("EUR Ledger")!;
      expect(sheet.getCell("A3").value).toBe("Period: 2025-01-10 to 2025-12-31");
      const values = sheet.getSheetValues().map((row) => (Array.isArray(row) ? row.slice(1) : []));
      expect(values.some((row) => row[0] === "Opening Balance" || row[1] === "Opening Balance")).toBe(true);
      expect(values.some((row) => String(row[2] ?? "").includes("DELETED (not in balances)"))).toBe(true);
    });
  });
});
