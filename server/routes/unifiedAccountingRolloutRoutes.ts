/** Phase 15 — strictly scoped accounting certification and pilot operations. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import {
  ReleaseError,
  unifiedReleaseReadinessTx,
  unifiedReleasePolicyTx,
  recordUnifiedReleaseReviewTx,
  revokeUnifiedReleaseReviewTx,
  setUnifiedReleaseModeTx,
} from "../services/accounting/unifiedRolloutService";

const review = z.object({
  kind: z.enum(["TECHNICAL", "SECURITY", "FINANCE"]),
  releaseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  evidenceReference: z.string().trim().min(12).max(500),
  notes: z.string().trim().min(10).max(2000),
});
const policy = z.object({
  mode: z.enum(["READ_ONLY", "METADATA_PILOT"]),
  releaseSha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  reason: z.string().trim().min(10).max(1000),
});
const positiveId = z.coerce.number().int().positive();
function sessionCompany(req: Request) {
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id < 1) throw new ReleaseError("RELEASE_COMPANY_REQUIRED", "Select a company", 400);
  return id;
}
function actor(req: Request) {
  const id = String(req.session.userId ?? "").trim();
  if (!id) throw new ReleaseError("RELEASE_ACTOR_REQUIRED", "Login required", 401);
  return { userId: id, username: String(req.session.username ?? id) };
}
function role(req: Request) {
  // Rollout approval and review capacities are tied to the selected company,
  // not a global user role that could grant access to another company's data.
  return String(req.session.currentRole ?? "");
}
function owner(req: Request) {
  if (role(req) !== "Owner")
    throw new ReleaseError(
      "RELEASE_OWNER_ONLY",
      "Only the selected company's Owner can change rollout policy or revoke reviews",
      403
    );
}
function reviewer(req: Request, kind: string) {
  const current = role(req);
  if (kind === "FINANCE") {
    if (!["Admin", "Owner"].includes(current))
      throw new ReleaseError("RELEASE_FINANCE_REVIEWER_REQUIRED", "Finance review requires Admin or Owner", 403);
  } else if (!["Developer", "Admin"].includes(current))
    throw new ReleaseError(
      "RELEASE_TECH_REVIEWER_REQUIRED",
      "Technical/security review requires Developer or Admin",
      403
    );
}
function failure(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      code: "RELEASE_INVALID_REQUEST",
      message: error.issues.map((i) => i.message).join("; "),
    });
  if (error instanceof ReleaseError)
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
    });
  const code = (error as { code?: string })?.code;
  if (code === "23505")
    return res.status(409).json({
      code: "RELEASE_REVIEW_DUPLICATE",
      message: "A current review in this capacity already exists for this release",
    });
  return res.status(503).json({
    code: "RELEASE_UNAVAILABLE",
    message: "Accounting rollout verification is unavailable; metadata writes remain read-only",
  });
}
export function registerUnifiedAccountingRolloutRoutes(app: Express) {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/rollout/readiness", ...gate, async (req, res) => {
    try {
      const companyId = sessionCompany(req);
      const result = await db.transaction((tx) => unifiedReleaseReadinessTx(tx, companyId));
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/rollout/policy", ...gate, async (req, res) => {
    try {
      const companyId = sessionCompany(req);
      const result = await db.transaction((tx) => unifiedReleasePolicyTx(tx, companyId));
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/rollout/reviews", ...gate, async (req, res) => {
    try {
      const body = review.parse(req.body),
        companyId = sessionCompany(req);
      reviewer(req, body.kind);
      const result = await db.transaction((tx) =>
        recordUnifiedReleaseReviewTx(tx, {
          companyId,
          kind: body.kind,
          evidenceReference: body.evidenceReference,
          releaseSha: body.releaseSha,
          notes: body.notes,
          actor: actor(req),
        })
      );
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/rollout/reviews/:id/revoke", ...gate, async (req, res) => {
    try {
      owner(req);
      const reviewId = positiveId.parse(req.params.id),
        companyId = sessionCompany(req);
      const body = z.object({ reason: z.string().trim().min(10).max(1000) }).parse(req.body);
      const result = await db.transaction((tx) =>
        revokeUnifiedReleaseReviewTx(tx, {
          companyId,
          reviewId,
          reason: body.reason,
          actor: actor(req),
        })
      );
      res.setHeader("Cache-Control", "no-store");
      return res.json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/rollout/mode", ...gate, async (req, res) => {
    try {
      owner(req);
      const body = policy.parse(req.body),
        companyId = sessionCompany(req);
      const result = await db.transaction((tx) =>
        setUnifiedReleaseModeTx(tx, {
          companyId,
          mode: body.mode,
          releaseSha: body.releaseSha,
          reason: body.reason,
          actor: actor(req),
        })
      );
      res.setHeader("Cache-Control", "no-store");
      return res.json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
}
