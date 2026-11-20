/**
 * buildAgentsForCompany (GIT agent duty summary) against PostgreSQL inside a
 * rolled-back transaction: mapping priority (company name, company alias,
 * global name, global alias, fuzzy, unmapped), ledger balances from opening
 * balances, voucher entries and linked bank accounts, and each settlement
 * branch (settled, ledger exceeds containers, FIFO partial).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { buildAgentsForCompany } from "../server/routes/git/_helpers";

async function seed(w: FactoryWorld) {
  const supplierId = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Duty Supplier', 'duty@example.test') RETURNING id`,
    [w.companyId, `${w.tag}S`]
  );
  let seq = 0;
  const container = (agent: string, duty: string, status: string, plate: string | null = null) =>
    w.one(
      `INSERT INTO containers (company_id, supplier_id, container_number, import_date, agent, duty_fee, status, number_plate, offload_date)
       VALUES ($1, $2, $3, '2026-01-01', $4, $5, $6, $7, CASE WHEN $6 = 'Offloaded' THEN '2026-01-0' || $8 END::date) RETURNING id`,
      [w.companyId, supplierId, `${w.tag}C${++seq}`, agent, duty, status, plate, String(seq)]
    );
  const ledger = (name: string, opening: string, side: "Dr" | "Cr") =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, $3, 'Liability', $4, $5) RETURNING id`,
      [w.companyId, `${w.tag}L${++seq}`, name, opening, side]
    );
  const mapping = (agentName: string, companyId: number | null, ledgerId: number | null, aliases: string[] = []) =>
    w.q(
      `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       VALUES ($1, $2, $3, $4::text[], true)`,
      [agentName, companyId, ledgerId, aliases]
    );
  return { container, ledger, mapping };
}

describe("buildAgentsForCompany", () => {
  it("returns nothing for a company without duty-bearing containers", async () => {
    await withFactoryWorld(async (w) => {
      expect(await buildAgentsForCompany(w.companyId)).toEqual([]);
    });
  });

  it("resolves every mapping tier and settlement branch", async () => {
    await withFactoryWorld(async (w) => {
      const { container, ledger, mapping } = await seed(w);
      const t = w.tag;
      // Settled: company exact name, zero balance.
      const settledLedger = await ledger(`${t} settled acct`, "0", "Dr");
      await mapping(`${t} Alpha`, w.companyId, settledLedger);
      await container(`${t} Alpha`, "100", "Offloaded");
      // Exceeds: company alias, 1000 Cr against 150 offloaded duty.
      const exceedLedger = await ledger(`${t} exceed acct`, "1000", "Cr");
      await mapping(`${t} Beta Official`, w.companyId, exceedLedger, [`${t} Beta`]);
      await container(`${t} Beta`, "150", "Offloaded");
      await container(`${t} Beta`, "70", "OTW", "T 123 ABC");
      await container(`${t} Beta`, "30", "OTW", "  ");
      // FIFO partial: global exact name, 250 Dr against 300 + 200 offloaded.
      const partialLedger = await ledger(`${t} partial acct`, "250", "Dr");
      await mapping(`${t} Gamma`, null, partialLedger);
      await container(`${t} Gamma`, "300", "Offloaded");
      await container(`${t} Gamma`, "200", "Offloaded");
      // Global alias with a mapping row lacking an account first.
      const aliasLedger = await ledger(`${t} alias acct`, "0", "Dr");
      await mapping(`${t} Delta Broken`, w.companyId, null, [`${t} Delta`]);
      await mapping(`${t} Delta Global`, null, aliasLedger, [`${t} Delta`]);
      await container(`${t} Delta`, "40", "Offloaded");
      // Fuzzy ledger name and unmapped agent.
      await ledger(`${t} Epsilon Clearing Payable`, "0", "Dr");
      await container(`${t} Epsilon Clearing`, "10", "Offloaded");
      await container(`${t} Nobody`, "5", "OTW");

      const agents = await buildAgentsForCompany(w.companyId);
      const by = Object.fromEntries(agents.map((agent) => [agent.agentName.replace(`${t} `, ""), agent]));

      expect(by.Alpha).toMatchObject({
        ledgerAccountId: settledLedger,
        matchConfidence: "exact",
        ledgerBalance: 0,
        openBalance: 0,
        clearedByPayments: 100,
        warnings: ["no_open_balance"],
      });
      expect(by.Alpha.clearedRows).toHaveLength(1);

      expect(by.Beta).toMatchObject({
        ledgerAccountId: exceedLedger,
        ledgerBalance: -1000,
        openBalance: 1000,
        containerDutyTotal: 250,
        offloadedDutyTotal: 150,
        warnings: ["ledger_exceeds_containers"],
      });
      expect(by.Beta.openRows).toHaveLength(1);
      expect(by.Beta.activePreviewRows.map((row) => row.numberPlate)).toEqual(["T 123 ABC"]);

      expect(by.Gamma).toMatchObject({ ledgerAccountId: partialLedger, ledgerBalance: 250, openBalance: 250 });
      expect(by.Gamma.clearedByPayments + 250).toBe(500);

      expect(by.Delta).toMatchObject({ ledgerAccountId: aliasLedger, matchConfidence: "exact" });
      expect(by["Epsilon Clearing"]).toMatchObject({
        matchConfidence: "fuzzy",
        warnings: ["fuzzy_match", "no_open_balance"],
      });
      expect(by.Nobody).toMatchObject({
        ledgerAccountId: null,
        ledgerBalance: null,
        openBalance: null,
        matchConfidence: "unmapped",
        warnings: ["no_account_linked"],
      });
    });
  });

  it("folds voucher entries and linked bank accounts into the ledger balance", async () => {
    await withFactoryWorld(async (w) => {
      const { container, ledger, mapping } = await seed(w);
      const agentLedger = await ledger(`${w.tag} bank agent`, "10", "Dr");
      await mapping(`${w.tag} Zeta`, w.companyId, agentLedger);
      await container(`${w.tag} Zeta`, "500", "Offloaded");
      const bankId = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, linked_ledger_id)
         VALUES ($1, $2, 'Agent Bank', 'Bank', '001', 40, 'Cr', $3) RETURNING id`,
        [w.companyId, `${w.tag}B`, agentLedger]
      );
      await w.q(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, linked_ledger_id)
         VALUES ($1, $2, 'Agent Bank 2', 'Bank', '002', 5, 'Dr', $3)`,
        [w.companyId, `${w.tag}B2`, agentLedger]
      );
      const voucherId = await w.one(
        `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
         VALUES ($1, 'Journal', $2, '2026-01-15', 300) RETURNING id`,
        [w.companyId, `${w.tag}J1`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 300, 0)`,
        [voucherId, agentLedger]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, bank_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 300)`,
        [voucherId, bankId]
      );

      const [agent] = await buildAgentsForCompany(w.companyId);
      // 10 Dr + 300 Dr - 40 Cr bank opening - 300 Cr bank entry + 5 Dr second bank.
      expect(agent.ledgerBalance).toBe(-25);
      expect(agent.openBalance).toBe(25);
      expect(agent.partialRows.length + agent.openRows.length).toBe(1);
    });
  });

  it("includes Supplier Partner containers from the tracking projection", async () => {
    await withFactoryWorld(async (w) => {
      const sp = await w.one(
        `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, container_number, status)
         VALUES ($1, '2026-01-10', $2, 'Partner', $2, 'open') RETURNING id`,
        [w.companyId, `${w.tag}SP`]
      );
      await w.q(
        `INSERT INTO sp_container_git_tracking (container_id, company_id, agent, duty_fee, number_plate, status)
         VALUES ($1, $2, $3, 75, 'SP 1', 'At Border')`,
        [sp, w.companyId, `${w.tag} Partner Agent`]
      );
      const blank = await w.one(
        `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, container_number, status)
         VALUES ($1, '2026-01-10', $2, 'Partner', $2, 'open') RETURNING id`,
        [w.companyId, `${w.tag}SP2`]
      );
      await w.q(
        `INSERT INTO sp_container_git_tracking (container_id, company_id, agent, duty_fee) VALUES ($1, $2, '  ', 10)`,
        [blank, w.companyId]
      );
      const [agent] = await buildAgentsForCompany(w.companyId);
      expect(agent).toMatchObject({
        agentName: `${w.tag} Partner Agent`,
        containerDutyTotal: 75,
        matchConfidence: "unmapped",
      });
      expect(agent.activePreviewRows).toEqual([expect.objectContaining({ id: -sp, numberPlate: "SP 1" })]);
    });
  });
});
