/**
 * Automatic Properties -> ERP trading-pair provisioning: authorization,
 * company checks, first-time creation, idempotent repeat, reuse of verified
 * mappings and exact-code ledgers, and every refusal that must leave the
 * existing mapping, ledgers and suppliers unchanged.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import { autoProvisionTradingRelationship } from "../server/services/intercompany/tradingAccountProvisioning";

type Pair = Awaited<ReturnType<typeof bare>>;

/** Two fresh companies (Properties source, ERP destination) and an Owner of both, no mapping yet. */
async function bare(w: IntercompanyTradeWorld, sourceName?: string, suffix = "N") {
  const sourceCompanyId = await w.company(`${suffix}P`, "properties");
  const destinationCompanyId = await w.company(`${suffix}E`, "erp");
  if (sourceName) await w.q(`UPDATE companies SET name = $1 WHERE id = $2`, [sourceName, sourceCompanyId]);
  const userId = await w.otherUser([
    [sourceCompanyId, "Owner"],
    [destinationCompanyId, "Owner"],
  ]);
  const [{ name }] = await w.q<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [sourceCompanyId]);
  return { sourceCompanyId, destinationCompanyId, userId, sourceName: name };
}

const provision = (p: Pick<Pair, "sourceCompanyId" | "destinationCompanyId" | "userId">, role = "Owner") =>
  autoProvisionTradingRelationship({ ...p, username: "owner", role });

async function counts(w: IntercompanyTradeWorld, p: Pair) {
  const [row] = await w.q<{ accounts: number; suppliers: number; policies: number }>(
    `SELECT (SELECT count(*)::int FROM ledger_accounts WHERE company_id IN ($1, $2) AND code LIKE 'IC-%') AS accounts,
            (SELECT count(*)::int FROM suppliers WHERE company_id = $2) AS suppliers,
            (SELECT count(*)::int FROM intercompany_relationship_policies WHERE source_company_id = $1) AS policies`,
    [p.sourceCompanyId, p.destinationCompanyId]
  );
  return row;
}

async function refusedWith(w: IntercompanyTradeWorld, p: Pair, pattern: RegExp, status = 409) {
  const before = await counts(w, p);
  await expect(provision(p)).rejects.toMatchObject({ status, message: expect.stringMatching(pattern) });
  expect(await counts(w, p)).toEqual(before);
}

function world<T>(work: (w: IntercompanyTradeWorld) => Promise<T>) {
  return withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));
}

describe("autoProvisionTradingRelationship authorization", () => {
  it("refuses non-Owner roles and destinations the user does not own", () =>
    world(async (w) => {
      const p = await bare(w);
      await expect(provision(p, "Admin")).rejects.toThrow(/Only Owners and Developers/);
      const stranger = await w.company("ST", "erp");
      await expect(provision({ ...p, destinationCompanyId: stranger })).rejects.toMatchObject({
        status: 403,
        code: "INTERCOMPANY_DESTINATION_FORBIDDEN",
      });
      await expect(provision({ ...p, sourceCompanyId: p.destinationCompanyId })).rejects.toThrow(
        /active Properties company/
      );
      expect(await counts(w, p)).toEqual({ accounts: 0, suppliers: 0, policies: 0 });
    }));

  it("refuses non-USD companies and a source without a usable legal name", () =>
    world(async (w) => {
      const p = await bare(w);
      await w.q(`UPDATE companies SET base_currency = 'ZMW' WHERE id = $1`, [p.destinationCompanyId]);
      await refusedWith(w, p, /USD-base/);
      const q = await bare(w, "!!!", "M");
      await refusedWith(w, q, /valid legal name/);
    }));
});

describe("autoProvisionTradingRelationship first setup and repeat", () => {
  it("creates the seven ledgers, the partner supplier and the mapping, then reports already_ready", () =>
    world(async (w) => {
      const p = await bare(w);
      const first = await provision(p);
      expect(first).toMatchObject({
        status: "configured",
        createdAccounts: 7,
        reusedAccounts: 0,
        createdSupplier: true,
      });
      expect(await counts(w, p)).toEqual({ accounts: 7, suppliers: 1, policies: 1 });
      const [audit] = await w.q(
        `SELECT payload->>'noOpeningBalancesOrVouchersPosted' AS safe FROM intercompany_audit_events
          WHERE relationship_id = $1 AND event_type = 'trading-relationship-auto-provisioned'`,
        [first.relationshipId]
      );
      expect(audit.safe).toBe("true");
      const [{ n }] = await w.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM voucher_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
          WHERE a.company_id IN ($1, $2)`,
        [p.sourceCompanyId, p.destinationCompanyId]
      );
      expect(n).toBe(0);

      const again = await provision(p, "Developer");
      expect(again).toMatchObject({
        status: "already_ready",
        createdAccounts: 0,
        reusedAccounts: 7,
        supplierId: first.supplierId,
      });
      expect(await counts(w, p)).toEqual({ accounts: 7, suppliers: 1, policies: 1 });
    }));

  it("refuses to re-confirm a ready mapping whose account or supplier is no longer usable", () =>
    world(async (w) => {
      const p = await bare(w);
      const first = await provision(p);
      await w.q(`UPDATE suppliers SET legal_name = 'Renamed Partner' WHERE id = $1`, [first.supplierId]);
      await refusedWith(w, p, /different name/);
      await w.q(`UPDATE ledger_accounts SET active = FALSE WHERE company_id = $1 AND code = $2`, [
        p.sourceCompanyId,
        `IC-SALES-${p.destinationCompanyId}`,
      ]);
      await refusedWith(w, p, /Mapped .* account is inactive/);
    }));

  it("reuses exact-code ledgers and an existing same-name supplier", () =>
    world(async (w) => {
      const p = await bare(w);
      await w.q(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Pre-existing receivable', 'Asset', '0', TRUE)`,
        [p.sourceCompanyId, `IC-AR-${p.destinationCompanyId}`]
      );
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, '', TRUE) RETURNING id`,
        [p.destinationCompanyId, `${w.tag}SAME`, `  ${p.sourceName.toUpperCase()} `]
      );
      const result = await provision(p);
      expect(result).toMatchObject({ createdAccounts: 6, reusedAccounts: 1, createdSupplier: false, supplierId });
    }));
});

describe("autoProvisionTradingRelationship conflicts", () => {
  it("refuses an exact-code ledger of the wrong type", () =>
    world(async (w) => {
      const p = await bare(w);
      await w.q(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Wrong type', 'Income', '0', TRUE)`,
        [p.destinationCompanyId, `IC-GIT-${p.sourceCompanyId}`]
      );
      await refusedWith(w, p, /wrong type/);
    }));

  it("refuses ambiguous, inactive and code-colliding destination suppliers", () =>
    world(async (w) => {
      const p = await bare(w);
      const supplier = (code: string, name: string, active = true) =>
        w.one(
          `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, '', $4) RETURNING id`,
          [p.destinationCompanyId, code, name, active]
        );
      const inactive = await supplier(`${w.tag}IN`, p.sourceName, false);
      await refusedWith(w, p, /inactive or deleted/);
      await w.q(`UPDATE suppliers SET active = TRUE WHERE id = $1`, [inactive]);
      await supplier(`${w.tag}DUP`, p.sourceName);
      await refusedWith(w, p, /Multiple Properties-named suppliers/);

      const q = await bare(w, undefined, "M");
      await w.q(
        `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, 'Unrelated', '', TRUE)`,
        [q.destinationCompanyId, `IC-PROP-${q.sourceCompanyId}-${q.destinationCompanyId}`]
      );
      await refusedWith(w, q, /Reserved Properties supplier code/);
    }));

  it("refuses to remap a relationship that already has trades", () =>
    world(async (w) => {
      await w.trade("H");
      await w.q(`UPDATE intercompany_relationship_policies SET trade_enabled = FALSE WHERE id = $1`, [
        w.relationshipId,
      ]);
      const p = {
        sourceCompanyId: w.sourceCompanyId,
        destinationCompanyId: w.destinationCompanyId,
        userId: w.userId,
        sourceName: w.sourceName,
      };
      await refusedWith(w, p, /historical trades/);
    }));

  it("completes a disabled partial mapping in place, and refuses identical purchase and COGS accounts", () =>
    world(async (w) => {
      const p = await bare(w);
      const expense = await w.ledger(p.sourceCompanyId, "EXP", "Expense");
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, '', TRUE) RETURNING id`,
        [p.destinationCompanyId, `${w.tag}MAP`, p.sourceName]
      );
      const policyId = await w.one(
        `INSERT INTO intercompany_relationship_policies (source_company_id, destination_company_id, relationship_type,
           trade_enabled, destination_supplier_id, source_purchase_account_id, source_cost_account_id)
         VALUES ($1, $2, 'container_trade', FALSE, $3, $4, $4) RETURNING id`,
        [p.sourceCompanyId, p.destinationCompanyId, supplierId, expense]
      );
      await refusedWith(w, p, /Purchases and COGS/);

      await w.q(`UPDATE intercompany_relationship_policies SET source_cost_account_id = NULL WHERE id = $1`, [
        policyId,
      ]);
      const result = await provision(p);
      expect(result).toMatchObject({
        relationshipId: policyId,
        status: "configured",
        createdAccounts: 6,
        reusedAccounts: 1,
        createdSupplier: false,
        supplierId,
      });
      const [policy] = await w.q(
        `SELECT trade_enabled, version, source_purchase_account_id FROM intercompany_relationship_policies WHERE id = $1`,
        [policyId]
      );
      expect(policy).toEqual({ trade_enabled: true, version: 2, source_purchase_account_id: expense });
    }));
});
