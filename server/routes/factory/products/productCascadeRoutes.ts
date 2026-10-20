/**
 * factoryProductsRoutes: FactoryProductCascade endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProducts, factoryBales } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

const GRADE_TO_PREFIX: Record<string, string> = {
  CREAM: "HMD10",
  "#1": "HMD11",
  "#2": "HMD12",
  "#3": "HMD13",
  "#4": "HMD14",
  Garbage: "HMD16",
};

function inferGradeFromArticleCode(articleCode: string | null | undefined): string | null {
  if (!articleCode) return null;
  const match = Object.entries(GRADE_TO_PREFIX).find(([, prefix]) => articleCode.startsWith(prefix));
  return match?.[0] ?? null;
}

export function registerFactoryProductCascadeRoutes(app: Express) {
  app.post("/api/factory/bale-products/:id/cascade-update", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ message: "A valid product update is required" });
      }
      const {
        name,
        weightPerBaleKg,
        articleCode,
        description,
        categoryId,
        grade,
        productionPrice,
        sellingPrice,
        labelDesignColor,
      } = req.body;

      const [existing] = await db
        .select()
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)));

      if (!existing) return res.status(404).json({ message: "Product not found" });

      // A null/invalid name must never crash .trim() when a caller edits a price.
      if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return res.status(400).json({ message: "Product name must be a non-empty string" });
      }
      if (name !== undefined && name.trim().toLowerCase() !== existing.name.toLowerCase()) {
        const [nameConflict] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              sql`LOWER(${factoryBaleProducts.name}) = LOWER(${name.trim()})`,
              sql`${factoryBaleProducts.id} != ${id}`
            )
          );
        if (nameConflict) {
          return res.status(400).json({ message: `A product named "${name.trim()}" already exists` });
        }
      }

      const existingGrade = inferGradeFromArticleCode(existing.articleCode);
      let nextArticleCode = articleCode;
      let generatedArticleCode = false;

      if (grade !== undefined) {
        if (typeof grade !== "string" || !GRADE_TO_PREFIX[grade]) {
          return res.status(400).json({ message: "Valid grade is required (CREAM, #1, #2, #3, #4, Garbage)" });
        }

        const targetPrefix = GRADE_TO_PREFIX[grade];
        const gradeChanged = grade !== existingGrade;
        const articleCodeWasManuallyChanged = articleCode !== undefined && articleCode !== existing.articleCode;

        // An explicitly supplied grade is a contract for the article-code
        // range too. Never accept a manually entered code whose prefix belongs
        // to another grade, even when the user selected the product's original
        // grade again.
        if (articleCodeWasManuallyChanged && !String(articleCode).startsWith(targetPrefix)) {
          return res.status(400).json({
            message: `Article code for grade ${grade} must start with ${targetPrefix}`,
          });
        }

        const needsGeneratedArticleCode = gradeChanged && !articleCodeWasManuallyChanged;

        // A grade change with an untouched article code gets a fresh unique
        // code in the new grade range. This keeps grade durable because the
        // product grade is encoded in its article-code prefix.
        if (needsGeneratedArticleCode) {
          const [maxResult] = await db
            .select({
              maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${factoryBaleProducts.articleCode} FROM 6) AS INTEGER)), 0)`,
            })
            .from(factoryBaleProducts)
            .where(
              and(
                eq(factoryBaleProducts.companyId, companyId),
                sql`${factoryBaleProducts.articleCode} LIKE ${targetPrefix + "%"}`,
                sql`SUBSTRING(${factoryBaleProducts.articleCode} FROM 6) ~ '^[0-9]+$'`
              )
            );

          let nextNum = (maxResult?.maxNum || 0) + 1;
          let attempts = 0;
          while (attempts < 200) {
            const candidate = `${targetPrefix}${String(nextNum).padStart(3, "0")}`;
            const candidateCode = candidate
              .replace(/[^a-zA-Z0-9]/g, "")
              .toUpperCase()
              .substring(0, 50);
            const [articleConflict] = await db
              .select({ id: factoryBaleProducts.id })
              .from(factoryBaleProducts)
              .where(
                and(
                  eq(factoryBaleProducts.companyId, companyId),
                  eq(factoryBaleProducts.articleCode, candidate),
                  sql`${factoryBaleProducts.id} != ${id}`
                )
              );
            const [codeConflict] = await db
              .select({ id: factoryBaleProducts.id })
              .from(factoryBaleProducts)
              .where(
                and(
                  eq(factoryBaleProducts.companyId, companyId),
                  eq(factoryBaleProducts.code, candidateCode),
                  sql`${factoryBaleProducts.id} != ${id}`
                )
              );
            if (!articleConflict && !codeConflict) {
              nextArticleCode = candidate;
              generatedArticleCode = true;
              break;
            }
            nextNum++;
            attempts++;
          }

          if (!generatedArticleCode) {
            return res.status(409).json({ message: "A product with this article code already exists" });
          }
        }
      }

      // If article code is being changed, verify it isn't already taken by another product
      if (nextArticleCode !== undefined && nextArticleCode !== existing.articleCode) {
        const [conflict] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              eq(factoryBaleProducts.articleCode, nextArticleCode),
              sql`${factoryBaleProducts.id} != ${id}`
            )
          );
        if (conflict) {
          return res.status(400).json({ message: "A product with this article code already exists" });
        }
      }

      // Check price input before persisting; malformed values must not be silently converted to zero.
      for (const [field, price] of [
        ["Cost price", productionPrice],
        ["Selling price", sellingPrice],
      ] as const) {
        if (price !== undefined && price !== "") {
          if (
            (typeof price !== "string" && typeof price !== "number") ||
            !Number.isFinite(Number(price)) ||
            Number(price) < 0 ||
            String(price).trim() === ""
          ) {
            return res.status(400).json({ message: `${field} must be a valid non-negative number` });
          }
        }
      }

      // Only a genuine label-color change requires elevated permissions. A
      // legacy edit form may resend a null color during an unrelated price edit.
      if (labelDesignColor !== undefined && (labelDesignColor || null) !== (existing.labelDesignColor ?? null)) {
        const userRole = req.user?.role || "";
        if (!["Admin", "Owner", "Developer"].includes(userRole)) {
          return res.status(403).json({ message: "Only administrators can change the label design color" });
        }
      }

      const productUpdate: Partial<typeof factoryBaleProducts.$inferInsert> = { updatedAt: new Date() };
      if (name !== undefined) productUpdate.name = name;
      if (weightPerBaleKg !== undefined)
        productUpdate.weightPerBaleKg = weightPerBaleKg == null ? null : String(weightPerBaleKg);
      if (nextArticleCode !== undefined) productUpdate.articleCode = nextArticleCode;
      if (generatedArticleCode && nextArticleCode) {
        productUpdate.code = nextArticleCode
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase()
          .substring(0, 50);
      }
      if (description !== undefined) productUpdate.description = description;
      if (categoryId !== undefined) productUpdate.categoryId = categoryId;
      if (productionPrice !== undefined && productionPrice !== "")
        productUpdate.productionPrice = String(toMoney(productionPrice).toNumber());
      if (sellingPrice !== undefined && sellingPrice !== "")
        productUpdate.sellingPrice = String(toMoney(sellingPrice).toNumber());
      if (labelDesignColor !== undefined) productUpdate.labelDesignColor = labelDesignColor || null;

      const [updatedProduct] = await db
        .update(factoryBaleProducts)
        .set(productUpdate)
        .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)))
        .returning();

      const baleUpdate: Partial<typeof factoryBales.$inferInsert> = {};
      if (name !== undefined && name !== existing.name) baleUpdate.productName = name;
      if (
        weightPerBaleKg !== undefined &&
        weightPerBaleKg !== null &&
        Number(weightPerBaleKg) !== (existing.weightPerBaleKg == null ? null : Number(existing.weightPerBaleKg))
      ) {
        baleUpdate.weightKg = String(weightPerBaleKg);
      }
      if (nextArticleCode !== undefined && nextArticleCode !== existing.articleCode)
        baleUpdate.articleCode = nextArticleCode;
      if (grade !== undefined && grade !== existingGrade) baleUpdate.grade = grade;

      let balesUpdated = 0;
      if (Object.keys(baleUpdate).length > 0) {
        baleUpdate.updatedAt = new Date();
        const result = await db
          .update(factoryBales)
          .set(baleUpdate)
          .where(and(eq(factoryBales.productId, id), eq(factoryBales.companyId, companyId)));
        balesUpdated = result.rowCount ?? 0;
      }

      res.json({ product: updatedProduct, balesUpdated });
    } catch (error: unknown) {
      logger.error("Error cascade updating bale product:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
