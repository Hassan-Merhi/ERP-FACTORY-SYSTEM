/**
 * Shared plumbing for the Golden Coast Phase 8 container/offload routes: the
 * posting dependencies, the route error type, the posting actor and the known
 * error responder. Used by spGoldenCoastPhase8ContainerOffloadRoutes.ts and
 * spGoldenCoastPhase8FreshStartImportRoute.ts; behaviour is unchanged.
 */
import type { Request, Response } from "express";
import type { voucherEntries, vouchers } from "@shared/schema";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import {
  PostingValidationError,
  type CentralPostingResult,
  type PostingActor,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { GoldenCoastPhase8Error } from "../../services/accounting/goldenCoastPhase8ContainerOffload";

export const postingDependencies = createDatabasePostingDependencies();
export const PHASE8_MAX_LINES = 100;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export class GoldenCoastPhase8RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE8_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase8RouteError";
    this.code = code;
    this.status = status;
  }
}

export function actorFromRequest(req: Request): PostingActor {
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: "Golden Coast Phase 8 container/offload",
  };
}

export function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase8RouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase8Error) {
    const status = error.code === "GC_PHASE8_RESERVE_EXCEEDED" || error.code === "GC_PHASE8_SCOPE_MISMATCH" ? 409 : 400;
    res.status(status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    const status = error.code.includes("IDEMPOTENCY") ? 409 : 400;
    res.status(status).json({ code: error.code, message: error.message });
    return true;
  }
  return false;
}
