/**
 * Read-only raw-material FX diagnostic + admin repair.
 *
 * Scans every raw-material financial write surface that carries a per-row
 * currency + exchange rate (containers, post-offload additional charges,
 * container commissions) for the current company and reports, without
 * writing anything, which rows have an unresolved (unconfirmed, non-USD)
 * rate — broken down by supplier, container, currency, and status. Also
 * surfaces a much broader zero-write reconciliation (kg accounting, locked
 * cost/kg drift, free-stock value, supplier currency exposure, cross-company
 * contamination, double-reserved deductions, negative stock).
 *
 * Both the diagnostic GET and the repair POST are Admin/Developer-only: this
 * data (and especially the repair action) is financial and must not be
 * exposed to ordinary factory users.
 */
import type { Express } from "express";
import { requireSessionUserId } from "../../../lib/sessionUser";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factorySuppliers,
} from "@shared/schema";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";
import { logAudit } from "../../helpers/auditHelpers";
import {
  planFxResolutionRepair,
  applyFxResolutionRepair,
  AlreadyConfirmedError,
  ManualReviewRequiredError,
  type FxResolutionSource,
  type FxResolutionApplyResult,
} from "../../../services/factory/fxResolutionRepair";
import { getRawMaterialReconciliation } from "../../../services/factory/rawMaterialReconciliation";
import {
  signRepairToken,
  verifyRepairToken,
  ExpiredRepairTokenError,
  RepairTokenConfigurationError,
  REPAIR_TOKEN_TTL_MS,
} from "../../../services/factory/repairToken";

const VALID_SOURCES: FxResolutionSource[] = ["container", "offload_additional_charge", "commission"];
const ADMIN_ROLES = ["Admin", "Developer"] as const;

interface RepairTokenPayload {
  companyId: number;
  source: FxResolutionSource;
  id: number;
  newFxRateToUsd: number;
  oldFxRateToUsd: string | null;
  oldFxRateConfirmed: boolean;
  versionTag: string | null;
  userId: string;
  expiresAt: number;
}

interface UnresolvedRow {
  source: "container" | "offload_additional_charge" | "commission";
  id: number;
  containerId: number;
  containerNumber: string | null;
  supplierId: number | null;
  supplierName: string | null;
  status: string | null;
  currencyCode: string;
  storedFxRateToUsd: string | null;
  fxRateConfirmed: boolean;
  amountNative: string | null;
  description: string | null;
}

export function registerFactoryFxDiagnosticRoutes(app: Express) {
  app.get(
    "/api/factory/suppliers/fx-diagnostic",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const suppliers = await db
          .select({ id: factorySuppliers.id, name: factorySuppliers.name })
          .from(factorySuppliers)
          .where(eq(factorySuppliers.companyId, companyId));
        const supplierNameById = new Map<number, string>(suppliers.map((s) => [s.id, s.name]));

        // IMPORTANT: load ALL of this company's containers (not just non-USD ones) into
        // the lookup map. A non-USD charge/commission can be attached to a USD-currency
        // container — if that container is missing from the map, the charge/commission
        // row silently loses its real status (CLOSED/COMPLETED/OFFLOADED), which used to
        // let it slip past the manual-review classification below.
        const allContainers = await db
          .select()
          .from(factoryContainers)
          .where(eq(factoryContainers.companyId, companyId));
        const containerById = new Map(allContainers.map((c) => [c.id, c]));
        const nonUsdContainers = allContainers.filter((c) => c.currencyCode !== "USD");

        // Charges/commissions are scanned by companyId directly — NEVER gated on
        // "does this company have any non-USD containers", so a non-USD charge/commission
        // attached to a USD-currency container is still found and evaluated.
        const offloadCharges = await db
          .select()
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.companyId, companyId),
              ne(factoryOffloadAdditionalCharges.currencyCode, "USD")
            )
          );

        const commissions = await db
          .select()
          .from(factoryContainerCommissions)
          .where(
            and(
              eq(factoryContainerCommissions.companyId, companyId),
              ne(factoryContainerCommissions.currencyCode, "USD")
            )
          );

        const unresolved: UnresolvedRow[] = [];
        let containersScanned = 0;
        let chargesScanned = 0;
        let commissionsScanned = 0;

        for (const c of nonUsdContainers) {
          containersScanned++;
          const { looksSet } = resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed);
          if (!looksSet) {
            unresolved.push({
              source: "container",
              id: c.id,
              containerId: c.id,
              containerNumber: c.containerNumber,
              supplierId: c.supplierId,
              supplierName: c.supplierId ? supplierNameById.get(c.supplierId) || null : null,
              status: c.status,
              currencyCode: c.currencyCode,
              storedFxRateToUsd: c.fxRateToUsd,
              fxRateConfirmed: !!c.fxRateConfirmed,
              amountNative: c.ratePerKg && c.totalKg ? String(parseFloat(c.ratePerKg) * parseFloat(c.totalKg)) : null,
              description: `Container ${c.containerNumber}`,
            });
          }
        }

        for (const oc of offloadCharges as any[]) {
          chargesScanned++;
          const { looksSet } = resolveStoredFxRate(oc.currencyCode, oc.fxRateToUsd, oc.fxRateConfirmed);
          if (!looksSet) {
            const container = containerById.get(oc.containerId);
            const supplierId = oc.supplierId ?? container?.supplierId ?? null;
            unresolved.push({
              source: "offload_additional_charge",
              id: oc.id,
              containerId: oc.containerId,
              containerNumber: container?.containerNumber ?? null,
              supplierId,
              supplierName: supplierId ? supplierNameById.get(supplierId) || null : null,
              status: container?.status ?? null,
              currencyCode: oc.currencyCode,
              storedFxRateToUsd: oc.fxRateToUsd,
              fxRateConfirmed: !!oc.fxRateConfirmed,
              amountNative: oc.amount,
              description: oc.description,
            });
          }
        }

        for (const cm of commissions) {
          commissionsScanned++;
          const { looksSet } = resolveStoredFxRate(cm.currencyCode, cm.fxRateToUsd, cm.fxRateConfirmed);
          if (!looksSet) {
            const container = containerById.get(cm.containerId);
            unresolved.push({
              source: "commission",
              id: cm.id,
              containerId: cm.containerId,
              containerNumber: container?.containerNumber ?? null,
              supplierId: container?.supplierId ?? null,
              supplierName: container?.supplierId ? supplierNameById.get(container.supplierId) || null : null,
              status: container?.status ?? null,
              currencyCode: cm.currencyCode,
              storedFxRateToUsd: cm.fxRateToUsd,
              fxRateConfirmed: !!cm.fxRateConfirmed,
              amountNative: cm.commissionTotal,
              description: `Commission — ${cm.personName}`,
            });
          }
        }

        // Group for the summary views the UI/report will actually want.
        const bySupplier: Record<string, { supplierId: number | null; supplierName: string | null; count: number }> =
          {};
        const byCurrency: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        const byContainer: Record<
          number,
          { containerId: number; containerNumber: string | null; supplierName: string | null; rows: UnresolvedRow[] }
        > = {};

        for (const row of unresolved) {
          const supKey = String(row.supplierId ?? "none");
          if (!bySupplier[supKey])
            bySupplier[supKey] = { supplierId: row.supplierId, supplierName: row.supplierName, count: 0 };
          bySupplier[supKey].count++;

          byCurrency[row.currencyCode] = (byCurrency[row.currencyCode] || 0) + 1;

          const statusKey = row.status || "UNKNOWN";
          byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;

          if (!byContainer[row.containerId]) {
            byContainer[row.containerId] = {
              containerId: row.containerId,
              containerNumber: row.containerNumber,
              supplierName: row.supplierName,
              rows: [],
            };
          }
          byContainer[row.containerId].rows.push(row);
        }

        // CLOSED/COMPLETED/OFFLOADED containers must never be auto-repaired — surfaced
        // explicitly (using the FULL container status now that containerById always has
        // every container, not just non-USD ones) so the repair service and any human
        // reviewer always sees this correctly, even for a non-USD charge/commission
        // sitting on a USD-currency container.
        const manualReviewRequired = unresolved.filter(
          (r) => r.status === "CLOSED" || r.status === "COMPLETED" || r.status === "OFFLOADED"
        );

        const reconciliation = await getRawMaterialReconciliation(companyId);

        res.json({
          scannedAt: new Date().toISOString(),
          companyId,
          totals: {
            containersScanned,
            chargesScanned,
            commissionsScanned,
            unresolvedCount: unresolved.length,
            manualReviewRequiredCount: manualReviewRequired.length,
          },
          bySupplier: Object.values(bySupplier),
          byCurrency,
          byStatus,
          byContainer: Object.values(byContainer),
          manualReviewRequired,
          rows: unresolved,
          reconciliation,
        });
      } catch (error: unknown) {
        logger.error("Error running factory FX diagnostic:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Safe repair: resolve ONE unresolved row's exchange rate by supplying the real,
  // explicitly-known rate. Admin/Developer-only. Defaults to a dry-run preview (which
  // returns a signed, expiring confirmationToken bound to companyId/source/id/newRate/
  // oldRate/oldConfirmed/versionTag/requesting user); the actual write only happens
  // when the caller re-submits with { confirm: true, confirmationToken } and the token
  // still matches the row's CURRENT state (rejecting a stale token if the row changed
  // since the preview). Never touches CLOSED/COMPLETED/OFFLOADED containers — those
  // come back as MANUAL_REVIEW_REQUIRED. Never overwrites an already-confirmed rate
  // that differs from the requested one — that comes back as ALREADY_CONFIRMED (409).
  // The FX update and its audit-log entry are written atomically in one transaction:
  // if the audit insert fails, the FX update rolls back too.
  app.post(
    "/api/factory/suppliers/fx-diagnostic/repair",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { source, id, fxRateToUsd, confirm, confirmationToken } = req.body || {};
        const parsedId = parseInt(id);
        const parsedRate = parseFloat(fxRateToUsd);

        if (!VALID_SOURCES.includes(source)) {
          return res.status(400).json({ message: `source must be one of: ${VALID_SOURCES.join(", ")}` });
        }
        if (isNaN(parsedId)) return res.status(400).json({ message: "id must be a number" });
        if (!(parsedRate > 0)) return res.status(400).json({ message: "fxRateToUsd must be a positive number" });

        const plan = await planFxResolutionRepair(source, parsedId, companyId, parsedRate);
        if (!plan) return res.status(404).json({ message: `${source} #${parsedId} not found` });

        // Surfaced at preview time too, not just apply — an admin should never even be
        // offered a dry-run token for a correction this endpoint refuses to perform.
        if (plan.alreadyConfirmedDifferentRate) {
          return res.status(409).json({
            code: "ALREADY_CONFIRMED",
            message: `${source} #${parsedId} already has a confirmed rate (${plan.oldFxRateToUsd}) different from the requested rate (${parsedRate}). This repair only resolves a first-time unconfirmed rate.`,
            plan,
          });
        }

        if (!confirm) {
          const tokenPayload: RepairTokenPayload = {
            companyId,
            source,
            id: parsedId,
            newFxRateToUsd: parsedRate,
            oldFxRateToUsd: plan.oldFxRateToUsd,
            oldFxRateConfirmed: plan.oldFxRateConfirmed,
            versionTag: plan.versionTag,
            userId: requireSessionUserId(req),
            expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
          };
          const confirmationToken = signRepairToken(tokenPayload);
          return res.json({ dryRun: true, plan, confirmationToken });
        }

        let tokenPayload: RepairTokenPayload;
        try {
          tokenPayload = verifyRepairToken<RepairTokenPayload>(confirmationToken);
        } catch (err: unknown) {
          if (err instanceof ExpiredRepairTokenError) {
            return res.status(400).json({ code: "TOKEN_EXPIRED", message: err.message });
          }
          return res.status(400).json({
            code: "INVALID_TOKEN",
            message: "confirmationToken does not match this exact repair — re-run the dry-run preview first.",
          });
        }

        // Bind the token to THIS exact request: same company, source, row, requested
        // rate, and requesting user as when it was issued.
        if (
          tokenPayload.companyId !== companyId ||
          tokenPayload.source !== source ||
          tokenPayload.id !== parsedId ||
          Math.abs(tokenPayload.newFxRateToUsd - parsedRate) > 1e-9 ||
          tokenPayload.userId !== req.session.userId
        ) {
          return res.status(400).json({
            code: "INVALID_TOKEN",
            message: "confirmationToken does not match this exact repair request — re-run the dry-run preview first.",
          });
        }

        // Stale-token detection: re-derive the plan fresh from the DB and make sure
        // the row hasn't changed since the token was issued (old rate/confirmed state/
        // version timestamp must still match what the token captured at preview time).
        //
        // Exception: if the row is ALREADY at the exact target state this token asked
        // for (e.g. a previous apply of this same token already succeeded), that is a
        // safe idempotent replay, not staleness — let it fall through to apply, which
        // will correctly return applied:false without writing anything again. A row
        // that someone else confirmed at a DIFFERENT rate is caught separately as
        // ALREADY_CONFIRMED below, before the staleness check ever runs.
        const freshPlan = await planFxResolutionRepair(source, parsedId, companyId, parsedRate);
        if (!freshPlan) return res.status(404).json({ message: `${source} #${parsedId} not found` });
        if (freshPlan.alreadyConfirmedDifferentRate) {
          return res.status(409).json({
            code: "ALREADY_CONFIRMED",
            message: `${source} #${parsedId} already has a confirmed rate (${freshPlan.oldFxRateToUsd}) different from the requested rate (${parsedRate}). This repair only resolves a first-time unconfirmed rate.`,
            plan: freshPlan,
          });
        }
        if (
          !freshPlan.alreadyResolved &&
          (freshPlan.oldFxRateToUsd !== tokenPayload.oldFxRateToUsd ||
            freshPlan.oldFxRateConfirmed !== tokenPayload.oldFxRateConfirmed ||
            freshPlan.versionTag !== tokenPayload.versionTag)
        ) {
          return res.status(400).json({
            code: "STALE_TOKEN",
            message: "This row changed since the dry-run preview was issued — re-run the preview and try again.",
          });
        }

        const result = await applyFxResolutionRepair(source, parsedId, companyId, parsedRate, {
          onAudit: async (tx, applyResult: FxResolutionApplyResult) => {
            await logAudit(
              {
                userId: requireSessionUserId(req),
                username: req.session.username || requireSessionUserId(req),
                companyId,
                action: "update",
                tableName:
                  source === "container"
                    ? "factory_containers"
                    : source === "offload_additional_charge"
                      ? "factory_offload_additional_charges"
                      : "factory_container_commissions",
                recordId: parsedId,
                recordIdentifier: `FX resolution repair — ${source} #${parsedId}`,
                changes: {
                  fxRateToUsd: { old: applyResult.oldFxRateToUsd, new: applyResult.newFxRateToUsd },
                  fxRateConfirmed: { old: applyResult.oldFxRateConfirmed, new: true },
                },
              },
              tx
            );
          },
        });

        res.json({ dryRun: false, result });
      } catch (error: unknown) {
        if (error instanceof ManualReviewRequiredError) {
          return res.status(409).json({ message: error.message, code: "MANUAL_REVIEW_REQUIRED" });
        }
        if (error instanceof AlreadyConfirmedError) {
          return res.status(409).json({ message: error.message, code: "ALREADY_CONFIRMED" });
        }
        if (error instanceof RepairTokenConfigurationError) {
          logger.error("Repair token configuration error (SESSION_SECRET missing/fallback in production):", {
            error: error.message,
          });
          return res.status(500).json({ message: error.message, code: "REPAIR_TOKEN_MISCONFIGURED" });
        }
        logger.error("Error applying FX resolution repair:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
