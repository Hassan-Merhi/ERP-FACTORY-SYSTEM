/**
 * containerHelpersStep: locating the parent-company INTERCO voucher for a
 * subsidiary container edit. Each lookup path (container in description, in
 * entry narration, PO only, legacy JOURNAL with named receivable, unnamed
 * legacy journal verified from the original child voucher) and each refusal
 * (ambiguous matches throw, unverifiable inputs find nothing) runs against
 * PostgreSQL inside a rolled-back transaction.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { containerHelpersStep } from "../server/routes/containers/containerHelpersStep";

type StepInput = Parameters<typeof containerHelpersStep>[0];

const run = (input: Partial<StepInput>) =>
  containerHelpersStep({
    verifiedParentCompanyId: undefined,
    amountStr: "100.00",
    poNumbers: "PO-1",
    containerNumber: undefined,
    dbOrTx: db,
    verifiedSubsidiaryCompanyId: undefined,
    legacyPoMatch: undefined,
    tx: db as unknown as StepInput["tx"],
    ...input,
  });

async function voucher(
  w: FactoryWorld,
  number: string,
  opts: { description?: string | null; date?: string; total?: string; companyId?: number } = {}
) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, description)
     VALUES ($1, 'Journal', $2, $3, $4, $5) RETURNING id`,
    [opts.companyId ?? w.companyId, number, opts.date ?? "2026-01-15", opts.total ?? "100.00", opts.description ?? null]
  );
}

const entry = (
  w: FactoryWorld,
  voucherId: number,
  e: { ledger?: number | null; supplier?: number | null; debit?: string; credit?: string; narration?: string | null }
) =>
  w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [voucherId, e.ledger ?? null, e.supplier ?? null, e.debit ?? "0", e.credit ?? "0", e.narration ?? null]
  );

async function subsidiaryWorld(w: FactoryWorld) {
  const subName = `${w.tag} Sub`;
  const subId = await w.one(`INSERT INTO companies (code, name) VALUES ($1, $2) RETURNING id`, [
    `${w.tag}SUB`,
    subName,
  ]);
  const receivable = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, 'Asset') RETURNING id`,
    [w.companyId, `${w.tag}RCV`, `${subName} Credit`]
  );
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Vendor', 'v@example.test') RETURNING id`,
    [w.companyId, `${w.tag}SUP`]
  );
  return { subId, receivable, supplier };
}

describe("containerHelpersStep parent voucher lookup", () => {
  it("stops when no parent company is configured", async () => {
    await withFactoryWorld(async (w) => {
      // Clears the cached parent id too; the setting row is rolled back.
      await storage.setParentCompanyId(null);
      try {
        expect(await run({ amountStr: "12.00" })).toEqual({
          done: true,
          value: { found: false, updated: false, amount: "12.00" },
        });
      } finally {
        await storage.setParentCompanyId(w.companyId);
      }
    });
  });

  it("finds the voucher by container in the description, then by narration, then by PO only", async () => {
    await withFactoryWorld(async (w) => {
      const byDesc = await voucher(w, `INTERCO-PARENT-PO-${w.tag}-1`, { description: `CONT${w.tag}A EUROGULF` });
      const viaDesc = await run({
        verifiedParentCompanyId: w.companyId,
        poNumbers: [`PO-${w.tag}`, ""],
        containerNumber: `CONT${w.tag}A`,
      });
      expect(viaDesc).toMatchObject({ done: false, parentCompanyId: w.companyId, nums: [`PO-${w.tag}`] });
      expect(viaDesc.done === false && viaDesc.parentVoucher?.id).toBe(byDesc);

      const byNarration = await voucher(w, `IC-${w.tag}N-1`, { description: "Inter-company credit" });
      const goods = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Goods', 'Asset') RETURNING id`,
        [w.companyId, `${w.tag}GDS`]
      );
      await entry(w, byNarration, { ledger: goods, debit: "100", narration: `Goods - Container CONT${w.tag}B` });
      const viaNarration = await run({
        verifiedParentCompanyId: w.companyId,
        poNumbers: `${w.tag}N`,
        containerNumber: `CONT${w.tag}B`,
      });
      expect(viaNarration.done === false && viaNarration.parentVoucher?.id).toBe(byNarration);

      const viaPo = await run({ poNumbers: [`PO-${w.tag}`], verifiedParentCompanyId: w.companyId });
      expect(viaPo.done === false && viaPo.parentVoucher?.id).toBe(byDesc);

      const none = await run({
        verifiedParentCompanyId: w.companyId,
        poNumbers: `NOPE-${w.tag}`,
        containerNumber: "NOTHERE",
      });
      expect(none).toMatchObject({ done: false, parentVoucher: undefined, recoveredUnnamedLegacy: false });
    });
  });

  it("accepts a legacy JOURNAL only with the named subsidiary receivable and refuses duplicates", async () => {
    await withFactoryWorld(async (w) => {
      const { subId, receivable } = await subsidiaryWorld(w);
      const container = `LEG${w.tag}`;
      const base = {
        verifiedParentCompanyId: w.companyId,
        verifiedSubsidiaryCompanyId: subId,
        poNumbers: `PO-${w.tag}`,
        containerNumber: container,
      };
      expect((await run(base)).done === false && (await run(base)).parentVoucher).toBeUndefined();

      const legacy = await voucher(w, `JOURNAL-${w.tag}1`, { description: `${container} legacy` });
      await entry(w, legacy, { ledger: receivable, debit: "100" });
      const found = await run(base);
      expect(found.done === false && found.parentVoucher?.id).toBe(legacy);

      // A missing subsidiary never matches.
      const missingSub = await run({ ...base, verifiedSubsidiaryCompanyId: 2147483000 });
      expect(missingSub.done === false && missingSub.parentVoucher).toBeUndefined();

      const second = await voucher(w, `JOURNAL-${w.tag}2`, { description: `${container} duplicate` });
      await entry(w, second, { ledger: receivable, debit: "100" });
      await expect(run(base)).rejects.toThrow(`Multiple legacy parent journals match container ${container}`);
    });
  });

  it("recovers one unnamed legacy journal verified from the original child voucher", async () => {
    await withFactoryWorld(async (w) => {
      const { subId, receivable, supplier } = await subsidiaryWorld(w);
      const legacyPoMatch = {
        purchaseOrderId: 999999,
        supplierId: supplier,
        originalVoucherDate: "2026-02-01",
        originalVoucherTotal: "250",
      };
      const base = {
        verifiedParentCompanyId: w.companyId,
        verifiedSubsidiaryCompanyId: subId,
        poNumbers: `PO-${w.tag}`,
        containerNumber: `UNN${w.tag}`,
        legacyPoMatch,
      };
      const unnamed = await voucher(w, `JOURNAL-${w.tag}U`, { date: "2026-02-01", total: "250.00" });
      await entry(w, unnamed, { ledger: receivable, debit: "250.00" });
      await entry(w, unnamed, { supplier, credit: "250.00" });
      // Same shape but with a narration: not verified.
      const noisy = await voucher(w, `JOURNAL-${w.tag}V`, { date: "2026-02-01", total: "250.00", description: "" });
      await entry(w, noisy, { ledger: receivable, debit: "250.00", narration: "manual" });
      await entry(w, noisy, { supplier, credit: "250.00" });

      const found = await run(base);
      expect(found).toMatchObject({ done: false, recoveredUnnamedLegacy: true });
      expect(found.done === false && found.parentVoucher?.id).toBe(unnamed);

      for (const bad of [
        { ...legacyPoMatch, purchaseOrderId: 0 },
        { ...legacyPoMatch, supplierId: -1 },
        { ...legacyPoMatch, originalVoucherTotal: "0" },
      ]) {
        const result = await run({ ...base, legacyPoMatch: bad });
        expect(result.done === false && result.parentVoucher).toBeUndefined();
      }
      const noSub = await run({ ...base, verifiedSubsidiaryCompanyId: 2147483000 });
      expect(noSub.done === false && noSub.parentVoucher).toBeUndefined();
    });
  });

  it("refuses ambiguous unnamed journals and same-value sibling purchase orders", async () => {
    await withFactoryWorld(async (w) => {
      const { subId, receivable, supplier } = await subsidiaryWorld(w);
      const legacyPoMatch = {
        purchaseOrderId: 999999,
        supplierId: supplier,
        originalVoucherDate: "2026-03-01",
        originalVoucherTotal: "80",
      };
      const base = {
        verifiedParentCompanyId: w.companyId,
        verifiedSubsidiaryCompanyId: subId,
        poNumbers: `PO-${w.tag}`,
        containerNumber: `AMB${w.tag}`,
        legacyPoMatch,
      };
      for (const suffix of ["A", "B"]) {
        const id = await voucher(w, `JOURNAL-${w.tag}${suffix}`, { date: "2026-03-01", total: "80.00" });
        await entry(w, id, { ledger: receivable, debit: "80.00" });
        await entry(w, id, { supplier, credit: "80.00" });
      }
      await expect(run(base)).rejects.toThrow("Ambiguous unnamed parent journals");

      const subSupplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Sub Vendor', 's@example.test') RETURNING id`,
        [subId, `${w.tag}SS`]
      );
      const containerId = await w.one(
        `INSERT INTO containers (company_id, supplier_id, container_number, import_date) VALUES ($1, $2, $3, '2026-03-01') RETURNING id`,
        [subId, subSupplier, `SIB${w.tag}`]
      );
      const childVoucher = await voucher(w, `PUR-${w.tag}`, { companyId: subId, date: "2026-03-01", total: "80.00" });
      await w.q(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, voucher_id) VALUES ($1, $2, $3, $4, $5)`,
        [subId, containerId, `SIB-${w.tag}`, supplier, childVoucher]
      );
      await expect(run(base)).rejects.toThrow(`Ambiguous unnamed parent journal for PO PO-${w.tag}`);
    });
  });
});
