import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { requireAuth, requireRole } from "../../../auth";
import { pool } from "../../../db";
import {
  previewHistoricalCostReplayWithExecutor,
  type ReplayQueryExecutor,
} from "../../../services/factory/historicalCostReplay";
import { verifyRepairToken } from "../../../services/factory/repairToken";
import { toMoney } from "../../../lib/money";
import {
  APPLY_PATH,
  PREVIEW_PATH,
  ADJUSTMENT_CLASSIFICATION_PATH,
  ADMIN_ROLES,
  readCurrentNetPosition,
  loadBalanceProjectionBase,
  scopeFinancialImpact,
  type SignedReplayScopeToken,
} from "./historicalReplayPhase6GuardRoutesHelpers";

function parsePositiveIntegerIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((entry) => Number(entry));
  if (ids.some((entry) => !Number.isInteger(entry) || entry <= 0)) return null;
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * Final fail-closed V7 guard and preview routes.
 *
 * - GET returns the real safety gates, blocked/unclassified rows and Net Position impact.
 * - Prepare rejects force-apply and finalized-bale writes.
 * - The successful dry-run response is augmented with the exact selected/expanded
 *   supplier and batch financial impact returned by the signed-scope route.
 * - Historical adjustment valuation is explicitly classifiable with an audit row.
 */
export function registerHistoricalReplayPhase6GuardRoutes(app: Express): void {
  app.get(PREVIEW_PATH, requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    try {
      const preview = await previewHistoricalCostReplayWithExecutor(pool as ReplayQueryExecutor, companyId);
      const [currentNetPosition, balanceBase] = await Promise.all([
        readCurrentNetPosition(req),
        loadBalanceProjectionBase(companyId, preview),
      ]);
      const financialImpact = scopeFinancialImpact(
        preview,
        preview.supplierRows.map((row) => row.supplierId),
        preview.batchRows.map((row) => row.batchId),
        currentNetPosition,
        balanceBase
      );
      if (financialImpact) preview.financialImpact = financialImpact;
      return res.json(preview);
    } catch (error: unknown) {
      logger.error("[historical-replay v7 preview] error:", { error: error });
      return res.status(500).json({
        message: getErrorMessage(error) || "Failed to compute Historical Replay preview",
        code: (error as { code?: string }).code,
      });
    }
  });

  app.patch(ADJUSTMENT_CLASSIFICATION_PATH, requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const adjustmentId = Number(req.params.id);
    const valuationBasis = String(req.body?.valuationBasis || "").toUpperCase();
    const basisEvidence = typeof req.body?.basisEvidence === "string" ? req.body.basisEvidence.trim() : "";
    if (basisEvidence.length < 20 || basisEvidence.length > 1000) {
      return res.status(400).json({
        code: "HISTORICAL_ADJUSTMENT_EVIDENCE_REQUIRED",
        message:
          "Explain the documentary evidence and original valuation basis (20–1000 characters) before classification.",
      });
    }
    const allowed = new Set(["QUANTITY_ONLY", "VALUED_TRANSFER", "OPENING_BALANCE"]);
    if (!Number.isInteger(adjustmentId) || adjustmentId <= 0) {
      return res.status(400).json({ message: "Invalid adjustment id" });
    }
    if (!allowed.has(valuationBasis)) {
      return res.status(400).json({
        message: "valuationBasis must be QUANTITY_ONLY, VALUED_TRANSFER, or OPENING_BALANCE",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        id: number;
        type: string;
        supplier_id: number | null;
        valuation_basis: string | null;
        currency_code: string | null;
        cost_per_kg: string | null;
      }>(
        `SELECT id, type, supplier_id, valuation_basis, currency_code, cost_per_kg
           FROM factory_raw_material_adjustments
           WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
        [adjustmentId, companyId]
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Adjustment not found" });
      }
      if (String(row.type).toUpperCase() !== "ADD" || row.supplier_id == null) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "Only supplier-linked ADD adjustments can be classified for replay.",
        });
      }
      if (valuationBasis !== "QUANTITY_ONLY" && String(row.currency_code || "USD").toUpperCase() !== "USD") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message:
            "Valued transfers and opening balances require an explicit stored USD cost. This adjustment is not denominated in USD.",
        });
      }
      if (valuationBasis !== "QUANTITY_ONLY" && !(toMoney(row.cost_per_kg).toNumber() > 0)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "A valued transfer or opening balance must have a positive USD cost per kg.",
        });
      }

      await client.query(
        `UPDATE factory_raw_material_adjustments
           SET valuation_basis = $1
           WHERE id = $2 AND company_id = $3`,
        [valuationBasis, adjustmentId, companyId]
      );
      await client.query(
        `INSERT INTO audit_log
             (user_id, username, company_id, action, table_name, record_id,
              record_identifier, changes, created_at)
           VALUES ($1, $2, $3, 'historical_replay_adjustment_classified',
                   'factory_raw_material_adjustments', $4, $5, $6::jsonb, NOW())`,
        [
          String(req.session.userId ?? ""),
          req.session.username ?? null,
          companyId,
          adjustmentId,
          `raw material adjustment ${adjustmentId} valuation basis`,
          JSON.stringify({
            before: row.valuation_basis,
            after: valuationBasis,
            basisEvidence,
            currencyCode: row.currency_code || "USD",
            costPerKg: row.cost_per_kg,
          }),
        ]
      );
      await client.query("COMMIT");
      return res.json({ success: true, adjustmentId, valuationBasis });
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        message: getErrorMessage(error) || "Failed to classify adjustment",
        code: (error as { code?: string }).code,
      });
    } finally {
      client.release();
    }
  });

  app.post(APPLY_PATH, requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next) => {
    const hasToken = typeof req.body?.confirmationToken === "string" && req.body.confirmationToken.length > 0;

    if (req.body?.includeFinalizedBales === true) {
      return res.status(409).json({
        message:
          "Finalized/sold bale costs are outside this cost-only migration. Run a separate approved COGS migration if those records must change.",
        code: "HISTORICAL_REPLAY_FINALIZED_BALES_FORBIDDEN",
      });
    }

    if (hasToken) {
      if (req.body?.dryRun === true) {
        return res.status(400).json({
          message: "A confirmation token can only be used for apply. Re-run Prepare without a token.",
          code: "HISTORICAL_REPLAY_CONFLICTING_MODE",
        });
      }
      return next();
    }

    const forceSupplierIds = parsePositiveIntegerIds(req.body?.forceSupplierIds) ?? [];
    if (forceSupplierIds.length > 0) {
      return res.status(409).json({
        message: "Historical Replay no longer permits force-applying quantity mismatches. Resolve the timeline first.",
        code: "HISTORICAL_REPLAY_FORCE_APPLY_FORBIDDEN",
      });
    }

    const supplierIds = parsePositiveIntegerIds(req.body?.supplierIds);
    if (!supplierIds || supplierIds.length === 0) {
      return res.status(400).json({
        message: "Select at least one safe supplier before preparing Historical Replay.",
        code: "HISTORICAL_REPLAY_EMPTY_SCOPE",
      });
    }

    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    try {
      const preview = await previewHistoricalCostReplayWithExecutor(pool as ReplayQueryExecutor, companyId);
      const [currentNetPosition, balanceBase] = await Promise.all([
        readCurrentNetPosition(req),
        loadBalanceProjectionBase(companyId, preview),
      ]);
      const originalJson = res.json.bind(res);
      res.json = (payload) => {
        if (!payload?.dryRun) return originalJson(payload);
        if (payload.downstreamSafety?.safeToApply === false) {
          return originalJson({
            ...payload,
            financialImpact: undefined,
            projectionError:
              "Downstream production/COGS/GL safeguards blocked this historical replay. Review downstreamSafety.blockers before preparing another scope.",
          });
        }
        const expandedSupplierIds = parsePositiveIntegerIds(payload.safeSupplierIds) ?? supplierIds;
        let batchIds: number[];
        try {
          const signed = verifyRepairToken<SignedReplayScopeToken>(payload.confirmationToken);
          batchIds = parsePositiveIntegerIds(signed.scope?.batchIdsToUpdate) ?? [];
        } catch {
          // The exact V4 handler will already have rejected an invalid token. If its
          // response cannot be decoded here, fail closed rather than show a partial projection.
          return originalJson({
            ...payload,
            financialImpact: undefined,
            projectionError: "Signed batch scope could not be decoded. Re-run Prepare.",
          });
        }
        const financialImpact = scopeFinancialImpact(
          preview,
          expandedSupplierIds,
          batchIds,
          currentNetPosition,
          balanceBase
        );
        return originalJson({
          ...payload,
          financialImpact,
          unclassifiedAdjustmentRows: preview.unclassifiedAdjustmentRows ?? [],
          blockedBatches: preview.blockedBatches ?? [],
        });
      };
      req.body.supplierIds = supplierIds;
      req.body.forceSupplierIds = [];
      req.body.includeFinalizedBales = false;
      return next();
    } catch (error: unknown) {
      return res.status(500).json({
        message: getErrorMessage(error) || "Failed to validate Historical Replay prepare request",
        code: (error as { code?: string }).code,
      });
    }
  });
}
