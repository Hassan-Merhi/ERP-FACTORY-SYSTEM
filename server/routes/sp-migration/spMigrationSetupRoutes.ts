/**
 * SP migration routes - Target company creation, account plan and creation, session role, cash accounts and opening balances.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import { pn, getCompanyRow } from "./_helpers";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { registerSpMigrationSetupRoutesPart1 } from "./registerSpMigrationSetupRoutesPart1";

export function registerSpMigrationSetupRoutes(app: Express) {
  // ── POST /api/sp/migration/create-sp-company ─────────────────────────────
  // Creates a new supplier_partner company for the GC-LSHI migration.
  app.post(
    "/api/sp/migration/create-sp-company",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const { name, code } = req.body ?? {};
        if (!name || !code) return res.status(400).json({ message: "name and code are required" });

        // Check for duplicate code
        const existing = (await db.execute(sql`SELECT id FROM companies WHERE code = ${code} LIMIT 1`)).rows[0];
        if (existing) return res.status(409).json({ message: `Company code "${code}" already exists` });

        const [row] = (
          await db.execute(sql`
        INSERT INTO companies (code, name, company_type, base_currency, active)
        VALUES (${code}, ${name}, 'supplier_partner', 'USD', true)
        RETURNING id, code, name, company_type
      `)
        ).rows;

        return res.json({ success: true, company: row });
      } catch (err: unknown) {
        logger.error("[SP Migration] create-sp-company error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  registerSpMigrationSetupRoutesPart1(app);

  // ── GET /api/sp/migration/cash-accounts ─────────────────────────────────
  // Returns Cash/Bank ledger accounts for a given SP target company.
  app.get(
    "/api/sp/migration/cash-accounts",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const targetId = parseInt(String(req.query.targetCompanyId ?? ""), 10);
        if (!targetId) return res.status(400).json({ message: "targetCompanyId is required" });
        const rows = (
          await db.execute(sql`
        SELECT id, code, name, account_type
        FROM ledger_accounts
        WHERE company_id = ${targetId} AND account_type IN ('Cash', 'Bank') AND deleted_at IS NULL
        ORDER BY account_type, name
      `)
        ).rows;
        return res.json({ accounts: rows });
      } catch {
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── POST /api/sp/migration/opening-balance ───────────────────────────────
  // Creates a Journal voucher: Dr selected Cash/Bank account → Cr SP-OPNBAL
  // Requires cashAccountId — no silent auto-pick.
  app.post(
    "/api/sp/migration/opening-balance",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const { targetCompanyId, cashAccountId, amount, date, narration } = req.body ?? {};
        const targetId = parseInt(String(targetCompanyId ?? ""), 10);
        const cashId = parseInt(String(cashAccountId ?? ""), 10);

        if (!targetId) return res.status(400).json({ message: "targetCompanyId is required" });
        if (!cashId)
          return res.status(400).json({ message: "cashAccountId is required — select a cash or bank account" });
        if (!amount || parseMoneyInput(amount) === null) return res.status(400).json({ message: "amount is required" });
        if (!date) return res.status(400).json({ message: "date is required" });

        const targetComp = await getCompanyRow(targetId);
        if (!targetComp) return res.status(404).json({ message: "Target company not found" });
        if (targetComp.company_type !== "supplier_partner") {
          return res.status(400).json({ message: "Target must be a supplier_partner company" });
        }

        // Verify the selected cash account belongs to target company
        const cashAcctRow = (
          await db.execute(sql`
        SELECT id, name, account_type FROM ledger_accounts
        WHERE id = ${cashId} AND company_id = ${targetId} AND deleted_at IS NULL LIMIT 1
      `)
        ).rows[0] as unknown as { account_type: string } & { name: unknown } & { account_type: unknown };
        if (!cashAcctRow) {
          return res.status(400).json({ message: "Selected cash account not found in target company" });
        }
        if (!["Cash", "Bank"].includes(cashAcctRow.account_type)) {
          return res
            .status(400)
            .json({ message: `Account "${cashAcctRow.name}" is type "${cashAcctRow.account_type}", not Cash or Bank` });
        }

        // Find SP-OPNBAL account
        const opnBalRows = (
          await db.execute(sql`
        SELECT id FROM ledger_accounts
        WHERE company_id = ${targetId} AND sub_type = 'sp_opnbal' AND deleted_at IS NULL LIMIT 1
      `)
        ).rows;
        if (!opnBalRows.length) {
          return res
            .status(400)
            .json({ message: "SP-OPNBAL account not found in target company. Run the GC migration first." });
        }
        const opnBalId = pn(opnBalRows[0].id);

        const amtStr = toMoney(amount).toFixed(2);
        const voucherNumber = `OB-${targetId}-${Date.now()}`;

        const voucherId = await db.transaction(async (tx) => {
          const [vRow] = (
            await tx.execute(sql`
        INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module)
        VALUES (${targetId}, ${voucherNumber}, 'Journal', ${date},
                ${narration ?? "GC Opening Cash Balance"}, ${amtStr}, 'USD', 'ERP')
        RETURNING id
      `)
          ).rows;
          const voucherId = pn(vRow.id);

          // Dr selected Cash/Bank account
          await tx.execute(sql`
        INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
        VALUES (${voucherId}, ${cashId}, ${amtStr}, '0.00', ${narration ?? "Opening cash balance"})
      `);
          // Cr SP-OPNBAL
          await tx.execute(sql`
        INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
        VALUES (${voucherId}, ${opnBalId}, '0.00', ${amtStr}, ${narration ?? "Opening cash balance"})
      `);
          return voucherId;
        });

        return res.json({ success: true, voucherId, voucherNumber, amount: amtStr, cashAccountName: cashAcctRow.name });
      } catch (err: unknown) {
        logger.error("[SP Migration] opening-balance error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── POST /api/sp/migration/rollback (extended) ───────────────────────────
  // Updated below — existing endpoint handles all tracked tables.
  // Extension: also handles voucher_entries, vouchers, ledger_accounts.
}
