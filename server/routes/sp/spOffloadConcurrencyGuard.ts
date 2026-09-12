import type { Express, NextFunction, Request, Response } from "express";
import { pool } from "../../db";
import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  buildSpOffloadChargeSignature,
  classifySpOffloadState,
  isCompatibleSpOffloadReplay,
  normalizeSpOffloadDate,
} from "../../services/sp/spOffloadConcurrencyPolicy";
import { requireSpCompany } from "./spHelpers";

function uniquePositiveIds(values: unknown[]): number[] {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort(
    (left, right) => left - right
  );
}

async function guardSpOffload(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = await requireSpCompany(req, res);
  if (!companyId) return;

  const containerId = Number(req.body?.containerId);
  if (!Number.isInteger(containerId) || containerId <= 0) {
    res.status(400).json({ message: "containerId is required" });
    return;
  }

  const locationId = Number(req.body?.locationId);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    res.status(400).json({ message: "locationId is required" });
    return;
  }

  const client = await pool.connect();
  let released = false;
  let transactionOpen = false;

  const release = async (commit: boolean) => {
    if (released) return;
    released = true;
    try {
      if (transactionOpen) {
        await client.query(commit ? "COMMIT" : "ROLLBACK");
        transactionOpen = false;
      }
    } catch (error) {
      logger.warn("SP offload ownership-lock transaction cleanup failed", {
        companyId,
        containerId,
        commit,
        error,
      });
    }

    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [companyId, containerId]);
    } catch (error) {
      logger.warn("SP offload advisory unlock failed", { companyId, containerId, error });
    } finally {
      client.release();
    }
  };

  try {
    const lockResult = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [
      companyId,
      containerId,
    ]);
    if (!lockResult.rows[0]?.locked) {
      client.release();
      released = true;
      res.status(409).json({
        code: "SP_OFFLOAD_IN_PROGRESS",
        message: "This container is currently being offloaded. Wait for the first request to finish before retrying.",
      });
      return;
    }

    await client.query("BEGIN");
    transactionOpen = true;

    res.once("finish", () => void release(true));
    res.once("close", () => void release(false));

    const containerResult = await client.query<{ status: string }>(
      `SELECT status
       FROM sp_containers
       WHERE id = $1 AND company_id = $2
       LIMIT 1
       FOR KEY SHARE`,
      [containerId, companyId]
    );
    const container = containerResult.rows[0];
    if (!container) {
      res.status(404).json({ message: "Container not found" });
      return;
    }

    const locationResult = await client.query(
      `SELECT id
       FROM locations
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
       LIMIT 1
       FOR SHARE`,
      [locationId, companyId]
    );
    if (!locationResult.rows[0]) {
      res.status(400).json({ message: "Invalid location for this company" });
      return;
    }

    const existingResult = await client.query(
      `SELECT o.id,
              o.company_id AS "companyId",
              o.container_id AS "containerId",
              o.offload_date AS "offloadDate",
              o.total_qty AS "totalQty",
              o.total_base_cost_usd AS "totalBaseCostUsd",
              o.total_landed_cost_usd AS "totalLandedCostUsd",
              o.total_final_cost_usd AS "totalFinalCostUsd",
              o.voucher_id_reversal AS "voucherIdReversal",
              o.voucher_id_stock AS "voucherIdStock",
              o.created_at AS "createdAt",
              (SELECT sm.location_id
               FROM sp_stock_movements sm
               WHERE sm.offload_id = o.id
               ORDER BY sm.id
               LIMIT 1) AS "locationId"
       FROM sp_offloads o
       WHERE o.container_id = $1 AND o.company_id = $2
       ORDER BY o.id DESC
       LIMIT 1`,
      [containerId, companyId]
    );
    const existingOffload = existingResult.rows[0] ?? null;

    let existingChargeSignature = buildSpOffloadChargeSignature([]);
    if (existingOffload) {
      const existingCharges = await client.query(
        `SELECT charge_type AS "chargeType",
                description,
                amount_usd AS "amountUsd",
                prepaid_charge_id AS "prepaidChargeId",
                credit_ledger_account_id AS "creditLedgerAccountId",
                credit_bank_account_id AS "creditBankAccountId"
         FROM sp_offload_charges
         WHERE offload_id = $1 AND company_id = $2`,
        [existingOffload.id, companyId]
      );
      existingChargeSignature = buildSpOffloadChargeSignature(existingCharges.rows);
    }

    const requestedCharges = Array.isArray(req.body?.chargeLines) ? req.body.chargeLines : [];
    const requestedLandedTotal = requestedCharges.reduce(
      (sum: number, charge: Record<string, unknown>) => sum + (Number.isFinite(Number(charge?.amountUsd)) ? Number(charge.amountUsd) : 0),
      0
    );
    const replayCompatible = existingOffload
      ? isCompatibleSpOffloadReplay(
          {
            offloadDate: normalizeSpOffloadDate(existingOffload.offloadDate),
            locationId: Number(existingOffload.locationId),
            totalLandedCostUsd: Number(existingOffload.totalLandedCostUsd ?? 0),
            chargeSignature: existingChargeSignature,
          },
          {
            offloadDate: normalizeSpOffloadDate(req.body?.offloadDate),
            locationId,
            totalLandedCostUsd: requestedLandedTotal,
            chargeSignature: buildSpOffloadChargeSignature(requestedCharges),
          }
        )
      : false;
    const decision = classifySpOffloadState(container.status, Boolean(existingOffload), replayCompatible);

    if (decision === "replay") {
      const { locationId: _locationId, ...responseOffload } = existingOffload;
      res.setHeader("X-Idempotent-Replay", "true");
      res.json(responseOffload);
      return;
    }
    if (decision === "conflict") {
      res.status(409).json({
        code: "SP_OFFLOAD_REPLAY_MISMATCH",
        message: "This container is already offloaded with different date, location, or charge allocation.",
      });
      return;
    }
    if (decision === "reject") {
      res.status(409).json({
        code: "SP_CONTAINER_NOT_OPEN",
        message: "Container is not open and has no completed offload to replay.",
      });
      return;
    }

    const requiredSubTypes = ["sp_goods_otw", "sp_otw_clearing", "sp_stock", "sp_cost_clearing"];
    if (requestedCharges.some((charge: Record<string, unknown>) => charge?.chargeType === "prepaid_used")) {
      requiredSubTypes.push("sp_prepaid");
    }
    if (requestedCharges.some((charge: Record<string, unknown>) => charge?.chargeType === "parent_agent")) {
      requiredSubTypes.push("sp_prepaid_expenses");
    }

    const controlAccounts = await client.query<{ sub_type: string }>(
      `SELECT sub_type
       FROM ledger_accounts
       WHERE company_id = $1
         AND sub_type = ANY($2::text[])
         AND deleted_at IS NULL
       ORDER BY sub_type
       FOR SHARE`,
      [companyId, requiredSubTypes]
    );
    const foundSubTypes = new Set(controlAccounts.rows.map((row) => row.sub_type));
    const missingSubTypes = requiredSubTypes.filter((subType) => !foundSubTypes.has(subType));
    if (missingSubTypes.length > 0) {
      res.status(400).json({
        message: `SP accounts not configured: ${missingSubTypes.join(", ")}. Run setup first.`,
      });
      return;
    }

    const bankIds = uniquePositiveIds(
      requestedCharges
        .filter((charge: Record<string, unknown>) => charge?.chargeType === "paid_now")
        .map((charge: Record<string, unknown>) => charge?.creditBankAccountId)
    );
    if (bankIds.length > 0) {
      const bankRows = await client.query<{ id: number }>(
        `SELECT id
         FROM bank_accounts
         WHERE company_id = $1 AND id = ANY($2::int[])
         ORDER BY id
         FOR SHARE`,
        [companyId, bankIds]
      );
      const foundIds = new Set(bankRows.rows.map((row) => Number(row.id)));
      const missingId = bankIds.find((id) => !foundIds.has(id));
      if (missingId) {
        res.status(400).json({ message: `Bank account #${missingId} not found for this company` });
        return;
      }
    }

    const ledgerIds = uniquePositiveIds(
      requestedCharges
        .filter((charge: Record<string, unknown>) => charge?.chargeType === "unpaid_payable" || charge?.chargeType === "other")
        .map((charge: Record<string, unknown>) => charge?.creditLedgerAccountId)
    );
    if (ledgerIds.length > 0) {
      const ledgerRows = await client.query<{ id: number }>(
        `SELECT id
         FROM ledger_accounts
         WHERE company_id = $1
           AND id = ANY($2::int[])
           AND deleted_at IS NULL
         ORDER BY id
         FOR SHARE`,
        [companyId, ledgerIds]
      );
      const foundIds = new Set(ledgerRows.rows.map((row) => Number(row.id)));
      const missingId = ledgerIds.find((id) => !foundIds.has(id));
      if (missingId) {
        res.status(400).json({ message: `Ledger account #${missingId} not found for this company` });
        return;
      }
    }

    const parentAgentIds = uniquePositiveIds(
      requestedCharges
        .filter((charge: Record<string, unknown>) => charge?.chargeType === "parent_agent")
        .map((charge: Record<string, unknown>) => charge?.parentAgentAccountId)
    );
    if (parentAgentIds.length > 0) {
      const parentCompany = await client.query<{ parent_company_id: number | null }>(
        "SELECT parent_company_id FROM companies WHERE id = $1 LIMIT 1",
        [companyId]
      );
      const parentCompanyId = Number(parentCompany.rows[0]?.parent_company_id ?? 1);
      const parentLedgers = await client.query<{ id: number }>(
        `SELECT id
         FROM ledger_accounts
         WHERE company_id = $1
           AND id = ANY($2::int[])
           AND deleted_at IS NULL
         ORDER BY id
         FOR SHARE`,
        [parentCompanyId, parentAgentIds]
      );
      const foundIds = new Set(parentLedgers.rows.map((row) => Number(row.id)));
      const missingId = parentAgentIds.find((id) => !foundIds.has(id));
      if (missingId) {
        res.status(400).json({ message: `Parent agent ledger #${missingId} not found for the parent company` });
        return;
      }
    }

    // The legacy offload handler commits its own write transaction before calling
    // res.json(). Release this guard's advisory lock first, then emit the response.
    // That guarantees the client never observes "request complete" while the lock is
    // still held, so an immediate identical retry is classified as a replay instead
    // of racing the asynchronous finish-event cleanup and receiving a false 409.
    const originalJson = res.json.bind(res);
    let responseScheduled = false;
    res.json = ((body: unknown) => {
      if (responseScheduled) return res;
      responseScheduled = true;
      void release(res.statusCode < 500).then(() => originalJson(body));
      return res;
    }) as typeof res.json;

    next();
  } catch (error: unknown) {
    await release(false);
    logger.error("SP offload concurrency guard failed", { companyId, containerId, error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

/** Register before the legacy SP offload route. */
export function registerSpOffloadConcurrencyGuard(app: Express): void {
  app.post("/api/sp/offload", requireAuth, (req, res, next) => {
    void guardSpOffload(req, res, next);
  });
}
