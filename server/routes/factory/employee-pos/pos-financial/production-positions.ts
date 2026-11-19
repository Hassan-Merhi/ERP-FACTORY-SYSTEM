import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import {
  factoryProductionPositions,
  factoryProductionPositionRules,
  factoryProductionPositionMemberships,
  factoryWorkers,
} from "@shared/schema";
import { checkFactoryAdmin } from "../../_helpers";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  type RequestSchemas,
} from "../../../../lib/validateRequest";
import {
  DATE_RE,
  getPositionState,
  replaceMemberships,
  type ProductionPositionRuleValues,
} from "./production-positions-helpers";

const todayIso = () => new Date().toISOString().slice(0, 10);
const actor = (req: import("express").Request) =>
  String(req.session?.userId ?? req.session?.username ?? "unknown").slice(0, 100);
const companyIdFor = (req: import("express").Request) => req.session?.factoryCompanyId || req.session?.currentCompanyId;

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  targetBales: z.coerce.number().int().min(0).max(100000),
  bonusPerExtraBale: z.coerce.number().min(0).max(1000000),
  bonusEnabled: z.boolean().default(false),
  active: z.boolean().default(true),
  workerIds: z.array(z.coerce.number().int().positive()).default([]),
  effectiveFrom: z.string().regex(DATE_RE).optional(),
});

const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, "No changes supplied");

// Request shapes for validateRequest. They only check the fields' types: the
// handlers still parse with createSchema/updateSchema above, which coerce the
// numbers, apply the defaults and answer their own 400s.
const looseNumber = z.union([z.number(), z.string()]);
const positionFields = {
  name: z.string(),
  targetBales: looseNumber,
  bonusPerExtraBale: looseNumber,
  bonusEnabled: z.boolean().optional(),
  active: z.boolean().optional(),
  workerIds: z.array(looseNumber).optional(),
  effectiveFrom: z.string().optional(),
};
const positionParams = z.strictObject({ id: stringParam });
const createPositionInput = { query: emptyQuery, body: z.strictObject(positionFields) } satisfies RequestSchemas;
const updatePositionInput = {
  params: positionParams,
  query: emptyQuery,
  body: z.strictObject(positionFields).partial(),
} satisfies RequestSchemas;
const archivePositionInput = { params: positionParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

async function validateWorkers(companyId: number, ids: number[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const workers = await db
    .select({ id: factoryWorkers.id })
    .from(factoryWorkers)
    .where(
      and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true), inArray(factoryWorkers.id, unique))
    );
  if (workers.length !== unique.length)
    throw new Error("One or more selected workers are inactive or belong to another company");
  return unique;
}

async function writeRuleVersion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  positionId: number,
  effectiveFrom: string,
  values: ProductionPositionRuleValues,
  createdBy: string
) {
  const [current] = await tx
    .select()
    .from(factoryProductionPositionRules)
    .where(
      and(
        eq(factoryProductionPositionRules.companyId, companyId),
        eq(factoryProductionPositionRules.positionId, positionId),
        isNull(factoryProductionPositionRules.effectiveTo)
      )
    )
    .orderBy(desc(factoryProductionPositionRules.effectiveFrom))
    .limit(1);

  if (current && effectiveFrom < current.effectiveFrom) {
    throw new Error(`Effective date cannot be before the current rule start (${current.effectiveFrom})`);
  }
  if (current && effectiveFrom === current.effectiveFrom) {
    await tx
      .update(factoryProductionPositionRules)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(factoryProductionPositionRules.id, current.id));
    return;
  }
  if (current) {
    await tx
      .update(factoryProductionPositionRules)
      .set({ effectiveTo: effectiveFrom, updatedAt: new Date() })
      .where(eq(factoryProductionPositionRules.id, current.id));
  }
  await tx.insert(factoryProductionPositionRules).values({
    companyId,
    positionId,
    effectiveFrom,
    effectiveTo: null,
    ...values,
    createdBy,
  });
}

export function registerProductionPositionRoutes(app: Express) {
  app.get("/api/factory/production-positions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const asOf = typeof req.query.asOf === "string" && DATE_RE.test(req.query.asOf) ? req.query.asOf : todayIso();
      const positions = await db
        .select({ id: factoryProductionPositions.id })
        .from(factoryProductionPositions)
        .where(eq(factoryProductionPositions.companyId, companyId))
        .orderBy(asc(factoryProductionPositions.name));
      const result = await Promise.all(positions.map((p) => getPositionState(companyId, p.id, asOf)));
      res.json(result.filter(Boolean));
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.get("/api/factory/production-positions/:id/history", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const positionId = Number(req.params.id);
      if (!companyId || !Number.isInteger(positionId)) return res.status(400).json({ message: "Invalid request" });
      const [position] = await db
        .select()
        .from(factoryProductionPositions)
        .where(and(eq(factoryProductionPositions.companyId, companyId), eq(factoryProductionPositions.id, positionId)))
        .limit(1);
      if (!position) return res.status(404).json({ message: "Production position not found" });
      const rules = await db
        .select()
        .from(factoryProductionPositionRules)
        .where(
          and(
            eq(factoryProductionPositionRules.companyId, companyId),
            eq(factoryProductionPositionRules.positionId, positionId)
          )
        )
        .orderBy(desc(factoryProductionPositionRules.effectiveFrom));
      const memberships = await db
        .select({
          id: factoryProductionPositionMemberships.id,
          workerId: factoryProductionPositionMemberships.workerId,
          fullName: factoryWorkers.fullName,
          employeeCode: factoryWorkers.employeeCode,
          effectiveFrom: factoryProductionPositionMemberships.effectiveFrom,
          effectiveTo: factoryProductionPositionMemberships.effectiveTo,
        })
        .from(factoryProductionPositionMemberships)
        .innerJoin(factoryWorkers, eq(factoryWorkers.id, factoryProductionPositionMemberships.workerId))
        .where(
          and(
            eq(factoryProductionPositionMemberships.companyId, companyId),
            eq(factoryProductionPositionMemberships.positionId, positionId)
          )
        )
        .orderBy(desc(factoryProductionPositionMemberships.effectiveFrom), asc(factoryWorkers.fullName));
      res.json({ position, rules, memberships });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post(
    "/api/factory/production-positions",
    requireAuth,
    validateRequest(createPositionInput),
    async (req: Request, res: Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = companyIdFor(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const body = createSchema.parse(req.body);
        const workerIds = await validateWorkers(companyId, body.workerIds);
        const effectiveFrom = body.effectiveFrom || todayIso();
        const createdBy = actor(req);
        const positionId = await db.transaction(async (tx) => {
          const [position] = await tx
            .insert(factoryProductionPositions)
            .values({ companyId, name: body.name, active: body.active, createdBy })
            .returning({ id: factoryProductionPositions.id });
          await writeRuleVersion(
            tx,
            companyId,
            position.id,
            effectiveFrom,
            {
              targetBales: body.targetBales,
              bonusPerExtraBale: String(body.bonusPerExtraBale),
              bonusEnabled: body.bonusEnabled,
            },
            createdBy
          );
          if (body.active) await replaceMemberships(tx, companyId, position.id, effectiveFrom, workerIds, createdBy);
          return position.id;
        });
        res.status(201).json(await getPositionState(companyId, positionId, effectiveFrom));
      } catch (e: unknown) {
        res.status(400).json({ message: getErrorMessage(e) });
      }
    }
  );

  app.patch(
    "/api/factory/production-positions/:id",
    requireAuth,
    validateRequest(updatePositionInput),
    async (req: Request, res: Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = companyIdFor(req);
        const positionId = Number(req.params.id);
        if (!companyId || !Number.isInteger(positionId)) return res.status(400).json({ message: "Invalid request" });
        const body = updateSchema.parse(req.body);
        const effectiveFrom = body.effectiveFrom || todayIso();
        const current = await getPositionState(companyId, positionId, effectiveFrom);
        if (!current) return res.status(404).json({ message: "Production position not found" });
        const workerIds =
          body.workerIds === undefined ? current.workerIds : await validateWorkers(companyId, body.workerIds);
        const targetBales = body.targetBales ?? current.targetBales;
        const bonusPerExtraBale = body.bonusPerExtraBale ?? Number(current.bonusPerExtraBale || 0);
        const bonusEnabled = body.bonusEnabled ?? current.bonusEnabled;
        const active = body.active ?? current.active;
        const createdBy = actor(req);
        await db.transaction(async (tx) => {
          await tx
            .update(factoryProductionPositions)
            .set({ name: body.name ?? current.name, active, updatedAt: new Date() })
            .where(
              and(eq(factoryProductionPositions.id, positionId), eq(factoryProductionPositions.companyId, companyId))
            );
          const ruleChanged =
            targetBales !== current.targetBales ||
            Number(bonusPerExtraBale) !== Number(current.bonusPerExtraBale || 0) ||
            bonusEnabled !== current.bonusEnabled;
          if (ruleChanged || !current.ruleEffectiveFrom) {
            await writeRuleVersion(
              tx,
              companyId,
              positionId,
              effectiveFrom,
              {
                targetBales,
                bonusPerExtraBale: String(bonusPerExtraBale),
                bonusEnabled,
              },
              createdBy
            );
          }
          await replaceMemberships(tx, companyId, positionId, effectiveFrom, active ? workerIds : [], createdBy);
        });
        res.json(await getPositionState(companyId, positionId, effectiveFrom));
      } catch (e: unknown) {
        res.status(400).json({ message: getErrorMessage(e) });
      }
    }
  );

  app.delete(
    "/api/factory/production-positions/:id",
    requireAuth,
    validateRequest(archivePositionInput),
    async (req: Request, res: Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = companyIdFor(req);
        const positionId = Number(req.params.id);
        if (!companyId || !Number.isInteger(positionId)) return res.status(400).json({ message: "Invalid request" });
        const effectiveFrom = todayIso();
        const position = await getPositionState(companyId, positionId, effectiveFrom);
        if (!position) return res.status(404).json({ message: "Production position not found" });
        await db.transaction(async (tx) => {
          await tx
            .update(factoryProductionPositions)
            .set({ active: false, updatedAt: new Date() })
            .where(
              and(eq(factoryProductionPositions.id, positionId), eq(factoryProductionPositions.companyId, companyId))
            );
          await replaceMemberships(tx, companyId, positionId, effectiveFrom, [], actor(req));
        });
        res.json({ ok: true, archived: true });
      } catch (e: unknown) {
        res.status(400).json({ message: getErrorMessage(e) });
      }
    }
  );
}
