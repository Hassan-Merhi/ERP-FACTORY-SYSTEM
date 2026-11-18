// Extracted from ./update.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { factoryMixBatches, factoryMixBatchSources } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  MixEditRequestError,
  parseMixEditSelection,
  sameMixEditSources,
} from "../../../services/factory/mixBatchEditRequest";
import { prepareMixSourceEditReview } from "../../../services/factory/mixBatchEditReview";

export class CompletedMixBatchSourceEditError extends Error {
  readonly code = "MIX_BATCH_COMPLETED_SOURCE_EDIT_REQUIRES_REVIEW";
  constructor() {
    super(
      "Completed mix batches cannot have source materials repriced automatically. Use the reviewed correction workflow."
    );
  }
}

export async function handlePatchFactoryMixBatchesIdStep1(req: Request, res: Response) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const id = parseId(req.params.id);

  if (id === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new MixEditRequestError("An edit request body is required.");
  }
  const { name, notes, batchDate, supplierSources, batchSources } = req.body;
  if (
    (name !== undefined && name !== null && typeof name !== "string") ||
    (notes !== undefined && notes !== null && typeof notes !== "string")
  ) {
    throw new MixEditRequestError("Name and notes must be text.");
  }
  if (typeof name === "string" && name.length > 500) {
    throw new MixEditRequestError("Batch name is too long.");
  }
  if (batchDate !== undefined && batchDate !== null && batchDate !== "") {
    const iso = String(batchDate);
    if (
      typeof batchDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(iso) ||
      Number.isNaN(Date.parse(iso)) ||
      new Date(iso).toISOString().slice(0, 10) !== iso
    ) {
      throw new MixEditRequestError("Batch date must be a valid YYYY-MM-DD date.", "MIX_EDIT_INVALID_DATE");
    }
  }

  // Identical source weights are metadata-only, even if an older client
  // submits all its sources. Never silently reprice that historical batch.
  const hasSourceUpdate = supplierSources !== undefined || batchSources !== undefined;
  if (req.body.sourceEditPreview === true && !hasSourceUpdate) {
    throw new MixEditRequestError("A source-edit preview requires both source lists.");
  }
  const parsedSources = hasSourceUpdate ? parseMixEditSelection(req.body) : null;
  const reason = typeof req.body.sourceEditReason === "string" ? req.body.sourceEditReason.trim() : "";
  let identicalSources = false;
  if (parsedSources) {
    const [existing] = await db
      .select()
      .from(factoryMixBatches)
      .where(
        and(
          eq(factoryMixBatches.id, id),
          eq(factoryMixBatches.companyId, companyId),
          isNull(factoryMixBatches.deletedAt)
        )
      );
    if (!existing) return { done: true as const, value: res.status(404).json({ message: "Mix batch not found" }) };
    const prior = await db.select().from(factoryMixBatchSources).where(eq(factoryMixBatchSources.mixBatchId, id));
    identicalSources = sameMixEditSources(prior, parsedSources);
    if (req.body.sourceEditPreview === true) {
      const preview = await prepareMixSourceEditReview(db, companyId, existing, prior, parsedSources, reason, {
        proposedBatchDate: batchDate,
      });
      res.set("Cache-Control", "private, no-store");
      return { done: true as const, value: res.json({ ...preview, previewOnly: true, batchCode: existing.batchCode }) };
    }
  }

  if (!hasSourceUpdate || identicalSources) {
    const [batch] = await db
      .select()
      .from(factoryMixBatches)
      .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));
    if (!batch || batch.deletedAt)
      return { done: true as const, value: res.status(404).json({ message: "Mix batch not found" }) };
    const updates: Partial<typeof factoryMixBatches.$inferInsert> = {};
    if (name !== undefined) updates.name = name?.trim() || null;
    if (notes !== undefined) updates.notes = notes?.trim() || null;
    if (batchDate !== undefined) updates.batchDate = batchDate || null;
    if (Object.keys(updates).length === 0) return { done: true as const, value: res.json(batch) };
    // Phase 21 (B): the write and its audit commit together.
    const updated = await db.transaction(async (tx) => {
      const [written] = await tx
        .update(factoryMixBatches)
        .set(updates)
        .where(
          and(
            eq(factoryMixBatches.id, id),
            eq(factoryMixBatches.companyId, companyId),
            isNull(factoryMixBatches.deletedAt)
          )
        )
        .returning();
      if (!written) throw new Error("Mix batch is no longer available");
      await logAudit(
        {
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId,
          action: "update",
          tableName: "factory_mix_batches",
          recordId: id,
          recordIdentifier: batch.batchCode + (written.name ? ` – ${written.name}` : ""),
          changes: {
            ...(name !== undefined ? { name: { old: batch.name ?? null, new: written.name ?? null } } : {}),
            ...(notes !== undefined ? { notes: { old: batch.notes ?? null, new: written.notes ?? null } } : {}),
            ...(batchDate !== undefined
              ? { batchDate: { old: batch.batchDate ?? null, new: written.batchDate ?? null } }
              : {}),
          },
        },
        tx
      );
      return written;
    });
    return { done: true as const, value: res.json(updated) };
  }

  // Every real source edit requires a reviewed hash; validation is
  // repeated under transaction locks before any quantity changes.
  const sourceInputs = parsedSources!;
  const weightOf = (source: { weightKg: string }) => toMoney(source.weightKg);
  const ZERO = new MoneyDecimal(0);
  if (req.body.confirmSourceEdit !== true || typeof req.body.sourceEditReviewHash !== "string") {
    return {
      done: true as const,
      value: res.status(409).json({
        code: "MIX_EDIT_REVIEW_REQUIRED",
        message: "Review the proposed source changes before applying them.",
      }),
    };
  }
  return { done: false as const, ZERO, batchDate, companyId, id, name, notes, reason, sourceInputs, weightOf };
}
