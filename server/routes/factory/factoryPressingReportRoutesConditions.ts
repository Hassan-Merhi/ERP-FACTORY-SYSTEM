// Extracted from ./factoryPressingReportRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { logger } from "../../lib/logger";
import type { PressingReportFilters } from "@shared/pressingReportContracts";
import { canEditPressingTargets } from "./pressingHourlyTargetRules";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";

// Individual worker history stays scoped. View Only can read company-wide reports but never correct scans.
const MANAGER_ROLES = new Set(["Admin", "Owner", "Developer"]);

export type QueryCtx = { companyId: number; userId: string; supervisor: boolean; canCorrect: boolean };

type Param = string | number;

// All report dates are Beirut wall-clock dates derived from the immutable UTC
// confirmed_at instant, including historical rows recorded with UTC snapshots.
export const PRESSING_LOCAL_DATE_SQL = "(c.confirmed_at AT TIME ZONE '" + PRESSING_TIME_ZONE + "')::date";

export class ReportPermissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function handleError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      code: "PRESSING_INVALID_REPORT_FILTER",
      message: "Invalid pressing history filter",
      issues: error.issues,
    });
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof ReportPermissionError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  const pgErr = error as { code?: string; cause?: { code?: string } };
  if (pgErr?.code === "23505" || pgErr?.cause?.code === "23505") {
    return res.status(409).json({ code: "PRESSING_VIEW_CONFLICT", message: "A conflicting saved view already exists" });
  }
  logger.error("Pressing reporting error", { error });
  return res.status(500).json({ code: "PRESSING_REPORT_FAILED", message: "Unable to load pressing history" });
}

export async function context(req: Request): Promise<QueryCtx> {
  const ctx = await getActiveCompanyPermissionContext(req);
  return {
    companyId: ctx.companyId,
    userId: ctx.userId,
    supervisor:
      (MANAGER_ROLES.has(ctx.role) && !ctx.posViewOnly) || ctx.role === "View Only" || ctx.role === "Create Only",
    canCorrect: canEditPressingTargets(ctx.role, ctx.posViewOnly),
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function conditions(ctx: QueryCtx, filters: PressingReportFilters) {
  const args: Param[] = [ctx.companyId];
  const where: string[] = ["c.company_id = $1"];
  const push = (fragment: string, value: Param) => {
    args.push(value);
    where.push(fragment.replace("?", "$" + args.length));
  };
  if (!ctx.supervisor) {
    if (filters.userId && filters.userId !== ctx.userId) {
      throw new ReportPermissionError(403, "PRESSING_REPORT_FORBIDDEN", "Operators can view only their own records");
    }
    push("c.user_id = ?", ctx.userId);
  } else if (filters.userId) {
    push("c.user_id = ?", filters.userId);
  }
  // Calculate inclusive Beirut dates with timezone-aware boundaries. These
  // remain correct across the winter UTC+2 / summer UTC+3 DST transition
  // and preserve use of the confirmed_at index for large histories.
  if (filters.from) {
    if (filters.fromTime) {
      push(
        "c.confirmed_at >= (?::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "')",
        filters.from + " " + filters.fromTime
      );
    } else {
      push("c.confirmed_at >= (?::date::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "')", filters.from);
    }
  }
  if (filters.to) {
    if (filters.toTime) {
      // Inclusive ending minute: 14:30 includes scans through 14:30:59.999.
      push(
        "c.confirmed_at < ((?::timestamp + interval '1 minute') AT TIME ZONE '" + PRESSING_TIME_ZONE + "')",
        filters.to + " " + filters.toTime
      );
    } else {
      push("c.confirmed_at < ((?::date + 1)::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "')", filters.to);
    }
  }
  if (filters.asOf) push("c.confirmed_at <= ?::timestamptz", filters.asOf);
  if (filters.machineId) push("c.machine_id = ?", filters.machineId);
  if (filters.weightKg !== undefined) push("c.weight_kg = ?::numeric", filters.weightKg);
  if (filters.shiftId) push("c.shift_id = ?", filters.shiftId);
  if (filters.articleCode) push("c.article_code ILIKE ?", "%" + escapeLike(filters.articleCode) + "%");
  if (filters.search) {
    args.push("%" + escapeLike(filters.search) + "%");
    const ref = "$" + args.length;
    where.push(
      "(c.reference_number ILIKE " + ref + " OR c.article_code ILIKE " + ref + " OR c.product_name ILIKE " + ref + ")"
    );
  }
  return { args, where };
}

export function invalidDateTimeRange(
  filters: Pick<PressingReportFilters, "from" | "to" | "fromTime" | "toTime">
): boolean {
  return Boolean(
    (filters.fromTime && !filters.from) ||
    (filters.toTime && !filters.to) ||
    (filters.from &&
      filters.to &&
      (filters.from > filters.to ||
        (filters.from === filters.to && filters.fromTime && filters.toTime && filters.fromTime > filters.toTime)))
  );
}

export function statusPredicate(status: PressingReportFilters["status"]): string | null {
  if (status === "active") return "c.voided_at IS NULL";
  if (status === "voided") return "c.voided_at IS NOT NULL";
  return null;
}
