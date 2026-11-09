/**
 * Phase 5: reserve article quantities and exact loaded bale references for
 * one truck trip. These are only dispatch planning records (Option A).
 *
 * The loading's Priority Scan config is order-wide; article display order
 * follows its linked proforma (then loading lines), never a fabricated
 * per-article Priority Scan rank.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";

const access = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");
const MAX_LINES = 2000;
const MAX_BALES = 10000;
const MAX_RESERVE = 10000;
type Raw = Record<string, unknown>;
function rows(value: unknown): Raw[] { return resultRows(value); }
function str(value: unknown): string { return value == null ? "" : String(value); }
function num(value: unknown): number { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; }
function code(value: unknown): string { return str(value).trim().toUpperCase(); }
function supervisor(role: string): boolean { return ["admin", "owner", "developer"].includes(role.trim().toLowerCase()); }
function validId(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }

class PlanningError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, errorCode: string, message: string): never { throw new PlanningError(status, errorCode, message); }
type Loaded = { baleId: number; baleReference: string; articleCode: string; productName: string; weightKg: number; orderIndex: number };
type PlanLine = { articleCode: string; expectedQty: number };
type Plan = { lines: PlanLine[]; baleIds: number[]; autoAssignBales: boolean };
type Source = {
  trip: Raw;
  order: Raw;
  loaded: Loaded[];
  priority: Raw | null;
  existingArticles: Raw[];
  existingBales: Raw[];
  scans: Raw[];
  queueRanks: Map<string, number>;
};

function parsePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "INVALID_PLAN", "Provide a valid truck plan");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((k) => !["lines", "baleIds", "autoAssignBales"].includes(k))) {
    fail(400, "INVALID_PLAN", "Only lines, baleIds and autoAssignBales may be submitted");
  }
  if (!Array.isArray(input.lines) || input.lines.length > MAX_LINES) fail(400, "INVALID_LINES", "Provide at most 2,000 article target lines");
  const seen = new Set<string>();
  const lines: PlanLine[] = [];
  for (const rawLine of input.lines) {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) fail(400, "INVALID_LINES", "Invalid article target");
    const line = rawLine as Record<string, unknown>;
    if (Object.keys(line).some((k) => !["articleCode", "expectedQty"].includes(k))) {
      fail(400, "INVALID_LINES", "Only articleCode and expectedQty are allowed in target lines");
    }
    const articleCode = code(line.articleCode);
    const expectedQty = line.expectedQty;
    if (!articleCode || articleCode.length > 50 || seen.has(articleCode) ||
        typeof expectedQty !== "number" || !Number.isSafeInteger(expectedQty) ||
        expectedQty < 0 || expectedQty > MAX_RESERVE) {
      fail(400, "INVALID_LINES", "Article targets must use unique codes and whole nonnegative quantities");
    }
    seen.add(articleCode);
    if (expectedQty > 0) lines.push({ articleCode, expectedQty });
  }
  const ids = input.baleIds === undefined ? [] : input.baleIds;
  if (!Array.isArray(ids) || ids.length > MAX_BALES ||
      ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    fail(400, "INVALID_BALES", "Provide unique positive bale IDs (maximum 10,000)");
  }
  if (input.autoAssignBales !== undefined && typeof input.autoAssignBales !== "boolean") {
    fail(400, "INVALID_AUTO", "autoAssignBales must be true or false");
  }
  return { lines, baleIds: ids as number[], autoAssignBales: input.autoAssignBales === true };
}

async function readSource(tx: DbTransaction, companyId: number, orderId: number, dispatchId: number, lock: boolean): Promise<Source> {
  const orderRows = rows(await tx.execute(lock ? sql`
    SELECT id, status, deleted_at AS "deletedAt", proforma_id_used AS "proformaIdUsed",
           container_number AS "containerNumber"
      FROM customer_orders WHERE id = ${orderId} AND company_id = ${companyId} FOR UPDATE
  ` : sql`
    SELECT id, status, deleted_at AS "deletedAt", proforma_id_used AS "proformaIdUsed",
           container_number AS "containerNumber"
      FROM customer_orders WHERE id = ${orderId} AND company_id = ${companyId}
  `));
  const order = orderRows[0];
  if (!order) fail(404, "LOADING_NOT_FOUND", "Loading not found in the active company");
  const tripRows = rows(await tx.execute(lock ? sql`
    SELECT id, status, dispatch_number AS "dispatchNumber",
           truck_plate AS "truckPlate" FROM factory_loading_dispatches
     WHERE company_id = ${companyId} AND order_id = ${orderId} AND id = ${dispatchId} FOR UPDATE
  ` : sql`
    SELECT id, status, dispatch_number AS "dispatchNumber",
           truck_plate AS "truckPlate" FROM factory_loading_dispatches
     WHERE company_id = ${companyId} AND order_id = ${orderId} AND id = ${dispatchId}
  `));
  const trip = tripRows[0];
  if (!trip) fail(404, "DISPATCH_NOT_FOUND", "Truck dispatch not found for this loading");

  const loadedRaw = rows(await tx.execute(sql`
    SELECT DISTINCT ON (cob.bale_id)
           cob.bale_id AS "baleId", cob.bale_reference AS "baleReference",
           cob.article_code AS "articleCode", cob.bale_name AS "productName",
           cob.weight AS "weightKg", cob.id AS "orderIndex"
      FROM customer_order_bales cob WHERE cob.order_id = ${orderId}
     ORDER BY cob.bale_id, cob.id DESC
  `));
  const loaded: Loaded[] = loadedRaw.map((r) => ({
    baleId: num(r.baleId), baleReference: str(r.baleReference),
    articleCode: code(r.articleCode), productName: str(r.productName),
    weightKg: num(r.weightKg), orderIndex: num(r.orderIndex),
  })).sort((a, b) => a.orderIndex - b.orderIndex);

  const priority = rows(await tx.execute(sql`
    SELECT priority, color, enabled, updated_at AS "updatedAt"
      FROM customer_order_priority_scan_configs
     WHERE company_id = ${companyId} AND order_id = ${orderId} LIMIT 1
  `))[0] ?? null;
  const proformaId = order.proformaIdUsed == null ? null : num(order.proformaIdUsed);
  const rankRows = proformaId ? rows(await tx.execute(sql`
    SELECT UPPER(TRIM(pl.article_code)) AS "articleCode", MIN(pl.id) AS "sortId"
      FROM customer_proforma_lines pl
      JOIN customer_proformas p ON p.id = pl.proforma_id AND p.company_id = ${companyId}
     WHERE pl.proforma_id = ${proformaId}
     GROUP BY UPPER(TRIM(pl.article_code)) ORDER BY "sortId"
  `)) : [];
  const fallbackRanks = rows(await tx.execute(sql`
    SELECT UPPER(TRIM(article_code)) AS "articleCode", MIN(id) AS "sortId"
      FROM customer_order_lines WHERE order_id = ${orderId}
     GROUP BY UPPER(TRIM(article_code)) ORDER BY "sortId"
  `));
  const queueRanks = new Map<string, number>();
  for (const line of [...rankRows, ...fallbackRanks]) {
    const normalized = code(line.articleCode);
    if (normalized && !queueRanks.has(normalized)) queueRanks.set(normalized, queueRanks.size + 1);
  }

  const existingArticles = rows(await tx.execute(sql`
    SELECT a.id, a.dispatch_id AS "dispatchId", d.dispatch_number AS "dispatchNumber",
           a.article_code AS "articleCode", a.product_name AS "productName",
           a.expected_qty AS "expectedQty", a.priority_rank AS "priorityRank"
      FROM factory_loading_dispatch_expected_articles a
      JOIN factory_loading_dispatches d ON d.id = a.dispatch_id AND d.company_id = a.company_id AND d.order_id = a.order_id
     WHERE a.company_id = ${companyId} AND a.order_id = ${orderId}
     ORDER BY a.id
  `));
  const existingBales = rows(await tx.execute(sql`
    SELECT e.id, e.bale_id AS "baleId", e.dispatch_id AS "dispatchId",
           d.dispatch_number AS "dispatchNumber", e.source
      FROM factory_loading_dispatch_expected_bales e
      JOIN factory_loading_dispatches d ON d.id = e.dispatch_id AND d.company_id = e.company_id AND d.order_id = e.order_id
     WHERE e.company_id = ${companyId} AND e.order_id = ${orderId}
       AND e.removed_at IS NULL
     ORDER BY e.id
  `));
  const scans = rows(await tx.execute(sql`
    SELECT s.bale_id AS "baleId", s.dispatch_id AS "dispatchId",
           d.dispatch_number AS "dispatchNumber", s.article_code AS "articleCode"
      FROM factory_loading_dispatch_scans s
      JOIN factory_loading_dispatches d ON d.id = s.dispatch_id AND d.company_id = s.company_id AND d.order_id = s.order_id
     WHERE s.company_id = ${companyId} AND s.order_id = ${orderId}
       AND s.removed_at IS NULL
  `));
  return { trip, order, loaded, priority, queueRanks, existingArticles, existingBales, scans };
}

function buildOverview(s: Source, dispatchId: number, orderId: number) {
  const id = String(dispatchId);
  const baleMap = new Map(s.loaded.map((b) => [b.baleId, b]));
  const owned = s.existingBales.filter((e) => str(e.dispatchId) === id);
  const targetRows = s.existingArticles.filter((e) => str(e.dispatchId) === id);
  const ownedIds = new Set(owned.map((e) => num(e.baleId)));
  const scannedByOther = new Map(s.scans.filter((e) => str(e.dispatchId) !== id).map((e) => [num(e.baleId), e]));
  const otherExact = new Map(s.existingBales.filter((e) => str(e.dispatchId) !== id).map((e) => [num(e.baleId), e]));
  const scannedBySelf = new Set(s.scans.filter((e) => str(e.dispatchId) === id).map((e) => num(e.baleId)));
  const articles = new Map<string, { articleCode: string; productName: string; loadedQty: number; loadedWeightKg: number;
    reservedOtherQty: number; reservedHereQty: number; scannedHereQty: number; availableQty: number;
    expectedQty: number; priorityRank: number }>();
  for (const b of s.loaded) {
    const a = articles.get(b.articleCode) ?? { articleCode: b.articleCode, productName: b.productName,
      loadedQty: 0, loadedWeightKg: 0, reservedOtherQty: 0, reservedHereQty: 0,
      scannedHereQty: 0, availableQty: 0, expectedQty: 0,
      priorityRank: s.queueRanks.get(b.articleCode) ?? 999999 };
    a.loadedQty++;
    a.loadedWeightKg += b.weightKg;
    if (ownedIds.has(b.baleId)) a.reservedHereQty++;
    if (scannedBySelf.has(b.baleId)) a.scannedHereQty++;
    articles.set(b.articleCode, a);
  }
  for (const plan of targetRows) {
    const key = code(plan.articleCode);
    const a = articles.get(key);
    if (a) a.expectedQty = num(plan.expectedQty);
  }
  // Other-trip consumption is the greater of the explicit article target,
  // exact reservations, and physical scans on each trip (never their sum).
  const otherByTrip = new Map<string, Map<string, { planned: number; exact: Set<number>; scanned: Set<number> }>>();
  const accumulate = (trip: string, article: string) => {
    let t = otherByTrip.get(trip);
    if (!t) { t = new Map(); otherByTrip.set(trip, t); }
    let a = t.get(article);
    if (!a) { a = { planned: 0, exact: new Set(), scanned: new Set() }; t.set(article, a); }
    return a;
  };
  for (const p of s.existingArticles) if (str(p.dispatchId) !== id) {
    accumulate(str(p.dispatchId), code(p.articleCode)).planned += num(p.expectedQty);
  }
  for (const p of s.existingBales) if (str(p.dispatchId) !== id) {
    const bale = baleMap.get(num(p.baleId));
    if (bale) accumulate(str(p.dispatchId), bale.articleCode).exact.add(bale.baleId);
  }
  for (const p of s.scans) if (str(p.dispatchId) !== id) {
    const bale = baleMap.get(num(p.baleId));
    if (bale) accumulate(str(p.dispatchId), bale.articleCode).scanned.add(bale.baleId);
  }
  for (const trip of otherByTrip.values()) for (const [article, r] of trip) {
    const a = articles.get(article);
    if (a) a.reservedOtherQty += Math.max(r.planned, new Set([...r.exact, ...r.scanned]).size);
  }
  const list = [...articles.values()].map((a) => ({
    ...a,
    availableQty: Math.max(0, a.loadedQty - a.reservedOtherQty),
    loadedWeightKg: Math.round(a.loadedWeightKg * 1000) / 1000,
  })).sort((a, b) => a.priorityRank - b.priorityRank || a.articleCode.localeCompare(b.articleCode));
  const candidates = s.loaded.map((b) => {
    const elsewhere = otherExact.get(b.baleId) ?? scannedByOther.get(b.baleId);
    return { ...b, assignedHere: ownedIds.has(b.baleId), scannedHere: scannedBySelf.has(b.baleId),
      assignedElsewhere: elsewhere ? { dispatchId: str(elsewhere.dispatchId), dispatchNumber: num(elsewhere.dispatchNumber) } : null,
    };
  }).sort((a, b) => (s.queueRanks.get(a.articleCode) ?? 999999) - (s.queueRanks.get(b.articleCode) ?? 999999) ||
    a.orderIndex - b.orderIndex);
  return {
    orderId, dispatchId, status: s.trip.status,
    priority: s.priority ? {
      orderPriority: num(s.priority.priority), color: str(s.priority.color), enabled: s.priority.enabled === true,
      source: "loading_priority_scan_queue",
    } : null,
    articleOrdering: "linked_proforma_then_loading_lines",
    articles: list, candidates,
    expectedArticles: targetRows.map((r) => ({
      articleCode: code(r.articleCode), expectedQty: num(r.expectedQty),
      priorityRank: r.priorityRank == null ? null : num(r.priorityRank),
    })),
    expectedBales: owned.map((r) => ({
      baleId: num(r.baleId), ...(() => {
        const b = baleMap.get(num(r.baleId)); return b ? { baleReference: b.baleReference, articleCode: b.articleCode } : { baleReference: "", articleCode: "" };
      })(),
    })),
    otherTrips: [...otherByTrip].map(([trip, map]) => ({
      dispatchId: trip,
      reservedArticles: [...map].map(([articleCode, v]) => ({
        articleCode, reservedQty: Math.max(v.planned, new Set([...v.exact, ...v.scanned]).size),
      })),
    })),
  };
}

export function registerFactoryLoadingDispatchAllocationRoutes(app: Express) {
  app.get("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/allocations", requireAuth, access,
    async (req: Request, res: Response) => {
      const state = await getFactoryAccessState(req);
      const orderId = parseId(req.params.id), dispatchId = parseId(req.params.dispatchId);
      if (!state) return res.status(403).json({ message: "Factory access unavailable" });
      if (orderId === null || dispatchId === null) return res.status(400).json({ message: "Invalid loading/dispatch ID" });
      try {
        const data = await db.transaction(async (tx) => {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          return buildOverview(await readSource(tx, state.companyId, orderId, dispatchId, false), dispatchId, orderId);
        });
        res.set("Cache-Control", "private, no-store");
        return res.json(data);
      } catch (error) {
        if (error instanceof PlanningError) return res.status(error.status).json({ code: error.code, message: error.message });
        logger.error("Failed to load dispatch allocation", { error });
        return res.status(500).json({ message: "Could not load truck allocations" });
      }
    });

  app.put("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/allocations", requireAuth, access,
    async (req: Request, res: Response) => {
      const state = await getFactoryAccessState(req);
      const orderId = parseId(req.params.id), dispatchId = parseId(req.params.dispatchId);
      if (!state) return res.status(403).json({ message: "Factory access unavailable" });
      if (!supervisor(state.role)) return res.status(403).json({ message: "Only Admin, Owner or Developer may assign truck loads" });
      if (orderId === null || dispatchId === null) return res.status(400).json({ message: "Invalid loading/dispatch ID" });
      try {
        const plan = parsePlan(req.body);
        const result = await db.transaction(async (tx) => {
          // All dispatch allocation writers must lock their shared customer
          // order first, then the trip: prevents concurrent capacity oversell.
          const s = await readSource(tx, state.companyId, orderId, dispatchId, true);
          if (s.order.deletedAt || s.order.status === "CANCELLED")
            fail(409, "LOADING_INACTIVE", "Cannot allocate a deleted or cancelled loading");
          if (s.trip.status !== "OPEN") fail(409, "DISPATCH_NOT_OPEN", "Only open truck trips can be allocated");
          const overview = buildOverview(s, dispatchId, orderId);
          const loadedById = new Map(s.loaded.map((b) => [b.baleId, b]));
          const requested = new Map(plan.lines.map((line) => [line.articleCode, line.expectedQty]));
          const otherOccupied = new Map(overview.candidates.filter((b) => b.assignedElsewhere)
            .map((b) => [b.baleId, b.assignedElsewhere]));
          for (const line of plan.lines) {
            const available = overview.articles.find((row) => row.articleCode === line.articleCode);
            if (!available) fail(409, "ARTICLE_NOT_LOADED", "Article " + line.articleCode + " has no bales in this loading");
            if (line.expectedQty > available.availableQty) {
              fail(409, "ARTICLE_OVERALLOCATED", "Article " + line.articleCode +
                " has only " + available.availableQty + " bales available after other trucks' reservations and scans");
            }
          }

          const chosen = new Set<number>(plan.baleIds);
          for (const baleId of chosen) {
            const bale = loadedById.get(baleId);
            if (!bale) fail(409, "BALE_NOT_LOADED", "Bale #" + baleId + " is not currently in this loading");
            const conflict = otherOccupied.get(baleId);
            if (conflict) fail(409, "BALE_ALREADY_ASSIGNED", "Bale " + bale.baleReference + " belongs to Dispatch #" + conflict?.dispatchNumber);
            if (!requested.has(bale.articleCode)) fail(409, "BALE_WITHOUT_TARGET",
              "Add a quantity target for article " + bale.articleCode + " before selecting its bale");
          }
          // Active scans are physical facts, never discarded by plan editing.
          const selfScans = s.scans.filter((r) => str(r.dispatchId) === String(dispatchId));
          for (const scan of selfScans) {
            const b = loadedById.get(num(scan.baleId));
            if (!b) fail(409, "LOADING_CHANGED", "A scanned bale was removed from the loading. Correct the scan before planning.");
            if ((requested.get(b.articleCode) ?? 0) === 0) fail(409, "TARGET_BELOW_SCANS",
              "Keep a target for " + b.articleCode + "; this truck already has verified bales");
            chosen.add(b.baleId);
          }

          const countSelected = () => {
            const m = new Map<string, number>();
            for (const id of chosen) {
              const article = loadedById.get(id)!.articleCode;
              m.set(article, (m.get(article) ?? 0) + 1);
            }
            return m;
          };
          let counts = countSelected();
          for (const [article, count] of counts) if (count > (requested.get(article) ?? 0))
            fail(409, "TARGET_BELOW_SELECTED", "Article " + article + " has " + count + " selected/scanned bale references, above the target");

          if (plan.autoAssignBales) {
            for (const line of plan.lines) {
              let needed = line.expectedQty - (counts.get(line.articleCode) ?? 0);
              for (const candidate of overview.candidates) {
                if (needed <= 0) break;
                if (candidate.articleCode !== line.articleCode || chosen.has(candidate.baleId) ||
                    candidate.assignedElsewhere) continue;
                chosen.add(candidate.baleId);
                needed--;
              }
              if (needed > 0) fail(409, "EXACT_BALES_UNAVAILABLE",
                "Not enough free exact bale references for " + line.articleCode +
                ". Reduce the target, or save article targets without auto-assignment.");
            }
            counts = countSelected();
          }

          const actor = String(state.userId);
          const actorName = String(req.session.username || actor);
          const previousIds = s.existingBales.filter((b) => str(b.dispatchId) === String(dispatchId)).map((b) => num(b.baleId));
          const kept = new Set(previousIds);
          const removed = previousIds.filter((id) => !chosen.has(id));
          const added = [...chosen].filter((id) => !kept.has(id));
          for (const id of removed) {
            await tx.execute(sql`
              UPDATE factory_loading_dispatch_expected_bales
                 SET removed_at = NOW(), removed_by_user_id = ${actor},
                     removal_reason = 'TRIP_PLAN_REPLACED'
               WHERE company_id = ${state.companyId} AND order_id = ${orderId}
                 AND dispatch_id = ${dispatchId} AND bale_id = ${id}
                 AND removed_at IS NULL
            `);
          }
          // Individual values are bound through Drizzle. The parent row lock
          // serializes assignment updates for all trucks of this loading.
          for (const id of added) {
            await tx.execute(sql`
              INSERT INTO factory_loading_dispatch_expected_bales
                (company_id, order_id, dispatch_id, bale_id, source, assigned_by_user_id)
              VALUES (${state.companyId}, ${orderId}, ${dispatchId}, ${id},
                      ${plan.autoAssignBales ? "PRIORITY" : "MANUAL"}, ${actor})
            `);
          }
          await tx.execute(sql`
            DELETE FROM factory_loading_dispatch_expected_articles
             WHERE company_id = ${state.companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId}
          `);
          for (const line of plan.lines) {
            const entry = overview.articles.find((a) => a.articleCode === line.articleCode)!;
            await tx.execute(sql`
              INSERT INTO factory_loading_dispatch_expected_articles
                (company_id, order_id, dispatch_id, article_code,
                 product_name, expected_qty, priority_rank, source, assigned_by_user_id)
              VALUES (${state.companyId}, ${orderId}, ${dispatchId}, ${line.articleCode},
                      ${entry.productName}, ${line.expectedQty},
                      ${entry.priorityRank === 999999 ? null : entry.priorityRank},
                      ${plan.autoAssignBales ? "PRIORITY" : "MANUAL"}, ${actor})
            `);
          }
          await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_events
              (company_id, order_id, dispatch_id, event_type, actor_user_id, actor_username, event_data)
            VALUES (${state.companyId}, ${orderId}, ${dispatchId},
                    'TRIP_ALLOCATION_UPDATED', ${actor}, ${actorName},
                    ${JSON.stringify({
                      lines: plan.lines, exactBales: [...chosen], addedBales: added,
                      removedBales: removed, autoAssignBales: plan.autoAssignBales,
                      loadingPriority: s.priority?.priority ?? null,
                    })}::jsonb)
          `);
          return buildOverview(await readSource(tx, state.companyId, orderId, dispatchId, false), dispatchId, orderId);
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof PlanningError) return res.status(error.status).json({ code: error.code, message: error.message });
        logger.error("Failed to update dispatch allocation", { error });
        return res.status(500).json({ message: "Could not save truck allocation" });
      }
    });
}
