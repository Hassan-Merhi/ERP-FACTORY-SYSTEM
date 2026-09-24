import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  buildPlanAssignmentSummary,
  MAX_BALE_ASSIGNMENT_BATCH,
  normalizeBaleToken,
  parseBaleAssignmentTokens,
  planBaleAssignment,
  selectAutoAssignmentBales,
  type AssignableBale,
  type ContainerAssignmentTarget,
} from "@shared/containerBaleAssignment";
import type { PlannerQueryable } from "./container-planner-source";

type ContainerRow = {
  id: number | string;
  position: number | string;
  name: string;
  capacity_bales: number | string;
  is_locked: boolean;
};

type LineRow = {
  plan_container_id: number | string;
  article_code: string;
  product_name: string | null;
  planned_qty: number | string;
};

type AssignmentRow = {
  id: number | string;
  plan_container_id: number | string;
  bale_id: number | string;
  article_code: string;
  bale_code: string;
  reference_number: string;
  product_name: string;
  weight_kg: string | number;
  assigned_via: string;
  assigned_by_name: string | null;
  created_at: Date | string;
};

function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function writeAssignmentAudit(
  client: PlannerQueryable,
  req: Request,
  companyId: number,
  planId: number,
  planName: string,
  changes: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
     VALUES ($1, $2, $3, 'update', 'factory_container_plan_bales', $4, $5, $6::jsonb, NOW())`,
    [
      req.session.userId || "system",
      req.session.username || "unknown",
      companyId,
      planId,
      planName,
      JSON.stringify(changes),
    ]
  );
}

async function loadPlanHeader(client: PlannerQueryable, companyId: number, planId: number, forUpdate: boolean) {
  const result = await client.query<{ id: number; name: string; status: string; capacity_bales: number }>(
    `SELECT id, name, status, capacity_bales
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

/**
 * Loads containers, planned lines and current bale assignments in one pass so
 * the loading screen and every write path share the same progress model.
 */
export async function loadAssignmentState(client: PlannerQueryable, companyId: number, planId: number) {
  const containerResult = await client.query<ContainerRow>(
    `SELECT id, position, name, capacity_bales, is_locked
     FROM factory_container_plan_containers
     WHERE company_id = $1 AND plan_id = $2
     ORDER BY position, id`,
    [companyId, planId]
  );
  const containerIds = containerResult.rows.map((row) => Number(row.id));

  const lineResult =
    containerIds.length === 0
      ? { rows: [] as LineRow[] }
      : await client.query<LineRow>(
          `SELECT plan_container_id, article_code, product_name, planned_qty
           FROM factory_container_plan_lines
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = ANY($3::int[])`,
          [companyId, planId, containerIds]
        );

  const assignmentResult =
    containerIds.length === 0
      ? { rows: [] as AssignmentRow[] }
      : await client.query<AssignmentRow>(
          `SELECT id, plan_container_id, bale_id, article_code, bale_code, reference_number,
                  product_name, weight_kg, assigned_via, assigned_by_name, created_at
           FROM factory_container_plan_bales
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = ANY($3::int[])
           ORDER BY bale_code, id`,
          [companyId, planId, containerIds]
        );

  const linesByContainer = new Map<number, Array<{ articleCode: string; productName: string; plannedQty: number }>>();
  for (const row of lineResult.rows) {
    const key = Number(row.plan_container_id);
    const list = linesByContainer.get(key) ?? [];
    list.push({
      articleCode: String(row.article_code),
      productName: String(row.product_name || row.article_code),
      plannedQty: Number(row.planned_qty || 0),
    });
    linesByContainer.set(key, list);
  }

  const assignmentsByContainer = new Map<number, AssignmentRow[]>();
  for (const row of assignmentResult.rows) {
    const key = Number(row.plan_container_id);
    const list = assignmentsByContainer.get(key) ?? [];
    list.push(row);
    assignmentsByContainer.set(key, list);
  }

  const containers = containerResult.rows.map((row) => ({
    containerId: Number(row.id),
    containerName: String(row.name),
    position: Number(row.position),
    capacityBales: Number(row.capacity_bales),
    isLocked: Boolean(row.is_locked),
    lines: linesByContainer.get(Number(row.id)) ?? [],
    assignments: (assignmentsByContainer.get(Number(row.id)) ?? []).map((assignment) => ({
      assignmentId: Number(assignment.id),
      baleId: Number(assignment.bale_id),
      articleCode: String(assignment.article_code),
      baleCode: String(assignment.bale_code),
      referenceNumber: String(assignment.reference_number),
      productName: String(assignment.product_name),
      weightKg: Number(assignment.weight_kg || 0),
      assignedVia: String(assignment.assigned_via),
      assignedByName: assignment.assigned_by_name,
      assignedAt: assignment.created_at,
    })),
  }));

  return containers;
}

function buildTarget(container: Awaited<ReturnType<typeof loadAssignmentState>>[number]): ContainerAssignmentTarget {
  const plannedByArticle = new Map<string, number>();
  for (const line of container.lines) {
    plannedByArticle.set(line.articleCode, (plannedByArticle.get(line.articleCode) ?? 0) + Number(line.plannedQty));
  }
  const assignedByArticle = new Map<string, number>();
  for (const assignment of container.assignments) {
    assignedByArticle.set(assignment.articleCode, (assignedByArticle.get(assignment.articleCode) ?? 0) + 1);
  }
  return {
    containerId: container.containerId,
    containerName: container.containerName,
    capacityBales: container.capacityBales,
    isLocked: container.isLocked,
    plannedByArticle,
    assignedByArticle,
  };
}

type BaleLookupRow = {
  id: number | string;
  bale_code: string;
  reference_number: string;
  article_code: string | null;
  product_name: string | null;
  weight_kg: string | number;
  status: string;
  assigned_container_id: number | string | null;
  assigned_container_name: string | null;
};

function toAssignableBale(row: BaleLookupRow): AssignableBale {
  return {
    id: Number(row.id),
    baleCode: String(row.bale_code),
    referenceNumber: String(row.reference_number),
    articleCode: String(row.article_code || ""),
    productName: String(row.product_name || row.article_code || ""),
    weightKg: Number(row.weight_kg || 0),
    status: String(row.status),
    assignedContainerId: row.assigned_container_id == null ? null : Number(row.assigned_container_id),
    assignedContainerName: row.assigned_container_name,
  };
}

async function lookupBales(
  client: PlannerQueryable,
  companyId: number,
  baleIds: number[],
  baleCodes: string[]
): Promise<BaleLookupRow[]> {
  if (baleIds.length === 0 && baleCodes.length === 0) return [];
  const result = await client.query<BaleLookupRow>(
    `SELECT fb.id, fb.bale_code, fb.reference_number, fb.article_code, fb.product_name,
            fb.weight_kg, fb.status,
            cpb.plan_container_id AS assigned_container_id,
            cpc.name AS assigned_container_name
     FROM factory_bales fb
     LEFT JOIN factory_container_plan_bales cpb
       ON cpb.bale_id = fb.id AND cpb.company_id = fb.company_id
     LEFT JOIN factory_container_plan_containers cpc
       ON cpc.id = cpb.plan_container_id
     WHERE fb.company_id = $1
       AND fb.deleted_at IS NULL
       AND (
         fb.id = ANY($2::int[])
         OR UPPER(fb.bale_code) = ANY($3::text[])
         OR UPPER(fb.reference_number) = ANY($3::text[])
       )`,
    [companyId, baleIds, baleCodes]
  );
  return result.rows;
}

export function registerV5ContainerPlanBaleRoutes(app: Express): void {
  // Loading screen: planned vs physically assigned, container by container.
  app.get("/api/factory/v5/container-plans/:planId/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      const client = pool as unknown as PlannerQueryable;
      const header = await loadPlanHeader(client, companyId, planId, false);
      if (!header) return res.status(404).json({ message: "Container plan not found" });

      const containers = await loadAssignmentState(client, companyId, planId);
      const summary = buildPlanAssignmentSummary(containers);

      const unassignedResult = await client.query<{ articleCode: string; productName: string; qty: number }>(
        `SELECT fb.article_code AS "articleCode",
                COALESCE(MAX(fb.product_name), fb.article_code) AS "productName",
                COUNT(*)::int AS qty
         FROM factory_bales fb
         LEFT JOIN factory_container_plan_bales cpb
           ON cpb.bale_id = fb.id AND cpb.company_id = fb.company_id
         WHERE fb.company_id = $1
           AND fb.deleted_at IS NULL
           AND fb.status = 'IN_STOCK'
           AND cpb.id IS NULL
         GROUP BY fb.article_code
         ORDER BY fb.article_code`,
        [companyId]
      );

      return res.json({
        planId,
        planName: header.name,
        checkedAt: new Date().toISOString(),
        summary,
        containers: containers.map((container) => ({
          containerId: container.containerId,
          containerName: container.containerName,
          assignments: container.assignments,
        })),
        unassignedStock: unassignedResult.rows.map((row) => ({
          articleCode: String(row.articleCode),
          productName: String(row.productName || row.articleCode),
          qty: Number(row.qty || 0),
        })),
      });
    } catch (error: unknown) {
      logger.error("[V5] container plan bale summary error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Search-and-select: eligible, still-unreserved bales for one product.
  app.get(
    "/api/factory/v5/container-plans/:planId/bale-candidates",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId) return res.status(400).json({ message: "Invalid plan id" });

        const articleCode = typeof req.query.articleCode === "string" ? req.query.articleCode.trim() : "";
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const compactSearch = normalizeSearchText(search);
        const requestedLimit = Number(req.query.limit);
        const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 100;

        const result = await pool.query(
          `SELECT fb.id, fb.bale_code AS "baleCode", fb.reference_number AS "referenceNumber",
                  fb.article_code AS "articleCode", fb.product_name AS "productName",
                  fb.weight_kg AS "weightKg", fb.status
           FROM factory_bales fb
           LEFT JOIN factory_container_plan_bales cpb
             ON cpb.bale_id = fb.id AND cpb.company_id = fb.company_id
           WHERE fb.company_id = $1
             AND fb.deleted_at IS NULL
             AND fb.status = 'IN_STOCK'
             AND cpb.id IS NULL
             AND ($2 = '' OR fb.article_code = $2)
             AND ($3 = '' OR UPPER(fb.bale_code) LIKE '%' || UPPER($3) || '%'
                          OR UPPER(fb.reference_number) LIKE '%' || UPPER($3) || '%'
                          OR regexp_replace(lower(COALESCE(fb.bale_code, '')), '[^[:alnum:]]+', '', 'g') LIKE '%' || $4 || '%'
                          OR regexp_replace(lower(COALESCE(fb.reference_number, '')), '[^[:alnum:]]+', '', 'g') LIKE '%' || $4 || '%')
           ORDER BY fb.id
           LIMIT $5`,
          [companyId, articleCode, search, compactSearch, limit]
        );

        return res.json({
          planId,
          articleCode: articleCode || null,
          limit,
          candidates: result.rows.map((row) => ({
            id: Number(row.id),
            baleCode: String(row.baleCode),
            referenceNumber: String(row.referenceNumber),
            articleCode: String(row.articleCode || ""),
            productName: String(row.productName || row.articleCode || ""),
            weightKg: Number(row.weightKg || 0),
            status: String(row.status),
          })),
        });
      } catch (error: unknown) {
        logger.error("[V5] container plan bale candidates error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Barcode scan resolution - one code in, a verdict out, no write.
  app.get("/api/factory/v5/container-plans/:planId/bale-scan", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      const code = normalizeBaleToken(req.query.code);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });
      if (!code) return res.status(400).json({ message: "Scan a bale code first" });

      const rows = await lookupBales(pool as unknown as PlannerQueryable, companyId, [], [code]);
      if (rows.length === 0) {
        return res.json({ found: false, code, bale: null });
      }
      return res.json({ found: true, code, bale: toAssignableBale(rows[0]) });
    } catch (error: unknown) {
      logger.error("[V5] container plan bale scan error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Assign scanned / selected bales to one container.
  app.post(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/bales",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });

        const auto = req.body?.auto === true;
        const { baleIds, baleCodes } = parseBaleAssignmentTokens({
          baleIds: req.body?.baleIds,
          baleCodes: req.body?.baleCodes,
        });
        if (!auto && baleIds.length === 0 && baleCodes.length === 0) {
          return res.status(400).json({ message: "Scan or select at least one bale" });
        }
        if (baleIds.length + baleCodes.length > MAX_BALE_ASSIGNMENT_BATCH) {
          return res.status(400).json({ message: `Assign at most ${MAX_BALE_ASSIGNMENT_BATCH} bales in one request` });
        }

        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731205, companyId]);

        const header = await loadPlanHeader(client, companyId, planId, true);
        if (!header) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const containers = await loadAssignmentState(client, companyId, planId);
        const container = containers.find((entry) => entry.containerId === containerId);
        if (!container) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found in this plan" });
        }
        if (container.isLocked) {
          await client.query("ROLLBACK");
          return res
            .status(409)
            .json({ message: "Locked containers cannot take new bales. Unlock the container first." });
        }

        const target = buildTarget(container);
        let requested: Array<{ token: string; bale: AssignableBale | null }>;
        let assignedVia: "MANUAL" | "SCAN" | "AUTO";

        if (auto) {
          const needArticles = Array.from(target.plannedByArticle.keys());
          const candidateResult = await client.query<BaleLookupRow>(
            `SELECT fb.id, fb.bale_code, fb.reference_number, fb.article_code, fb.product_name,
                    fb.weight_kg, fb.status, NULL::int AS assigned_container_id,
                    NULL::text AS assigned_container_name
             FROM factory_bales fb
             LEFT JOIN factory_container_plan_bales cpb
               ON cpb.bale_id = fb.id AND cpb.company_id = fb.company_id
             WHERE fb.company_id = $1
               AND fb.deleted_at IS NULL
               AND fb.status = 'IN_STOCK'
               AND cpb.id IS NULL
               AND fb.article_code = ANY($2::text[])
             ORDER BY fb.id
             LIMIT $3`,
            [companyId, needArticles, MAX_BALE_ASSIGNMENT_BATCH]
          );
          const picked = selectAutoAssignmentBales(target, candidateResult.rows.map(toAssignableBale));
          requested = picked.map((bale) => ({ token: bale.baleCode, bale }));
          assignedVia = "AUTO";
        } else {
          const rows = await lookupBales(client, companyId, baleIds, baleCodes);
          const byId = new Map(rows.map((row) => [Number(row.id), row]));
          const byCode = new Map<string, BaleLookupRow>();
          for (const row of rows) {
            byCode.set(normalizeBaleToken(row.bale_code), row);
            byCode.set(normalizeBaleToken(row.reference_number), row);
          }
          requested = [
            ...baleIds.map((id) => ({
              token: String(id),
              bale: byId.has(id) ? toAssignableBale(byId.get(id)!) : null,
            })),
            ...baleCodes.map((code) => ({
              token: code,
              bale: byCode.has(code) ? toAssignableBale(byCode.get(code)!) : null,
            })),
          ];
          assignedVia = baleCodes.length > 0 && baleIds.length === 0 ? "SCAN" : "MANUAL";
        }

        const decision = planBaleAssignment(target, requested);

        if (decision.accepted.length > 0) {
          // $1/$2 carry the actor for every row; each bale then contributes ten
          // positional parameters after them.
          const values: unknown[] = [req.session.userId || null, req.session.username || null];
          const tuples = decision.accepted.map((bale) => {
            const offset = values.length;
            values.push(
              companyId,
              planId,
              containerId,
              bale.id,
              bale.articleCode,
              bale.baleCode,
              bale.referenceNumber,
              bale.productName,
              bale.weightKg,
              assignedVia
            );
            const placeholders = Array.from({ length: 10 }, (_, index) => `$${offset + index + 1}`).join(", ");
            return `(${placeholders}, $1, $2, NOW(), NOW())`;
          });

          await client.query(
            `INSERT INTO factory_container_plan_bales
               (company_id, plan_id, plan_container_id, bale_id, article_code, bale_code,
                reference_number, product_name, weight_kg, assigned_via, assigned_by, assigned_by_name,
                created_at, updated_at)
             VALUES ${tuples.join(", ")}
             ON CONFLICT (company_id, bale_id) DO NOTHING`,
            values
          );

          await client.query(
            `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
             WHERE id = $1 AND company_id = $2`,
            [planId, companyId]
          );
          await writeAssignmentAudit(client, req, companyId, planId, header.name, {
            assign: {
              containerId,
              assignedVia,
              accepted: decision.accepted.length,
              rejected: decision.rejected.length,
            },
          });
        }

        const after = await loadAssignmentState(client, companyId, planId);
        await client.query("COMMIT");

        return res.json({
          success: true,
          planId,
          containerId,
          assignedVia,
          assigned: decision.accepted.map((bale) => ({
            id: bale.id,
            baleCode: bale.baleCode,
            articleCode: bale.articleCode,
          })),
          rejected: decision.rejected,
          summary: buildPlanAssignmentSummary(after),
        });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan bale assign error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );

  // Release bales from a container back into unassigned stock.
  app.delete(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/bales",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });

        const releaseAll = req.body?.all === true;
        const { baleIds, baleCodes } = parseBaleAssignmentTokens({
          baleIds: req.body?.baleIds,
          baleCodes: req.body?.baleCodes,
        });
        if (!releaseAll && baleIds.length === 0 && baleCodes.length === 0) {
          return res.status(400).json({ message: "Select at least one bale to release" });
        }

        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731205, companyId]);

        const header = await loadPlanHeader(client, companyId, planId, true);
        if (!header) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const containerResult = await client.query<{ id: number; name: string; is_locked: boolean }>(
          `SELECT id, name, is_locked
           FROM factory_container_plan_containers
           WHERE id = $1 AND plan_id = $2 AND company_id = $3
           FOR UPDATE`,
          [containerId, planId, companyId]
        );
        const container = containerResult.rows[0];
        if (!container) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found in this plan" });
        }
        if (container.is_locked) {
          await client.query("ROLLBACK");
          return res
            .status(409)
            .json({ message: "Locked containers cannot release bales. Unlock the container first." });
        }

        const deleted = await client.query<{ id: number }>(
          `DELETE FROM factory_container_plan_bales
           WHERE company_id = $1
             AND plan_id = $2
             AND plan_container_id = $3
             AND ($4::boolean
                  OR bale_id = ANY($5::int[])
                  OR UPPER(bale_code) = ANY($6::text[])
                  OR UPPER(reference_number) = ANY($6::text[]))
           RETURNING id`,
          [companyId, planId, containerId, releaseAll, baleIds, baleCodes]
        );

        if (deleted.rows.length > 0) {
          await client.query(
            `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
             WHERE id = $1 AND company_id = $2`,
            [planId, companyId]
          );
          await writeAssignmentAudit(client, req, companyId, planId, header.name, {
            release: { containerId, released: deleted.rows.length, all: releaseAll },
          });
        }

        const after = await loadAssignmentState(client, companyId, planId);
        await client.query("COMMIT");

        return res.json({
          success: true,
          planId,
          containerId,
          released: deleted.rows.length,
          summary: buildPlanAssignmentSummary(after),
        });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan bale release error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );
}
