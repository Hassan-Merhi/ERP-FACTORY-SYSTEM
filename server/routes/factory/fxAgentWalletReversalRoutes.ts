import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { getFxAgentWalletSnapshot, loadFxAgentWallets } from "../../services/factory/fxAgentWalletDb";

const ROLES = ["Admin", "Owner", "Developer"] as const;
const company = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;

async function reversalSchemaReady(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'factory_fx_agent_wallet_operations'
        AND column_name = 'reverses_operation_id'
    ) AS ready
  `);
  return result.rows[0]?.ready === true;
}

/** A conversion is reversible only if no later EUR settlement could have consumed it.
 * A compensating operation restores exactly its historical USD basis, preserving
 * every original entry, date, rate and actor in the audit trail.
 */
export function registerFactoryFxAgentReversalRoutes(app: Express) {
  app.get("/api/factory/fx-agent-wallets/:id/conversions", requireAuth, async (req: Request, res: Response) => {
    try {
      const cid = company(req);
      const walletId = Number(req.params.id);
      if (!cid || !validId(walletId)) return res.status(400).json({ message: "Invalid wallet" });
      if (!(await reversalSchemaReady())) return res.json({ migrationRequired: true, conversions: [] });
      const wallet = (await loadFxAgentWallets(cid)).find((w) => w.id === walletId);
      if (!wallet) return res.status(404).json({ message: "FX agent wallet not found" });
      const result = await db.execute(sql`
        SELECT op.id, op.effective_date::text AS date,
          op.source_amount::text AS "usdAmount",
          op.target_amount::text AS "eurAmount",
          op.rate_usd_per_eur::text AS rate,
          op.created_by AS actor,
          EXISTS (
            SELECT 1 FROM factory_fx_agent_wallet_operations reversal
            WHERE reversal.company_id = ${cid} AND reversal.wallet_id = ${walletId}
              AND reversal.reverses_operation_id = op.id
          ) AS reversed,
          EXISTS (
            SELECT 1 FROM factory_fx_agent_wallet_operations settlement
            WHERE settlement.company_id = ${cid} AND settlement.wallet_id = ${walletId}
              AND settlement.kind = 'EUR_SETTLEMENT'
              AND (settlement.effective_date, settlement.id) > (op.effective_date, op.id)
          ) AS "hasLaterSettlement"
        FROM factory_fx_agent_wallet_operations op
        WHERE op.company_id = ${cid} AND op.wallet_id = ${walletId} AND op.kind = 'USD_TO_EUR'
        ORDER BY op.effective_date DESC, op.id DESC LIMIT 100
      `);
      return res.json({ migrationRequired: false, conversions: result.rows });
    } catch (error) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/factory/fx-agent-wallets/:id/reverse-conversion",
    requireAuth,
    requireRole(...ROLES),
    async (req: Request, res: Response) => {
      try {
        const cid = company(req);
        const walletId = Number(req.params.id);
        const conversionId = Number(req.body?.conversionId);
        const requestKey = String(req.body?.requestKey || "");
        const reason = String(req.body?.reason || "").trim();
        if (
          !cid ||
          !validId(walletId) ||
          !validId(conversionId) ||
          !/^[A-Za-z0-9._:-]{8,100}$/.test(requestKey) ||
          !reason ||
          reason.length > 500
        ) {
          return res
            .status(400)
            .json({ message: "Select a conversion and provide a reversal reason (max 500 characters)" });
        }
        if (!(await reversalSchemaReady())) {
          return res
            .status(409)
            .json({ code: "FX_REVERSAL_MIGRATION_REQUIRED", message: "Apply the FX reversal SQL migration first" });
        }
        const saved = await db.transaction(async (tx) => {
          // The same wallet lock as conversion and settlement serializes all edits.
          const lock = await tx.execute(sql`
            SELECT id FROM factory_fx_agent_wallets
            WHERE company_id = ${cid} AND id = ${walletId} FOR UPDATE
          `);
          if (!lock.rows.length) throw new Error("FX agent wallet not found");
          const existing = await tx.execute(sql`
            SELECT id, wallet_id AS "walletId", reverses_operation_id AS "conversionId", kind, narration
            FROM factory_fx_agent_wallet_operations
            WHERE company_id = ${cid} AND request_key = ${requestKey}
          `);
          if (existing.rows.length) {
            const row = existing.rows[0];
            if (
              row.kind !== "EUR_TO_USD_REVERSAL" ||
              Number(row.walletId) !== walletId ||
              Number(row.conversionId) !== conversionId ||
              String(row.narration || "").trim() !== reason
            ) {
              throw new Error("Request key was used for a different operation");
            }
            return { id: Number(row.id), replayed: true };
          }
          const original = await tx.execute(sql`
            SELECT id, source_amount::text AS usd, target_amount::text AS eur,
              rate_usd_per_eur::text AS rate, effective_date::text AS date
            FROM factory_fx_agent_wallet_operations
            WHERE company_id = ${cid} AND wallet_id = ${walletId}
              AND id = ${conversionId} AND kind = 'USD_TO_EUR'
          `);
          if (!original.rows.length) throw new Error("Conversion does not belong to this FX wallet");
          const priorReverse = await tx.execute(sql`
            SELECT 1 FROM factory_fx_agent_wallet_operations
            WHERE company_id = ${cid} AND wallet_id = ${walletId}
              AND reverses_operation_id = ${conversionId} LIMIT 1
          `);
          if (priorReverse.rows.length) throw new Error("This conversion has already been reversed");
          const row = original.rows[0];
          const laterPayment = await tx.execute(sql`
            SELECT 1 FROM factory_fx_agent_wallet_operations
            WHERE company_id = ${cid} AND wallet_id = ${walletId}
              AND kind = 'EUR_SETTLEMENT'
              AND (effective_date, id) > (${String(row.date)}::date, ${conversionId})
            LIMIT 1
          `);
          if (laterPayment.rows.length) {
            throw new Error("Cannot reverse a conversion after EUR has been paid out. Reconcile the settlement first");
          }
          const wallet = (await loadFxAgentWallets(cid, undefined, tx)).find((w) => w.id === walletId);
          if (!wallet) throw new Error("FX agent wallet not found");
          const snapshot = await getFxAgentWalletSnapshot(wallet, getClientDate(req), tx);
          if (!snapshot.synchronized) throw new Error("Agent ledger does not match wallet. Reconcile before reversing");
          if (
            toMoney(String(row.eur)).gt(snapshot.state.eur) ||
            toMoney(String(row.usd)).gt(snapshot.state.eurBookUsd)
          ) {
            throw new Error("Insufficient native EUR or USD book basis for reversal");
          }
          const today = getClientDate(req);
          if (snapshot.latestOperationDate && today < snapshot.latestOperationDate) {
            throw new Error("Cannot reverse before a later wallet movement");
          }
          const inserted = await tx.execute(sql`
            INSERT INTO factory_fx_agent_wallet_operations
            (company_id,wallet_id,effective_date,kind,source_currency,source_amount,
             target_currency,target_amount,rate_usd_per_eur,source_book_usd,
             reverses_operation_id,request_key,narration,created_by)
            VALUES (${cid},${walletId},${today},'EUR_TO_USD_REVERSAL',
              'EUR',${String(row.eur)},'USD',${String(row.usd)},${String(row.rate)},
              ${String(row.usd)},${conversionId},${requestKey},${reason},
              ${req.session.username || "unknown"})
            RETURNING id
          `);
          return {
            id: Number(inserted.rows[0].id),
            replayed: false,
            restoredUsd: String(row.usd),
            deductedEur: String(row.eur),
          };
        });
        return res.status(201).json(saved);
      } catch (error) {
        return res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
}
