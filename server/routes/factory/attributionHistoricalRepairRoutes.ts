import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { factoryBalePhotos, factoryDaybookEntries, userCompanyRoles, users } from "@shared/schema";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { z } from "zod";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";

const APPLY_CONFIRMATION = "REPAIR_TRUNCATED_USER_ATTRIBUTION";

type CompanyUser = { id: string; username: string };
type RepairCandidate = {
  table: "factory_daybook_entries" | "factory_bale_photos";
  rowId: number;
  column: "created_by" | "uploaded_by";
  storedValue: string;
  userId: string;
  username: string;
};
type Unresolved = {
  table: "factory_daybook_entries" | "factory_bale_photos";
  rowId: number;
  column: "created_by" | "uploaded_by";
  storedValue: string;
  reason: "NO_COMPANY_USER_MATCH" | "AMBIGUOUS_COMPANY_USER_MATCH";
  matchingUserIds: string[];
};

function isTruncatedNumericUserId(value: string | null): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function resolvePrefix(
  usersInCompany: readonly CompanyUser[],
  table: RepairCandidate["table"],
  rowId: number,
  column: RepairCandidate["column"],
  storedValue: string
): RepairCandidate | Unresolved {
  const matches = usersInCompany.filter((user) => user.id.startsWith(storedValue));
  if (matches.length === 1) {
    return {
      table,
      rowId,
      column,
      storedValue,
      userId: matches[0].id,
      username: matches[0].username,
    };
  }
  return {
    table,
    rowId,
    column,
    storedValue,
    reason: matches.length === 0 ? "NO_COMPANY_USER_MATCH" : "AMBIGUOUS_COMPANY_USER_MATCH",
    matchingUserIds: matches.map((user) => user.id),
  };
}

async function inspectCompanyAttribution(companyId: number): Promise<{
  candidates: RepairCandidate[];
  unresolved: Unresolved[];
}> {
  const roleRows = await db
    .select({ id: users.id, username: users.username })
    .from(userCompanyRoles)
    .innerJoin(users, eq(users.id, userCompanyRoles.userId))
    .where(eq(userCompanyRoles.companyId, companyId));
  const usersInCompany = [...new Map(roleRows.map((row) => [row.id, { id: row.id, username: row.username }])).values()];

  const daybookRows = await db
    .select({ id: factoryDaybookEntries.id, value: factoryDaybookEntries.createdBy })
    .from(factoryDaybookEntries)
    .where(and(eq(factoryDaybookEntries.companyId, companyId), sql`${factoryDaybookEntries.createdBy} ~ '^[0-9]+$'`));
  const photoRows = await db
    .select({ id: factoryBalePhotos.id, value: factoryBalePhotos.uploadedBy })
    .from(factoryBalePhotos)
    .where(and(eq(factoryBalePhotos.companyId, companyId), sql`${factoryBalePhotos.uploadedBy} ~ '^[0-9]+$'`));

  const candidates: RepairCandidate[] = [];
  const unresolved: Unresolved[] = [];
  for (const row of daybookRows) {
    if (!isTruncatedNumericUserId(row.value)) continue;
    const result = resolvePrefix(usersInCompany, "factory_daybook_entries", row.id, "created_by", row.value);
    if ("userId" in result) candidates.push(result);
    else unresolved.push(result);
  }
  for (const row of photoRows) {
    if (!isTruncatedNumericUserId(row.value)) continue;
    const result = resolvePrefix(usersInCompany, "factory_bale_photos", row.id, "uploaded_by", row.value);
    if ("userId" in result) candidates.push(result);
    else unresolved.push(result);
  }

  return { candidates, unresolved };
}

// resolveRequestCompanyId reads an optional companyId from the body or query
// and refuses one that is not the session company.
const repairAttributionInput = {
  query: z.strictObject({ companyId: z.string().optional() }),
  body: z.union([
    z.undefined(),
    z.strictObject({
      dryRun: z.boolean().optional(),
      confirmation: z.string().optional(),
      companyId: z.union([z.number(), z.string()]).nullable().optional(),
    }),
  ]),
} satisfies RequestSchemas;

export function registerAttributionHistoricalRepairRoutes(app: Express): void {
  app.post(
    "/api/factory/admin/repair-truncated-user-attribution",
    requireAuth,
    requireRole("Admin"),
    validateRequest(repairAttributionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        const dryRun = req.body?.dryRun !== false;
        const inspection = await inspectCompanyAttribution(companyId);

        if (dryRun) {
          return res.json({
            dryRun: true,
            confirmationRequired: APPLY_CONFIRMATION,
            candidateCount: inspection.candidates.length,
            candidates: inspection.candidates,
            unresolvedCount: inspection.unresolved.length,
            unresolved: inspection.unresolved,
          });
        }

        if (req.body?.confirmation !== APPLY_CONFIRMATION) {
          return res.status(400).json({
            message: `Set confirmation to ${APPLY_CONFIRMATION} to apply the repair`,
          });
        }

        const repaired = await db.transaction(async (tx) => {
          const applied: RepairCandidate[] = [];
          for (const candidate of inspection.candidates) {
            if (candidate.table === "factory_daybook_entries") {
              const rows = await tx
                .update(factoryDaybookEntries)
                .set({ createdBy: candidate.userId })
                .where(
                  and(
                    eq(factoryDaybookEntries.id, candidate.rowId),
                    eq(factoryDaybookEntries.companyId, companyId),
                    eq(factoryDaybookEntries.createdBy, candidate.storedValue)
                  )
                )
                .returning({ id: factoryDaybookEntries.id });
              if (rows.length !== 1) {
                throw new Error(`Daybook attribution row ${candidate.rowId} changed during repair`);
              }
            } else {
              const rows = await tx
                .update(factoryBalePhotos)
                .set({ uploadedBy: candidate.userId })
                .where(
                  and(
                    eq(factoryBalePhotos.id, candidate.rowId),
                    eq(factoryBalePhotos.companyId, companyId),
                    eq(factoryBalePhotos.uploadedBy, candidate.storedValue)
                  )
                )
                .returning({ id: factoryBalePhotos.id });
              if (rows.length !== 1) {
                throw new Error(`Bale photo attribution row ${candidate.rowId} changed during repair`);
              }
            }
            applied.push(candidate);
          }
          return applied;
        });

        logger.info(
          JSON.stringify({
            event: "historical_user_attribution_repair_applied",
            userId: req.session.userId ?? null,
            companyId,
            repairedCount: repaired.length,
            unresolvedCount: inspection.unresolved.length,
            repairedRows: repaired.map((row) => ({
              table: row.table,
              rowId: row.rowId,
              userId: row.userId,
            })),
          })
        );

        return res.json({
          dryRun: false,
          repairedCount: repaired.length,
          repaired,
          unresolvedCount: inspection.unresolved.length,
          unresolved: inspection.unresolved,
        });
      } catch (error: unknown) {
        logger.error("POST /api/factory/admin/repair-truncated-user-attribution error", { error });
        return res.status(500).json({
          message: error instanceof Error ? error.message : "Failed to repair historical attribution",
        });
      }
    }
  );
}
