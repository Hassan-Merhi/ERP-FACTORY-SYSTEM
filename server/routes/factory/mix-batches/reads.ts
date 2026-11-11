/**
 * factoryMixBatchRoutes: FactoryMixBatchRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches } from "@shared/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import {
  getHistoricalMixBatchReconciliation,
  historicalMixAuditCsv,
} from "../../../services/factory/historicalMixBatchReconciliation";
import {
  getPhase4MixProvenanceReport,
  phase4MixProvenanceCsv,
} from "../../../services/factory/mixPhase4ProvenanceAudit";
import {
  getPhase5MixDownstreamReconciliation,
  phase5MixDownstreamCsv,
} from "../../../services/factory/mixPhase5DownstreamAudit";
import { getPhase6MixLifecycleReport, phase6MixLifecycleCsv } from "../../../services/factory/mixPhase6LifecycleAudit";
import { getMixMonitorStatus } from "../../../services/factory/mixPhase7IntegrityMonitor";

export function registerFactoryMixBatchReadRoutes(app: Express) {
  app.get("/api/factory/mix-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Phase 7: lightweight stored monitor status. This GET does not
      // trigger a full scan or write any alert.
      if (req.query.profile === "integrity-monitor") {
        const role = String(req.session.currentRole || req.session.role || "")
          .trim()
          .toLowerCase();
        if (!["admin", "owner", "developer", "dev"].includes(role)) {
          return res.status(403).json({ message: "Factory mix monitoring requires Admin, Owner or Developer access." });
        }
        const report = await getMixMonitorStatus(companyId);
        res.set("Cache-Control", "private, no-store");
        res.set("X-ERP-Payload-Profile", "factory-mix-monitor-status");
        return res.json(report);
      }

      // Phase 6: historical status, used kg and carry-forward integrity.
      if (req.query.profile === "lifecycle-audit") {
        const role = String(req.session.currentRole || req.session.role || "")
          .trim()
          .toLowerCase();
        if (!["admin", "owner", "developer", "dev"].includes(role)) {
          return res
            .status(403)
            .json({ message: "Mix lifecycle reconciliation requires Admin, Owner or Developer access." });
        }
        const report = await getPhase6MixLifecycleReport(companyId);
        res.set("Cache-Control", "private, no-store");
        res.set("X-ERP-Payload-Profile", "factory-mix-lifecycle-audit-read-only");
        if (req.query.format === "csv") {
          res.set("Content-Type", "text/csv; charset=utf-8");
          res.set("Content-Disposition", 'attachment; filename="factory-mix-lifecycle-audit.csv"');
          return res.send(phase6MixLifecycleCsv(report));
        }
        return res.json(report);
      }

      // Phase 5: all-mix downstream production/bale/sales/GL lineage.
      if (req.query.profile === "downstream-audit") {
        const role = String(req.session.currentRole || req.session.role || "")
          .trim()
          .toLowerCase();
        if (!["admin", "owner", "developer", "dev"].includes(role)) {
          return res
            .status(403)
            .json({ message: "Downstream cost reconciliation requires Admin, Owner or Developer access." });
        }
        const report = await getPhase5MixDownstreamReconciliation(companyId);
        res.set("Cache-Control", "private, no-store");
        res.set("X-ERP-Payload-Profile", "factory-mix-downstream-audit-read-only");
        if (req.query.format === "csv") {
          res.set("Content-Type", "text/csv; charset=utf-8");
          res.set("Content-Disposition", 'attachment; filename="factory-mix-downstream-audit.csv"');
          return res.send(phase5MixDownstreamCsv(report));
        }
        return res.json(report);
      }

      // Phase 4 supplier and ADD/raw-stock provenance. Access and exports
      // are privileged and never mutate historical production records.
      if (req.query.profile === "raw-provenance-audit") {
        const role = String(req.session.currentRole || req.session.role || "")
          .trim()
          .toLowerCase();
        if (!["admin", "owner", "developer", "dev"].includes(role)) {
          return res
            .status(403)
            .json({ message: "Raw-stock reconciliation requires Admin, Owner or Developer access." });
        }
        const report = await getPhase4MixProvenanceReport(companyId);
        res.set("Cache-Control", "private, no-store");
        res.set("X-ERP-Payload-Profile", "factory-mix-raw-provenance-read-only");
        if (req.query.format === "csv") {
          const section =
            req.query.section === "ownership" || req.query.section === "adjustments" ? req.query.section : "stock";
          res.set("Content-Type", "text/csv; charset=utf-8");
          res.set("Content-Disposition", `attachment; filename="factory-mix-${section}-audit.csv"`);
          return res.send(phase4MixProvenanceCsv(report, section));
        }
        return res.json(report);
      }

      // Phase 3: a full read-only snapshot of recorded historical values.
      // Reuse this existing authenticated URL (profile switch) to avoid
      // adding an unregistered dynamic route or changing route order.
      if (req.query.profile === "historical-audit") {
        // Deleted mix source rows and complete costing provenance are sensitive.
        const role = String(req.session.currentRole || req.session.role || "")
          .trim()
          .toLowerCase();
        if (!["admin", "owner", "developer", "dev"].includes(role)) {
          return res
            .status(403)
            .json({ message: "Historical reconciliation requires Admin, Owner or Developer access." });
        }
        const report = await getHistoricalMixBatchReconciliation(companyId);
        res.set("Cache-Control", "private, no-store");
        res.set("X-ERP-Payload-Profile", "historical-mix-batch-audit-read-only");
        if (req.query.format === "csv") {
          const level = req.query.level === "sources" ? "sources" : "batches";
          res.set("Content-Type", "text/csv; charset=utf-8");
          res.set("Content-Disposition", 'attachment; filename="factory-mix-historical-' + level + '-audit.csv"');
          return res.send(historicalMixAuditCsv(report, level));
        }
        if (req.query.includeSources === "false") {
          return res.json({
            ...report,
            batches: report.batches.map(({ sources: _sources, ...batch }) => batch),
          });
        }
        return res.json(report);
      }

      const where = and(eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt));

      // Summary/picker consumers only need the batch identity and utilization
      // fields. Skip source-row loading and supplier-rate recomputation entirely.
      if (req.query.profile === "summary") {
        const rows = await db
          .select({
            id: factoryMixBatches.id,
            batchCode: factoryMixBatches.batchCode,
            name: factoryMixBatches.name,
            status: factoryMixBatches.status,
            totalWeightKg: factoryMixBatches.totalWeightKg,
            usedKg: factoryMixBatches.usedKg,
            costPerKg: factoryMixBatches.costPerKg,
            batchDate: factoryMixBatches.batchDate,
            createdAt: factoryMixBatches.createdAt,
          })
          .from(factoryMixBatches)
          .where(where)
          .orderBy(desc(factoryMixBatches.createdAt));

        return res.json(
          rows.map((batch) => ({
            ...batch,
            remainingKg: toMoney(batch.totalWeightKg).minus(toMoney(batch.usedKg)).toFixed(3),
          }))
        );
      }

      const results = await db.select().from(factoryMixBatches).where(where).orderBy(desc(factoryMixBatches.createdAt));

      // Mix-batch list is a historical ledger view. Use the persisted batch
      // valuation exactly as Production Overview does; never re-price old batches
      // from the supplier's current locked rate. Current supplier rates can change
      // after later offloads/corrections and some legacy suppliers have no current
      // stock rate at all, which previously made valid historical batches display
      // as $0.0000/kg here even though their stored batch valuation was correct.
      const enriched = results.map((b) => {
        const total = toMoney(b.totalWeightKg);
        const used = toMoney(b.usedKg);

        return {
          ...b,
          remainingKg: total.minus(used).toFixed(3),
          displayTotalWeightKg: total.toFixed(3),
          displayTotalCost: toMoney(b.totalCost).toFixed(6),
          // Historical USD value / historical batch kg, not today's supplier
          // rate and not rounded per-source rates multiplied back out.
          displayCostPerKg: total.gt(0) ? toMoney(b.totalCost).div(total).toFixed(6) : toMoney(b.costPerKg).toFixed(6),
        };
      });

      res.set("X-ERP-Payload-Profile", "mix-batches-historical-stored-costs");
      res.set("Cache-Control", "private, max-age=10");
      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching mix batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Batch source valuation as historically recorded, scoped to the selected
  // company. Used by the Raw Materials per-supplier daily cost Excel export.
  // One joined query avoids a per-batch request and never reprices inventory.
  app.get("/api/factory/mix-batches/cost-sources", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await pool.query(
        `SELECT s.id,
                s.mix_batch_id AS "mixBatchId",
                COALESCE(sup_direct.id, sup_via_c.id) AS "supplierId",
                COALESCE(NULLIF(sup_direct.name, ''), NULLIF(sup_via_c.name, ''),
                  CASE WHEN s.source_batch_id IS NOT NULL THEN 'Source batch: ' || prior.batch_code END,
                  'Unassigned supplier') AS "supplierName",
                COALESCE(category.name, 'Uncategorized') AS "categoryName",
                c.container_number AS "containerNumber",
                s.source_batch_id AS "sourceBatchId",
                s.weight_kg AS "weightKg",
                s.total_cost AS "totalCost",
                s.cost_per_kg AS "costPerKg"
         FROM factory_mix_batch_sources s
         JOIN factory_mix_batches b ON b.id = s.mix_batch_id
         LEFT JOIN factory_containers c
           ON c.id = s.container_id AND c.company_id = b.company_id
         LEFT JOIN factory_suppliers sup_direct
           ON sup_direct.id = s.supplier_id AND sup_direct.company_id = b.company_id
         LEFT JOIN factory_suppliers sup_via_c
           ON sup_via_c.id = c.supplier_id AND sup_via_c.company_id = b.company_id
         LEFT JOIN factory_mix_batches prior
           ON prior.id = s.source_batch_id AND prior.company_id = b.company_id
         LEFT JOIN factory_supplier_categories category
           ON category.id = COALESCE(sup_direct.supplier_category_id, sup_via_c.supplier_category_id)
          AND category.company_id = b.company_id
         WHERE b.company_id = $1 AND b.deleted_at IS NULL
           AND b.carry_forward_from_id IS NULL
         ORDER BY b.id DESC, s.id`,
        [companyId]
      );
      res.set("Cache-Control", "private, no-store");
      res.json(result.rows);
    } catch (error: unknown) {
      logger.error("Error fetching historical mix batch cost sources:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/mix-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [batch] = await db
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));

      if (!batch) return res.status(404).json({ message: "Mix batch not found" });

      res.set("Cache-Control", "private, max-age=30");
      res.json({ ...batch, remainingKg: toMoney(batch.totalWeightKg).minus(toMoney(batch.usedKg)).toFixed(3) });
    } catch (error: unknown) {
      logger.error("Error fetching mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
