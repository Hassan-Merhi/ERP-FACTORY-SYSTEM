/**
 * /api/admin/repair-balances/undo company scope through the real app inside
 * one rolled-back transaction. Undo rebuilds from the stored record of the
 * apply run; as defence in depth, a stored run (forged straight into
 * audit_log here) that names another company's ledger row, contract, voucher
 * line, voucher, transfer or orphaned voucher is refused (404) and changes
 * nothing, and a malformed stored run is refused as incomplete (409).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";
import { balanceRepairState, seedBalanceRepair } from "./helpers/balanceRepairFixture";
import { snapshotFingerprint } from "../server/routes/balance-repair/repairRun";

const UNDO = "/api/admin/repair-balances/undo";

describe("balance repair undo company scope", () => {
  it("refuses an undo whose stored run names another company's rows and changes nothing", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const [otherEntry] = await w.q<{ id: number }>(
        `SELECT e.id FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
          WHERE v.company_id = $1 ORDER BY e.id LIMIT 1`,
        [seed.otherCompanyId]
      );
      const [otherAccount] = await w.q<{ id: number }>(
        `SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [seed.otherCompanyId]
      );
      const [otherVoucher] = await w.q<{ id: number }>(
        `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
        [seed.otherCompanyId, `${w.tag}-TT3`]
      );
      const transfer = {
        id: 2147480000,
        transfer_type: "Cash",
        transfer_date: "2026-05-10",
        amount: "1.00",
        from_voucher_id: null,
        to_voucher_id: null,
        description: "forged",
        source_payment_id: null,
        created_at: "2026-05-10 00:00:00",
      };
      // Defence in depth: a stored run (here forged straight into audit_log)
      // that is valid for the active company except for one row is refused.
      const ownLedger = { kind: "ledger", id: seed.driftLedgerId, oldPaid: 7 };
      const runs: Array<[string, unknown[]]> = [
        ["ledger row", [ownLedger, { kind: "ledger", id: seed.otherLedgerId, oldPaid: 1.5 }]],
        [
          "contract",
          [ownLedger, { kind: "deposit", contractId: seed.otherContractId, oldFlag: false, oldPostedAmount: 0 }],
        ],
        ["voucher line", [ownLedger, { kind: "entry", id: otherEntry.id }]],
        ["voucher", [ownLedger, { kind: "undeleted", id: otherVoucher.id }]],
        [
          "transfer between two other companies",
          [
            ownLedger,
            {
              kind: "transfer",
              row: {
                ...transfer,
                from_company_id: seed.otherCompanyId,
                to_company_id: seed.otherCompanyId,
                from_ledger_account_id: otherAccount.id,
                to_ledger_account_id: otherAccount.id,
              },
            },
          ],
        ],
        [
          "transfer naming a voucher of the wrong side",
          [
            ownLedger,
            {
              kind: "transfer",
              row: {
                ...transfer,
                from_company_id: w.companyId,
                to_company_id: seed.otherCompanyId,
                from_ledger_account_id: seed.cashId,
                to_ledger_account_id: otherAccount.id,
                from_voucher_id: otherVoucher.id,
              },
            },
          ],
        ],
        [
          "orphaned voucher of another company without its transfer",
          [ownLedger, { kind: "orphan", id: otherVoucher.id, voucherNumber: `${w.tag}-TT3` }],
        ],
      ];
      const before = await balanceRepairState(w, seed);
      for (const [label, items] of runs) {
        const snapshot = { forged: label };
        const repairRunId = await w.one(
          `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, changes)
           VALUES ('test', 'test', $1, 'repair', 'balance_repair_runs', $2, $3::jsonb) RETURNING id`,
          [
            w.companyId,
            label,
            JSON.stringify({ fingerprint: { new: snapshotFingerprint(snapshot) }, items: { new: items } }),
          ]
        );
        const res = await w.agent.post(UNDO).send({ repairRunId, snapshot });
        expect(res.status, label).toBe(404);
        expect(res.body.code, label).toBe("REPAIR_SNAPSHOT_OUTSIDE_COMPANY");
        expect(await balanceRepairState(w, seed), label).toEqual(before);
        expect(await w.q(`SELECT id FROM inter_company_transfers WHERE id = $1`, [transfer.id]), label).toEqual([]);
      }

      // A stored run whose items are malformed is refused as incomplete.
      const snapshot = { forged: "malformed" };
      const malformed = await w.one(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, changes)
         VALUES ('test', 'test', $1, 'repair', 'balance_repair_runs', 'malformed', $2::jsonb) RETURNING id`,
        [
          w.companyId,
          JSON.stringify({ fingerprint: { new: snapshotFingerprint(snapshot) }, items: { new: [{ kind: "ledger" }] } }),
        ]
      );
      const res = await w.agent.post(UNDO).send({ repairRunId: malformed, snapshot });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("REPAIR_RUN_INVALID");
      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));
});
