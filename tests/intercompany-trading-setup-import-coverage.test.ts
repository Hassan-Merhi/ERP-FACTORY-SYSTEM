/**
 * Properties -> ERP container trading: setup lookup, the trusted-pair scope and
 * the first posting step of the workbook import (getTradingSetup.ts), driven
 * through postIntercompanyImport with an in-memory parsed workbook on the
 * intercompany trade fixture, inside one rolled-back transaction per test.
 *
 * Refusals first: wrong role, a non-Properties source, disabled or missing
 * relationships, a destination outside the user's companies, a replayed file,
 * an existing container, a foreign or mismatched external supplier, mistyped
 * or shared accounts, a wrong partner supplier, a non-USD destination and a
 * mapping that changed after preview. Each refusal leaves no import batch.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import { db } from "../server/db";
import { postIntercompanyImport } from "../server/services/intercompany/containerTradingImport";
import {
  assertUsdPair,
  eligibleDestinations,
  getTradingSetup,
  postIntercompanyImportTxStep1,
  validatedAccounts,
  withinTrustedPair,
  type Policy,
} from "../server/services/intercompany/getTradingSetup";
import type { WorkbookPreview } from "../server/services/intercompany/containerTradingWorkbook";
import { validateWorkbookSelections } from "../server/services/intercompany/containerTradingWorkbook";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { runWithCompanyRequestRuntimeContext } from "../server/services/security/companyRequestRuntimeContext";

function world<T>(work: (w: IntercompanyTradeWorld) => Promise<T>) {
  return withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));
}

/** A one-container, one-line workbook whose only item is verified Properties stock. */
async function workbook(w: IntercompanyTradeWorld, overrides: { supplierCode?: string; container?: string } = {}) {
  const code = `SI-${w.tag}`;
  await w.q(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'kg') ON CONFLICT DO NOTHING`,
    [w.sourceCompanyId, code]
  );
  const [ext] = await w.q<{ code: string }>(`SELECT code FROM suppliers WHERE id = $1`, [w.externalSupplierId]);
  const containerNumber = overrides.container ?? `${w.tag}NEW`;
  const supplierCode = overrides.supplierCode ?? ext.code;
  const preview: WorkbookPreview = {
    fileName: "trade.xlsx",
    sha256: createHash("sha256").update(`${w.tag}${containerNumber}`).digest("hex"),
    md5: createHash("md5").update(`${w.tag}${containerNumber}`).digest("hex"),
    rowCount: 1,
    containers: [
      {
        containerNumber,
        supplierCode,
        itemsCount: 1,
        posCount: 1,
        itemsTotal: 10,
        charges: { freight: 0, surcharge: 0, fumigation: 0, discount: 0, documentCharges: 0 },
        chargesTotal: 0,
        grandTotal: 10,
        pos: ["PO-1"],
        items: [
          {
            rowNum: 2,
            poNumber: "PO-1",
            containerNumber,
            supplierCode,
            barcode: code,
            stockItemId: null,
            itemName: "Bales",
            quantity: 2,
            rate: 5,
            lineTotal: 10,
            currency: "USD",
            freight: 0,
            surcharge: 0,
            fumigation: 0,
            discount: 0,
            documentCharges: 0,
          },
        ],
      },
    ],
  };
  const input = {
    externalSupplierId: w.externalSupplierId,
    importDate: "2026-06-01",
    selections: [{ containerNumber, relationshipId: w.relationshipId, chargesConfirmed: true }],
  };
  return { preview, input };
}

const batches = async (w: IntercompanyTradeWorld) =>
  Number(
    (
      await w.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM intercompany_import_batches WHERE source_company_id = $1`,
        [w.sourceCompanyId]
      )
    )[0].n
  );

async function importAs(
  w: IntercompanyTradeWorld,
  wb: Awaited<ReturnType<typeof workbook>>,
  opts: { role?: string; userId?: string; sourceCompanyId?: number } = {}
) {
  return postIntercompanyImport({
    sourceCompanyId: opts.sourceCompanyId ?? w.sourceCompanyId,
    userId: opts.userId ?? w.userId,
    username: "owner",
    role: opts.role ?? "Owner",
    preview: wb.preview,
    input: wb.input,
  });
}

async function refused(w: IntercompanyTradeWorld, run: () => Promise<unknown>, pattern: RegExp, status = 400) {
  const before = await batches(w);
  await expect(run()).rejects.toMatchObject({ status, message: expect.stringMatching(pattern) });
  expect(await batches(w)).toBe(before);
}

describe("trading setup and destinations", () => {
  it("lists the owned ERP destinations with their accounts, suppliers and policies", () =>
    world(async (w) => {
      const setup = await getTradingSetup(w.sourceCompanyId, w.userId, "Owner");
      expect(setup.destinations.map((d) => d.id)).toEqual([w.destinationCompanyId]);
      expect(setup.accounts.map((a) => a.id)).toEqual(
        expect.arrayContaining([w.accounts.sourceReceivableAccountId, w.accounts.destinationGitAccountId])
      );
      expect(setup.suppliers.map((s) => s.id)).toEqual(
        expect.arrayContaining([w.externalSupplierId, w.partnerSupplierId])
      );
      expect(setup.policies.map((p) => p.id)).toEqual([w.relationshipId]);
    }));

  it("lets a Developer see every active ERP company, and refuses other roles and non-Properties sources", () =>
    world(async (w) => {
      const all = await eligibleDestinations(w.sourceCompanyId, w.userId, "Developer");
      expect(all.map((d) => d.id)).toContain(w.destinationCompanyId);
      expect(all.every((d) => d.companyType === "erp")).toBe(true);
      const loner = await w.otherUser([[w.sourceCompanyId, "Owner"]]);
      expect(await eligibleDestinations(w.sourceCompanyId, loner, "Owner")).toEqual([]);
      await expect(getTradingSetup(w.sourceCompanyId, w.userId, "Admin")).rejects.toThrow(/Only Owners and Developers/);
      await expect(getTradingSetup(w.destinationCompanyId, w.userId, "Owner")).rejects.toThrow(
        /only from an active Properties company/
      );
    }));
});

describe("trusted pair scope and account checks", () => {
  it("refuses a tenant scope of another company and widens a request context to the destinations", async () => {
    expect(() =>
      runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(7, [7]), () =>
        withinTrustedPair(5, [6], async () => 1)
      )
    ).toThrow(/Company context differs/);
    const seen = await runWithCompanyRequestRuntimeContext(
      { userId: "u", companyId: 5, role: "Owner", method: "GET", path: "/x", developerBypass: false },
      () => withinTrustedPair(5, [6, 8], async () => "ok")
    );
    expect(seen).toBe("ok");
    expect(await withinTrustedPair(5, [6], async () => "plain")).toBe("plain");
  });

  it("checks every mapped account's company and type, and that both companies are USD-based", () => {
    const policy = {
      sourceCompanyId: 1,
      destinationCompanyId: 2,
      sourceReceivableAccountId: 10,
      destinationPayableAccountId: 20,
      sourceSalesAccountId: 11,
      sourcePurchaseAccountId: 12,
      sourceCostAccountId: 13,
      sourceChargeAccrualAccountId: 14,
      destinationGitAccountId: 21,
    } as Policy;
    const acct = (id: number, companyId: number, accountType: string, deletedAt: Date | null = null) =>
      ({ id, companyId, accountType, deletedAt }) as never;
    const all = [
      acct(10, 1, "Asset"),
      acct(20, 2, "Liability"),
      acct(11, 1, "Income"),
      acct(12, 1, "Expense"),
      acct(13, 1, "Cost of Sales"),
      acct(14, 1, "Liability"),
      acct(21, 2, "Asset"),
    ];
    expect(validatedAccounts(policy, all)).toEqual({
      ar: 10,
      ap: 20,
      sales: 11,
      purchase: 12,
      cogs: 13,
      charges: 14,
      git: 21,
    });
    expect(() => validatedAccounts(policy, [...all.slice(1), acct(10, 1, "Asset", new Date())])).toThrow(/Receivable/);
    expect(() => validatedAccounts({ ...policy, sourceSalesAccountId: 12 }, all)).toThrow(/Sales must be/);
    expect(() => assertUsdPair({ baseCurrency: null }, { baseCurrency: "usd" })).not.toThrow();
    expect(() => assertUsdPair({ baseCurrency: "USD" }, { baseCurrency: "ZMW" })).toThrow(/USD-base/);
  });
});

describe("container import refusals before posting", () => {
  it("refuses wrong roles, sources, relationships and destinations", () =>
    world(async (w) => {
      const wb = await workbook(w);
      await refused(w, () => importAs(w, wb, { role: "Manager" }), /Only Owners and Developers/);
      await refused(w, () => importAs(w, wb, { sourceCompanyId: w.destinationCompanyId }), /Properties company/);
      const loner = await w.otherUser([[w.sourceCompanyId, "Owner"]]);
      await refused(w, () => importAs(w, wb, { userId: loner }), /do not have access to the destination/);
      await w.q(`UPDATE intercompany_relationship_policies SET trade_enabled = FALSE WHERE id = $1`, [
        w.relationshipId,
      ]);
      await refused(w, () => importAs(w, wb), /disabled for this relationship/);
      const missing = {
        ...wb,
        input: { ...wb.input, selections: [{ ...wb.input.selections[0], relationshipId: 999999999 }] },
      };
      await refused(w, () => importAs(w, missing), /Select configured relationships/);
    }));

  it("refuses a replayed file, a legacy import of the same bytes and an existing container", () =>
    world(async (w) => {
      const wb = await workbook(w);
      await w.q(
        `INSERT INTO intercompany_import_batches (source_company_id, file_name, file_sha256, request_fingerprint, state, created_by)
         VALUES ($1, 'old.xlsx', $2, md5('x') || md5('y'), 'confirmed', $3)`,
        [w.sourceCompanyId, wb.preview.sha256, w.userId]
      );
      await refused(w, () => importAs(w, wb), /already been imported/, 409);
      await w.q(`DELETE FROM intercompany_import_batches WHERE file_sha256 = $1`, [wb.preview.sha256]);

      await w.q(
        `INSERT INTO import_logs (file_name, file_hash, row_count, status) VALUES ('legacy.xlsx', $1, 1, 'completed')`,
        [wb.preview.md5]
      );
      await refused(w, () => importAs(w, wb), /already been imported/, 409);
      await w.q(`DELETE FROM import_logs WHERE file_hash = $1`, [wb.preview.md5]);

      await w.trade("A");
      const clash = await workbook(w, { container: `${w.tag.toLowerCase()}a `.trim() });
      await refused(w, () => importAs(w, clash), /Container already exists/, 409);
    }));

  it("refuses a foreign or mismatched external supplier", () =>
    world(async (w) => {
      const wb = await workbook(w);
      const foreign = { ...wb, input: { ...wb.input, externalSupplierId: w.partnerSupplierId } };
      await refused(w, () => importAs(w, foreign), /External supplier must belong/);
      const mismatched = await workbook(w, { supplierCode: "SOMEONE-ELSE" });
      await refused(w, () => importAs(w, mismatched), /does not match the selected Properties supplier/);
    }));

  it("refuses mistyped or shared accounts, a wrong partner supplier and a non-USD destination", () =>
    world(async (w) => {
      const wb = await workbook(w);
      const setPolicy = (column: "source_sales_account_id" | "source_cost_account_id", value: number) =>
        w.q(
          column === "source_sales_account_id"
            ? `UPDATE intercompany_relationship_policies SET source_sales_account_id = $2 WHERE id = $1`
            : `UPDATE intercompany_relationship_policies SET source_cost_account_id = $2 WHERE id = $1`,
          [w.relationshipId, value]
        );
      await setPolicy("source_sales_account_id", w.accounts.sourceReceivableAccountId);
      await refused(w, () => importAs(w, wb), /Sales must be a correctly typed account/);
      await setPolicy("source_sales_account_id", w.accounts.sourceSalesAccountId);
      await setPolicy("source_cost_account_id", w.accounts.sourcePurchaseAccountId);
      await refused(w, () => importAs(w, wb), /Purchases and COGS accounts must be distinct/);
      await setPolicy("source_cost_account_id", w.accounts.sourceCostAccountId);

      await w.q(`UPDATE suppliers SET legal_name = 'Somebody Else' WHERE id = $1`, [w.partnerSupplierId]);
      await refused(w, () => importAs(w, wb), /Destination supplier must be the source Properties company/);
      await w.q(`UPDATE suppliers SET legal_name = $2 WHERE id = $1`, [w.partnerSupplierId, w.sourceName]);

      await w.q(`UPDATE companies SET base_currency = 'ZMW' WHERE id = $1`, [w.destinationCompanyId]);
      await refused(w, () => importAs(w, wb), /USD-base companies/);
    }));

  it("refuses a mapping that changed after the preview was taken", () =>
    world(async (w) => {
      const wb = await workbook(w);
      const plans = validateWorkbookSelections(wb.preview, wb.input);
      const [policy] = await w.q(`SELECT version FROM intercompany_relationship_policies WHERE id = $1`, [
        w.relationshipId,
      ]);
      const setup = await getTradingSetup(w.sourceCompanyId, w.userId, "Owner");
      const stale = setup.policies.map((p) => ({ ...p, version: Number(policy.version) - 1 }));
      await refused(
        w,
        () =>
          db.transaction((tx) =>
            postIntercompanyImportTxStep1(tx, {
              sourceCompanyId: w.sourceCompanyId,
              userId: w.userId,
              username: "owner",
              preview: wb.preview,
              input: wb.input,
              ids: [w.relationshipId],
              destinations: [w.destinationCompanyId],
              plans,
              policies: stale,
            })
          ),
        /mapping changed during import/
      );
    }));
});

describe("container import posting", () => {
  it("imports the container, reusing the verified destination stock item", () =>
    world(async (w) => {
      const wb = await workbook(w);
      const result = await importAs(w, wb);
      expect(result).toMatchObject({
        success: true,
        containerCount: 1,
        totalIntercompanyCost: "10.00",
        createdDestinationStockItems: 0,
        reusedDestinationStockLines: 1,
      });
      expect(await batches(w)).toBe(1);
    }));

  it("creates a missing destination stock item from the Properties item and audits it", () =>
    world(async (w) => {
      const wb = await workbook(w);
      await w.q(`UPDATE stock_items SET code = $2, name = 'Old bales' WHERE id = $1`, [w.stockItemId, `OLD-${w.tag}`]);
      const result = await importAs(w, wb);
      expect(result.createdDestinationStockItems).toBe(1);
      const created = await w.q(`SELECT id FROM stock_items WHERE company_id = $1 AND code = $2`, [
        w.destinationCompanyId,
        `SI-${w.tag}`,
      ]);
      expect(created).toHaveLength(1);
      const audit = await w.q(
        `SELECT 1 FROM audit_log WHERE table_name = 'stock_items' AND action = 'create' AND record_id = $1`,
        [created[0].id]
      );
      expect(audit).toHaveLength(1);
    }));
});
