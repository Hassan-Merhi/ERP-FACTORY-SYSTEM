import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { requireAuth, requireRole } from "../../../auth";
import { pool } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  previewHistoricalCostReplayWithExecutor,
  REPLAY_ALGORITHM_VERSION,
  type ReplayQueryExecutor,
} from "../../../services/factory/historicalCostReplay";
import { REPAIR_TOKEN_TTL_MS, signRepairToken, verifyRepairToken } from "../../../services/factory/repairToken";
import {
  evaluateHistoricalReplaySafetyReadiness,
  historicalReplayAuthorizationReady,
  historicalReplayReadinessVersion,
  inspectHistoricalReplayProductionSchema,
  readHistoricalReplayProductionControl,
  type HistoricalReplaySchemaReadiness,
} from "../../../services/factory/historical-replay/productionReadinessV8";

const APPLY_PATH = "/api/factory/raw-stock/recalc/historical-replay/apply";
const READINESS_PATH = "/api/factory/raw-stock/recalc/historical-replay/readiness";
const ADMIN_ROLES = ["Admin", "Developer"] as const;
const APPLY_AUTHORIZATION_KIND = "HISTORICAL_REPLAY_V8_APPLY_AUTHORIZATION" as const;

interface HistoricalReplayApplyAuthorizationPayload {
  kind: typeof APPLY_AUTHORIZATION_KIND;
  companyId: number;
  userId: string;
  releaseId: string;
  algorithmVersion: string;
  readinessVersion: string;
  confirmationTokenHash: string;
  issuedAt: number;
  expiresAt: number;
}

interface LatestReplayRow {
  id: number;
  algorithm_version: string | null;
  scope_fingerprint: string | null;
  applied_at: Date | string;
  undone_at: Date | string | null;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function positiveIntegerIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => Number(item));
  if (ids.some((item) => !Number.isInteger(item) || item <= 0)) return [];
  return [...new Set(ids)].sort((left, right) => left - right);
}

function disabledSchemaReadiness(error: unknown): HistoricalReplaySchemaReadiness {
  return {
    ready: false,
    objects: [],
    missingObjects: [`readiness-query:${getErrorMessage(error) || "unknown error"}`],
  };
}

function authorizationPayload(value: unknown): HistoricalReplayApplyAuthorizationPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.kind !== APPLY_AUTHORIZATION_KIND ||
    !Number.isInteger(payload.companyId) ||
    typeof payload.userId !== "string" ||
    typeof payload.releaseId !== "string" ||
    typeof payload.algorithmVersion !== "string" ||
    typeof payload.readinessVersion !== "string" ||
    typeof payload.confirmationTokenHash !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    return null;
  }
  return payload as unknown as HistoricalReplayApplyAuthorizationPayload;
}

async function latestReplayForCompany(companyId: number): Promise<LatestReplayRow | null> {
  const result = await pool.query<LatestReplayRow>(
    `SELECT id, algorithm_version, scope_fingerprint, applied_at, undone_at
     FROM factory_recalc_undo_log
     WHERE company_id = $1
       AND operation_type = 'HISTORICAL_REPLAY_EXACT'
     ORDER BY applied_at DESC, id DESC
     LIMIT 1`,
    [companyId]
  );
  return result.rows[0] ?? null;
}

/**
 * Phase 8 adds a production control plane around the exact V7 engine.
 *
 * Preview and Prepare remain non-mutating. Apply remains disabled by default and
 * requires both the existing exact replay token and a second short-lived token
 * bound to the configured release, company, user, algorithm, and exact replay token.
 */
export function registerHistoricalReplayPhase8ReadinessRoutes(app: Express): void {
  app.get(READINESS_PATH, requireAuth, requireRole(...ADMIN_ROLES), async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    try {
      const [schema, preview] = await Promise.all([
        inspectHistoricalReplayProductionSchema(pool as ReplayQueryExecutor),
        previewHistoricalCostReplayWithExecutor(pool as ReplayQueryExecutor, companyId),
      ]);
      const control = readHistoricalReplayProductionControl();
      const safety = evaluateHistoricalReplaySafetyReadiness(preview);
      const readyForApplyAuthorization =
        historicalReplayAuthorizationReady({
          control,
          schema,
          safety,
        }) &&
        safety.applicableSupplierCount > 0 &&
        safety.applicableChangeCount > 0;
      const latestReplay = schema.ready ? await latestReplayForCompany(companyId) : null;

      return res.json({
        phase: "V8",
        generatedAt: new Date().toISOString(),
        companyId,
        algorithmVersion: REPLAY_ALGORITHM_VERSION,
        readinessVersion: historicalReplayReadinessVersion(),
        readyForApplyAuthorization,
        control: {
          enabled: control.enabled,
          releaseId: control.releaseId,
          configurationErrors: control.configurationErrors,
        },
        schema,
        safety,
        latestReplay,
        instructions: readyForApplyAuthorization
          ? "Re-run Prepare immediately before Apply. The authorization is short-lived and bound to that exact prepared replay token."
          : "Apply remains blocked. Resolve every reported configuration, schema, safety, or no-change condition before preparing an authorized apply.",
      });
    } catch (error: unknown) {
      logger.error("[historical-replay v8 readiness] error", { error });
      return res.status(500).json({
        message: getErrorMessage(error) || "Failed to inspect Historical Replay production readiness",
        code: (error as { code?: string }).code,
      });
    }
  });

  app.post(APPLY_PATH, requireAuth, async (req: Request, res: Response, next) => {
    const confirmationToken = typeof req.body?.confirmationToken === "string" ? req.body.confirmationToken : "";
    const isPrepare = confirmationToken.length === 0;
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    const userId = String(req.session.userId ?? "");
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    let schema: HistoricalReplaySchemaReadiness;
    try {
      schema = await inspectHistoricalReplayProductionSchema(pool as ReplayQueryExecutor);
    } catch (error: unknown) {
      schema = disabledSchemaReadiness(error);
    }
    const control = readHistoricalReplayProductionControl();

    if (isPrepare) {
      const originalJson = res.json.bind(res);
      res.json = (payload) => {
        if (!payload?.dryRun || typeof payload.confirmationToken !== "string") {
          return originalJson(payload);
        }

        const safeSupplierIds = positiveIntegerIds(payload.safeSupplierIds);
        const gatesPassed = payload.financialImpact?.allSafetyGatesPassed === true;
        const algorithmMatches = payload.algorithmVersion === REPLAY_ALGORITHM_VERSION;
        const readyForApplyAuthorization =
          historicalReplayAuthorizationReady({
            control,
            schema,
          }) &&
          gatesPassed &&
          algorithmMatches &&
          safeSupplierIds.length > 0;

        if (!readyForApplyAuthorization || !control.releaseId) {
          return originalJson({
            ...payload,
            productionReadiness: {
              phase: "V8",
              readyForApplyAuthorization: false,
              control: {
                enabled: control.enabled,
                releaseId: control.releaseId,
                configurationErrors: control.configurationErrors,
              },
              schemaReady: schema.ready,
              missingSchemaObjects: schema.missingObjects,
              safetyGatesPassed: gatesPassed,
              algorithmMatches,
            },
          });
        }

        const issuedAt = Date.now();
        const authorization: HistoricalReplayApplyAuthorizationPayload = {
          kind: APPLY_AUTHORIZATION_KIND,
          companyId,
          userId,
          releaseId: control.releaseId,
          algorithmVersion: REPLAY_ALGORITHM_VERSION,
          readinessVersion: historicalReplayReadinessVersion(),
          confirmationTokenHash: sha256(payload.confirmationToken),
          issuedAt,
          expiresAt: issuedAt + REPAIR_TOKEN_TTL_MS,
        };

        return originalJson({
          ...payload,
          applyAuthorizationToken: signRepairToken(authorization),
          productionReleaseId: control.releaseId,
          productionReadiness: {
            phase: "V8",
            readyForApplyAuthorization: true,
            releaseId: control.releaseId,
            expiresInMs: REPAIR_TOKEN_TTL_MS,
            algorithmVersion: REPLAY_ALGORITHM_VERSION,
            readinessVersion: authorization.readinessVersion,
          },
        });
      };
      return next();
    }

    const actorRole = req.user?.role;
    if (!actorRole || !ADMIN_ROLES.some((allowed) => allowed === actorRole)) {
      return res.status(403).json({
        message: "Only Admin or Developer may apply Historical Replay.",
        code: "HISTORICAL_REPLAY_APPLY_ROLE_FORBIDDEN",
      });
    }
    if (!control.enabled || !control.releaseId) {
      return res.status(503).json({
        message: "Historical Replay apply is disabled by the production release control.",
        code: "HISTORICAL_REPLAY_APPLY_DISABLED",
        configurationErrors: control.configurationErrors,
      });
    }
    if (!schema.ready) {
      return res.status(503).json({
        message: "Historical Replay apply is blocked because required safety schema is incomplete.",
        code: "HISTORICAL_REPLAY_SCHEMA_NOT_READY",
        missingSchemaObjects: schema.missingObjects,
      });
    }

    const productionReleaseId = String(req.body?.productionReleaseId ?? "");
    if (productionReleaseId !== control.releaseId) {
      return res.status(409).json({
        message: "Historical Replay release identifier changed or is missing. Re-run Prepare.",
        code: "HISTORICAL_REPLAY_RELEASE_MISMATCH",
      });
    }

    const rawAuthorizationToken = req.body?.applyAuthorizationToken;
    if (typeof rawAuthorizationToken !== "string" || rawAuthorizationToken.length === 0) {
      return res.status(400).json({
        message: "A V8 apply authorization token is required. Re-run Prepare.",
        code: "HISTORICAL_REPLAY_APPLY_AUTHORIZATION_REQUIRED",
      });
    }

    try {
      const verified = authorizationPayload(
        verifyRepairToken<HistoricalReplayApplyAuthorizationPayload>(rawAuthorizationToken)
      );
      if (!verified) {
        return res.status(400).json({
          message: "Historical Replay apply authorization is malformed. Re-run Prepare.",
          code: "HISTORICAL_REPLAY_APPLY_AUTHORIZATION_INVALID",
        });
      }
      if (
        verified.companyId !== companyId ||
        verified.userId !== userId ||
        verified.releaseId !== control.releaseId ||
        verified.algorithmVersion !== REPLAY_ALGORITHM_VERSION ||
        verified.readinessVersion !== historicalReplayReadinessVersion() ||
        verified.confirmationTokenHash !== sha256(confirmationToken)
      ) {
        return res.status(409).json({
          message:
            "Historical Replay apply authorization no longer matches this company, user, release, algorithm, or prepared replay. Re-run Prepare.",
          code: "HISTORICAL_REPLAY_APPLY_AUTHORIZATION_MISMATCH",
        });
      }
    } catch (error: unknown) {
      return res.status(400).json({
        message: `Invalid or expired Historical Replay apply authorization: ${getErrorMessage(error)}`,
        code: "HISTORICAL_REPLAY_APPLY_AUTHORIZATION_INVALID",
      });
    }

    return next();
  });
}
