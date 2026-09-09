/**
 * factoryDocsUsersRoutes: FactoryBaleRelabel endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBales,
  factoryBaleSequences,
  baleLabelPrints,
  baleRecodeSessions,
  baleRecodeItems,
} from "@shared/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";

export function registerFactoryBaleRelabelRoutes(app: Express) {
  // ─────────────────────────────────────────────────────
  // BALE RELABELING  (validate → apply → audit history)
  // ─────────────────────────────────────────────────────

  /** POST /api/factory/bales/relabel/validate
   *  Dry-run: checks each currentRef against factory_bales. Returns per-row results.
   */
  app.post("/api/factory/bales/relabel/validate", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "rows array is required" });
      }

      const refCodes: string[] = rows.map((r) => String(r.currentRef || "").trim()).filter(Boolean);
      if (refCodes.length === 0) return res.status(400).json({ message: "No reference codes provided" });

      // fetch all bales in one query
      const baleRows = await db
        .select({
          referenceNumber: factoryBales.referenceNumber,
          productName: factoryBales.productName,
          articleCode: factoryBales.articleCode,
          weightKg: factoryBales.weightKg,
          status: factoryBales.status,
        })
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.referenceNumber, refCodes)));

      const baleMap = new Map(baleRows.map((b) => [b.referenceNumber, b]));

      // detect duplicate refs in the uploaded file
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const ref of refCodes) {
        if (seen.has(ref)) dupes.add(ref);
        seen.add(ref);
      }

      const results = rows.map((r) => {
        const ref = String(r.currentRef || "").trim();
        if (!ref) return { currentRef: ref, valid: false, error: "Empty reference code" };
        if (dupes.has(ref)) return { currentRef: ref, valid: false, error: "Duplicate in upload" };
        const bale = baleMap.get(ref);
        if (!bale) return { currentRef: ref, valid: false, error: "Not found in inventory" };
        return {
          currentRef: ref,
          valid: true,
          productName: bale.productName || bale.articleCode || "Unknown",
          articleCode: bale.articleCode || "",
          weightKg: bale.weightKg || "0",
          status: bale.status,
        };
      });

      const validCount = results.filter((r) => r.valid).length;
      const invalidCount = results.length - validCount;
      res.json({ results, validCount, invalidCount });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  /** POST /api/factory/bales/relabel/apply
   *  Atomically reassigns reference codes and records audit.
   */
  app.post("/api/factory/bales/relabel/apply", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId: string | null = req.session.userId || null;

      const { rows, printFormat, designColor, filename } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "rows array is required" });
      }

      const validRows = rows.filter((r) => String(r.currentRef || "").trim());
      if (validRows.length === 0) return res.status(400).json({ message: "No valid rows to apply" });

      const result = await db.transaction(async (tx) => {
        // 1. Fetch bales to recode
        const refCodes = validRows.map((r) => String(r.currentRef).trim());
        const baleRows = await tx
          .select({
            id: factoryBales.id,
            referenceNumber: factoryBales.referenceNumber,
            productName: factoryBales.productName,
            articleCode: factoryBales.articleCode,
            weightKg: factoryBales.weightKg,
            status: factoryBales.status,
          })
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.referenceNumber, refCodes)));

        const baleMap = new Map(baleRows.map((b) => [b.referenceNumber, b]));
        const notFound = refCodes.filter((r) => !baleMap.has(r));
        if (notFound.length > 0) {
          throw new Error(
            `Bales not found: ${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? ` +${notFound.length - 5} more` : ""}`
          );
        }

        // 2. Allocate sequential new REF codes
        const count = refCodes.length;
        const [seqRow] = await tx
          .select({ nextNumber: factoryBaleSequences.nextNumber })
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId))
          .for("update");

        const dbMaxResult = await tx.execute(
          sql`SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(reference_number, '[^0-9]', '', 'g') AS BIGINT)), 199999) as maxnum FROM factory_bales WHERE company_id = ${companyId}`
        );
        const dbMaxRow = Array.isArray(dbMaxResult) ? dbMaxResult[0] : (dbMaxResult?.rows?.[0] ?? {});
        const dbMax = Number(dbMaxRow?.maxnum ?? 199999);
        const storedNext = seqRow?.nextNumber ?? 200000;
        const nextNumber = Math.max(storedNext, dbMax + 1, 200000);

        const newRefs: string[] = [];
        for (let i = 0; i < count; i++) {
          newRefs.push(`REF${String(nextNumber + i).padStart(6, "0")}`);
        }

        // Upsert sequence
        if (seqRow) {
          await tx
            .update(factoryBaleSequences)
            .set({ nextNumber: nextNumber + count })
            .where(eq(factoryBaleSequences.companyId, companyId));
        } else {
          await tx.insert(factoryBaleSequences).values({ companyId, nextNumber: nextNumber + count });
        }

        // 3. Update factory_bales referenceNumber
        type RecodeBale = NonNullable<ReturnType<typeof baleMap.get>>;
        const recodeMap: { oldRef: string; newRef: string; bale: RecodeBale }[] = refCodes.map((oldRef, i) => {
          const bale = baleMap.get(oldRef);
          // Unreachable: the notFound guard above throws when any refCode is
          // absent from baleMap. An internal code, not user-facing copy.
          if (!bale) throw new Error("bale_recode_row_missing");
          return { oldRef, newRef: newRefs[i], bale };
        });

        for (const { oldRef, newRef } of recodeMap) {
          await tx
            .update(factoryBales)
            .set({ referenceNumber: newRef, updatedAt: new Date() })
            .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.referenceNumber, oldRef)));

          // Also update bale_label_prints if the old ref is there
          await tx
            .update(baleLabelPrints)
            .set({ referenceNumber: newRef })
            .where(and(eq(baleLabelPrints.companyId, companyId), eq(baleLabelPrints.referenceNumber, oldRef)));
        }

        // 4. Write audit session
        const [session] = await tx
          .insert(baleRecodeSessions)
          .values({
            companyId,
            performedBy: userId || null,
            uploadedFilename: filename || null,
            printFormat: printFormat || "A4",
            designColor: designColor || null,
            totalRows: rows.length,
            validRows: recodeMap.length,
            invalidRows: rows.length - recodeMap.length,
          })
          .returning({ id: baleRecodeSessions.id });

        // 5. Write audit items
        const itemValues = recodeMap.map(({ oldRef, newRef, bale }) => ({
          sessionId: session.id,
          oldReferenceCode: oldRef,
          newReferenceCode: newRef,
          productName: bale.productName || bale.articleCode || null,
          articleCode: bale.articleCode || null,
          weightKg: bale.weightKg || null,
          status: "SUCCESS",
          errorMessage: null,
        }));
        await tx.insert(baleRecodeItems).values(itemValues);

        return {
          sessionId: session.id,
          items: recodeMap.map(({ oldRef, newRef, bale }) => ({
            oldRef,
            newRef,
            productName: bale.productName || bale.articleCode || "Unknown",
            articleCode: bale.articleCode || "",
            weightKg: bale.weightKg || "0",
          })),
        };
      });

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  /** GET /api/factory/bales/relabel/sessions
   *  Recent relabeling history for the company.
   */
  app.get("/api/factory/bales/relabel/sessions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const sessions = await db
        .select()
        .from(baleRecodeSessions)
        .where(eq(baleRecodeSessions.companyId, companyId))
        .orderBy(desc(baleRecodeSessions.createdAt))
        .limit(10);

      // attach items counts
      const sessionIds = sessions.map((s) => s.id);
      const itemsBySession: Record<number, any[]> = {};
      if (sessionIds.length > 0) {
        const items = await db.select().from(baleRecodeItems).where(inArray(baleRecodeItems.sessionId, sessionIds));
        for (const item of items) {
          if (!itemsBySession[item.sessionId]) itemsBySession[item.sessionId] = [];
          itemsBySession[item.sessionId].push(item);
        }
      }

      const enriched = sessions.map((s) => ({
        ...s,
        items: itemsBySession[s.id] || [],
      }));

      res.json(enriched);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Factory Employees ────────────────────────────────────────────────────────

  // GET /api/factory/employees - list employees (employeeType = "Employee") for current company
}
