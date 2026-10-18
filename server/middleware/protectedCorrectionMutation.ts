import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";
import { db } from "../db";

// Keep the posted correction in the financial record. Restrict changes to Developer only.
const CORRECTION_VOUCHER_ID = 16303;

function isRestricted(req: Request): boolean {
  return req.session?.currentRole !== "Developer";
}

function block(res: Response): Response {
  return res.status(403).json({ message: "FORBIDDEN", code: "CORRECTION_DEVELOPER_ONLY" });
}

function isVoucherId(value: unknown): boolean {
  return Number(value) === CORRECTION_VOUCHER_ID;
}

export function registerProtectedCorrectionMutationBoundary(app: Express): void {
  // All manual update/delete/reverse routes, including nested voucher operations.
  app.use("/api/vouchers/:id", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (isRestricted(req) && isVoucherId(req.params.id)) return block(res);
    return next();
  });

  // Reject the entire bulk operation if the protected voucher is included.
  app.post("/api/vouchers/bulk-delete", (req, res, next) => {
    if (isRestricted(req) && Array.isArray(req.body?.voucherIds) && req.body.voucherIds.some(isVoucherId)) {
      return block(res);
    }
    return next();
  });

  // Prevent insertion of journal lines on the protected voucher.
  app.post("/api/voucher-entries", (req, res, next) => {
    if (isRestricted(req) && isVoucherId(req.body?.voucherId)) return block(res);
    return next();
  });

  // Existing voucher entries can also be edited by their own IDs.
  app.use("/api/voucher-entries/:id", async (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!isRestricted(req) || !req.session?.userId) return next();

    const entryId = Number(req.params.id);
    if (!Number.isSafeInteger(entryId) || entryId < 1) return next();

    try {
      const [entry] = await db
        .select({ voucherId: voucherEntries.voucherId })
        .from(voucherEntries)
        .where(eq(voucherEntries.id, entryId))
        .limit(1);
      if (entry && entry.voucherId === CORRECTION_VOUCHER_ID) return block(res);
      return next();
    } catch (error) {
      return next(error);
    }
  });
}
