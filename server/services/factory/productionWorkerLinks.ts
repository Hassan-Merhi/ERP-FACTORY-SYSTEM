import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";

export interface ProductionWorkerLinkMember {
  workerId: number;
  workerName: string;
}

export interface ProductionWorkerLink {
  id: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sharedTargetBales: number | null;
  members: ProductionWorkerLinkMember[];
}

type LinkRow = {
  id: number | string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sharedTargetBales: string | number | null;
  members: unknown;
};

function parseMembers(value: unknown): ProductionWorkerLinkMember[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((member) => ({
      workerId: Number(member?.workerId),
      workerName: String(member?.workerName ?? ""),
    }))
    .filter((member) => Number.isInteger(member.workerId) && member.workerId > 0)
    .sort((a, b) => a.workerId - b.workerId);
}

export async function loadActiveProductionWorkerLinks(
  companyId: number,
  asOf: string
): Promise<ProductionWorkerLink[]> {
  const result = await db.execute(sql`
    SELECT
      l.id,
      l.effective_from::text AS "effectiveFrom",
      l.effective_to::text AS "effectiveTo",
      target.target_bales AS "sharedTargetBales",
      COALESCE(
        jsonb_agg(
          jsonb_build_object('workerId', w.id, 'workerName', w.full_name)
          ORDER BY w.id
        ) FILTER (WHERE w.id IS NOT NULL),
        '[]'::jsonb
      ) AS members
    FROM factory_worker_production_links l
    JOIN factory_worker_production_link_members m
      ON m.link_id = l.id
     AND m.company_id = l.company_id
    JOIN factory_workers w
      ON w.id = m.worker_id
     AND w.company_id = l.company_id
    LEFT JOIN LATERAL (
      SELECT d.target_bales
      FROM factory_worker_production_link_target_defaults d
      WHERE d.company_id = l.company_id
        AND d.link_id = l.id
        AND d.effective_from <= ${asOf}::date
      ORDER BY d.effective_from DESC, d.id DESC
      LIMIT 1
    ) target ON TRUE
    WHERE l.company_id = ${companyId}
      AND l.effective_from <= ${asOf}::date
      AND (l.effective_to IS NULL OR l.effective_to > ${asOf}::date)
    GROUP BY l.id, l.effective_from, l.effective_to, target.target_bales
    ORDER BY l.id
  `);

  return (resultRows(result) as LinkRow[]).map((row) => ({
    id: Number(row.id),
    effectiveFrom: String(row.effectiveFrom),
    effectiveTo: row.effectiveTo == null ? null : String(row.effectiveTo),
    sharedTargetBales: row.sharedTargetBales == null ? null : Number(row.sharedTargetBales),
    members: parseMembers(row.members),
  }));
}

export function indexProductionWorkerLinks(links: ProductionWorkerLink[]): Map<number, ProductionWorkerLink> {
  const byWorker = new Map<number, ProductionWorkerLink>();
  for (const link of links) {
    for (const member of link.members) byWorker.set(member.workerId, link);
  }
  return byWorker;
}

export async function createProductionWorkerLink(input: {
  companyId: number;
  effectiveFrom: string;
  workerIds: number[];
  targetBales: number | null;
  createdBy: string | number | null;
}): Promise<number> {
  const workerIds = [...new Set(input.workerIds)].sort((a, b) => a - b);

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE factory_worker_production_links l
      SET effective_to = ${input.effectiveFrom}::date, updated_at = now()
      WHERE l.company_id = ${input.companyId}
        AND l.effective_from <= ${input.effectiveFrom}::date
        AND (l.effective_to IS NULL OR l.effective_to > ${input.effectiveFrom}::date)
        AND EXISTS (
          SELECT 1
          FROM factory_worker_production_link_members m
          WHERE m.link_id = l.id
            AND m.company_id = l.company_id
            AND m.worker_id = ANY(${sqlArray(workerIds)})
        )
    `);

    const linkResult = await tx.execute(sql`
      INSERT INTO factory_worker_production_links (
        company_id, effective_from, effective_to, created_by, created_at, updated_at
      ) VALUES (
        ${input.companyId}, ${input.effectiveFrom}::date, NULL, ${input.createdBy}, now(), now()
      )
      RETURNING id
    `);
    const linkId = Number(resultRows(linkResult)[0]?.id);
    if (!linkId) throw new Error("Could not create worker link");

    const memberValues = workerIds.map(
      (workerId) => sql`(${linkId}, ${input.companyId}, ${workerId}, now())`
    );
    await tx.execute(sql`
      INSERT INTO factory_worker_production_link_members (
        link_id, company_id, worker_id, created_at
      ) VALUES ${sql.join(memberValues, sql`, `)}
    `);

    await tx.execute(sql`
      INSERT INTO factory_worker_production_link_target_defaults (
        link_id, company_id, effective_from, target_bales, created_by, created_at, updated_at
      ) VALUES (
        ${linkId}, ${input.companyId}, ${input.effectiveFrom}::date,
        ${input.targetBales}, ${input.createdBy}, now(), now()
      )
      ON CONFLICT (link_id, effective_from)
      DO UPDATE SET target_bales = EXCLUDED.target_bales, created_by = EXCLUDED.created_by, updated_at = now()
    `);

    return linkId;
  });
}

export async function saveProductionLinkTargetDefault(input: {
  companyId: number;
  linkId: number;
  effectiveFrom: string;
  targetBales: number | null;
  createdBy: string | number | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO factory_worker_production_link_target_defaults (
      link_id, company_id, effective_from, target_bales, created_by, created_at, updated_at
    ) VALUES (
      ${input.linkId}, ${input.companyId}, ${input.effectiveFrom}::date,
      ${input.targetBales}, ${input.createdBy}, now(), now()
    )
    ON CONFLICT (link_id, effective_from)
    DO UPDATE SET target_bales = EXCLUDED.target_bales, created_by = EXCLUDED.created_by, updated_at = now()
  `);
}

export async function unlinkProductionWorkerLink(input: {
  companyId: number;
  linkId: number;
  effectiveTo: string;
  createdBy: string | number | null;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const linkResult = await tx.execute(sql`
      SELECT id, effective_from::text AS "effectiveFrom"
      FROM factory_worker_production_links
      WHERE id = ${input.linkId} AND company_id = ${input.companyId}
      LIMIT 1
      FOR UPDATE
    `);
    const link = resultRows(linkResult)[0];
    if (!link) return false;
    if (input.effectiveTo < String(link.effectiveFrom)) {
      throw new Error("Unlink date cannot be before the link start date");
    }

    const targetResult = await tx.execute(sql`
      SELECT target_bales AS "targetBales"
      FROM factory_worker_production_link_target_defaults
      WHERE company_id = ${input.companyId}
        AND link_id = ${input.linkId}
        AND effective_from <= ${input.effectiveTo}::date
      ORDER BY effective_from DESC, id DESC
      LIMIT 1
    `);
    const targetRaw = resultRows(targetResult)[0]?.targetBales;
    const sharedTarget = targetRaw == null ? null : Number(targetRaw);

    const membersResult = await tx.execute(sql`
      SELECT worker_id AS "workerId"
      FROM factory_worker_production_link_members
      WHERE company_id = ${input.companyId} AND link_id = ${input.linkId}
      ORDER BY worker_id
    `);
    const workerIds = resultRows(membersResult).map((row) => Number(row.workerId));

    await tx.execute(sql`
      UPDATE factory_worker_production_links
      SET effective_to = ${input.effectiveTo}::date, updated_at = now()
      WHERE id = ${input.linkId} AND company_id = ${input.companyId}
    `);

    for (const workerId of workerIds) {
      const existingDefaultResult = await tx.execute(sql`
        SELECT category
        FROM factory_worker_production_target_defaults
        WHERE company_id = ${input.companyId}
          AND worker_id = ${workerId}
          AND effective_from <= ${input.effectiveTo}::date
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
      `);
      const category = String(resultRows(existingDefaultResult)[0]?.category ?? "");

      await tx.execute(sql`
        INSERT INTO factory_worker_production_target_defaults (
          company_id, worker_id, effective_from, category, target_bales, created_by, created_at, updated_at
        ) VALUES (
          ${input.companyId}, ${workerId}, ${input.effectiveTo}::date,
          ${category}, ${sharedTarget}, ${input.createdBy}, now(), now()
        )
        ON CONFLICT (company_id, worker_id, effective_from)
        DO UPDATE SET
          category = EXCLUDED.category,
          target_bales = EXCLUDED.target_bales,
          created_by = EXCLUDED.created_by,
          updated_at = now()
      `);
    }

    return true;
  });
}
