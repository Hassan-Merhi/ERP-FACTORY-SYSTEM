/**
 * factoryProductsRoutes: FactoryProductWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { verifySupervisorPassword } from "../_helpers";
import { factoryBaleProducts, users, userCompanyRoles } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { highestArticleNumber, pickEditableProductFields, productWriteFailure } from "./productWriteHelpers";

export function registerFactoryProductWriteRoutes(app: Express) {
  app.post("/api/factory/bale-products", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const callerRole = req.user?.role || "";
      const isPrivileged = ["Admin", "Owner", "Developer"].includes(callerRole);
      if (!isPrivileged) {
        const { adminAuth } = req.body;
        if (!adminAuth?.username || !adminAuth?.password) {
          return res.status(403).json({ message: "Admin authorization required to create products" });
        }
        const [adminUser] = await db.select().from(users).where(eq(users.username, adminAuth.username));
        if (!adminUser || !adminUser.active) {
          return res.status(403).json({ message: "Invalid admin credentials" });
        }
        const passwordValid = await verifySupervisorPassword(adminAuth.password, adminUser.password);
        if (!passwordValid) {
          return res.status(403).json({ message: "Invalid admin credentials" });
        }
        const [adminRole] = await db
          .select()
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.userId, adminUser.id), eq(userCompanyRoles.companyId, companyId)));
        if (!adminRole || !["Admin", "Owner", "Developer"].includes(adminRole.role)) {
          return res.status(403).json({ message: "The provided user does not have admin access to this company" });
        }
      }

      let code = req.body.code;
      let articleCode = req.body.articleCode;
      const grade = req.body.grade;
      if (articleCode != null && typeof articleCode !== "string") {
        return res.status(400).json({ message: "articleCode must be text", code: "PRODUCT_INVALID" });
      }

      const gradeToPrefix: Record<string, string> = {
        CREAM: "HMD10",
        "#1": "HMD11",
        "#2": "HMD12",
        "#3": "HMD13",
        "#4": "HMD14",
        Garbage: "HMD16",
      };

      if (!articleCode && grade && gradeToPrefix[grade]) {
        const prefix = gradeToPrefix[grade];
        let nextNum = (await highestArticleNumber(companyId, prefix)) + 1;
        let candidateCode = `${prefix}${String(nextNum).padStart(3, "0")}`;
        let attempts = 0;
        while (attempts < 100) {
          const candidateCodeClean = candidateCode
            .replace(/[^a-zA-Z0-9]/g, "")
            .toUpperCase()
            .substring(0, 50);
          const [dupArticle] = await db
            .select({ id: factoryBaleProducts.id })
            .from(factoryBaleProducts)
            .where(
              and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, candidateCode))
            );
          const [dupCode] = await db
            .select({ id: factoryBaleProducts.id })
            .from(factoryBaleProducts)
            .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.code, candidateCodeClean)));
          if (!dupArticle && !dupCode) break;
          nextNum++;
          candidateCode = `${prefix}${String(nextNum).padStart(3, "0")}`;
          attempts++;
        }
        articleCode = candidateCode;
      } else if (!articleCode) {
        const noGradePrefix = "HMD00";
        let noGradeNext = (await highestArticleNumber(companyId, noGradePrefix)) + 1;
        articleCode = `${noGradePrefix}${String(noGradeNext).padStart(3, "0")}`;
        let noGradeAttempts = 0;
        while (noGradeAttempts < 100) {
          const [dupCheck] = await db
            .select({ id: factoryBaleProducts.id })
            .from(factoryBaleProducts)
            .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, articleCode)));
          if (!dupCheck) break;
          noGradeNext++;
          articleCode = `${noGradePrefix}${String(noGradeNext).padStart(3, "0")}`;
          noGradeAttempts++;
        }
      }

      if (articleCode) {
        // Helper: check both articleCode AND code uniqueness within the company
        const codeClean = articleCode
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase()
          .substring(0, 50);
        const [existingArticle] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, articleCode)));
        const [existingCode] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.code, codeClean)));

        if (existingArticle || existingCode) {
          // Either articleCode or code is already taken — try to regenerate from the grade prefix
          const knownPrefixes = ["HMD10", "HMD11", "HMD12", "HMD13", "HMD14", "HMD16"];
          const matchedPrefix = knownPrefixes.find(
            (p) => articleCode.startsWith(p) && /^\d+$/.test(articleCode.slice(p.length))
          );
          if (matchedPrefix) {
            const prefix = matchedPrefix;
            let nextNum = (await highestArticleNumber(companyId, prefix)) + 1;
            let candidateCode = `${prefix}${String(nextNum).padStart(3, "0")}`;
            let attempts = 0;
            while (attempts < 200) {
              const candidateCodeClean = candidateCode
                .replace(/[^a-zA-Z0-9]/g, "")
                .toUpperCase()
                .substring(0, 50);
              const [dupA] = await db
                .select({ id: factoryBaleProducts.id })
                .from(factoryBaleProducts)
                .where(
                  and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, candidateCode))
                );
              const [dupC] = await db
                .select({ id: factoryBaleProducts.id })
                .from(factoryBaleProducts)
                .where(
                  and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.code, candidateCodeClean))
                );
              if (!dupA && !dupC) break;
              nextNum++;
              candidateCode = `${prefix}${String(nextNum).padStart(3, "0")}`;
              attempts++;
            }
            articleCode = candidateCode;
            code = articleCode
              .replace(/[^a-zA-Z0-9]/g, "")
              .toUpperCase()
              .substring(0, 50);
          } else {
            return res.status(400).json({ message: "A product with this article code already exists" });
          }
        } else {
          // Both are free — use the cleaned code
          code = codeClean;
        }
      }

      // Reject duplicate names (case-insensitive) within same company
      const nameToCheck = (req.body.name || "").trim();
      if (nameToCheck) {
        const [nameDup] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              sql`LOWER(${factoryBaleProducts.name}) = LOWER(${nameToCheck})`
            )
          );
        if (nameDup) {
          return res.status(400).json({ message: `A product named "${nameToCheck}" already exists` });
        }
      }

      // Build explicit insert values (bypasses drizzle-zod coercion issues)
      const buildInsertValues = (ac: string, c: string): typeof factoryBaleProducts.$inferInsert => {
        const v: typeof factoryBaleProducts.$inferInsert = {
          companyId,
          code: c,
          articleCode: ac || null,
          name: (req.body.name || "").trim(),
          active: req.body.active !== undefined ? Boolean(req.body.active) : true,
        };
        if (req.body.description != null && req.body.description !== "") v.description = String(req.body.description);
        if (req.body.weightPerBaleKg != null && req.body.weightPerBaleKg !== "")
          v.weightPerBaleKg = String(req.body.weightPerBaleKg);
        if (req.body.categoryId != null) v.categoryId = parseInt(String(req.body.categoryId));
        if (req.body.sellingPrice != null && req.body.sellingPrice !== "")
          v.sellingPrice = String(req.body.sellingPrice);
        if (req.body.productionPrice != null && req.body.productionPrice !== "")
          v.productionPrice = String(req.body.productionPrice);
        if (req.body.labelDesignColor != null && req.body.labelDesignColor !== "")
          v.labelDesignColor = String(req.body.labelDesignColor);
        return v;
      };

      // Try insert; if code/articleCode constraint fires (race condition),
      // keep incrementing the numeric suffix until we find a free slot.
      let product: unknown;
      const knownPrefixesRetry = ["HMD10", "HMD11", "HMD12", "HMD13", "HMD14", "HMD16", "HMD00"];
      const retryPrefix = knownPrefixesRetry.find(
        (p) => articleCode.startsWith(p) && /^\d+$/.test(articleCode.slice(p.length))
      );
      let retryAttempts = 0;
      while (true) {
        try {
          [product] = await db.insert(factoryBaleProducts).values(buildInsertValues(articleCode, code)).returning();
          break;
        } catch (insertErr: unknown) {
          // DrizzleQueryError wraps the real pg error in .cause
          const insertErrObj = insertErr as { cause?: { message?: string }; message?: string };
          const causeMsg: string = insertErrObj.cause?.message || "";
          const msg: string = insertErrObj.message || "";
          const combined = causeMsg + msg;
          const isCodeDup = combined.includes("unique") || combined.includes("duplicate");
          if (!isCodeDup || !retryPrefix || retryAttempts >= 100) throw insertErr;
          retryAttempts++;
          const currentNum = parseInt(articleCode.slice(retryPrefix.length)) || 0;
          const nextCandidate = `${retryPrefix}${String(currentNum + 1).padStart(3, "0")}`;
          articleCode = nextCandidate;
          code = articleCode
            .replace(/[^a-zA-Z0-9]/g, "")
            .toUpperCase()
            .substring(0, 50);
        }
      }
      res.json(product);
    } catch (error: unknown) {
      logger.error("Error creating factory bale product:", { error });
      const failure = productWriteFailure(error);
      res.status(failure.status).json(failure.body);
    }
  });

  app.patch("/api/factory/bale-products/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { fields, rejected } = pickEditableProductFields(req.body);
      if (rejected.length > 0) {
        return res.status(400).json({
          message: `These product fields cannot be edited: ${rejected.join(", ")}`,
          code: "PRODUCT_FIELD_NOT_EDITABLE",
        });
      }
      const [updated] = await db
        .update(factoryBaleProducts)
        .set({ ...fields, updatedAt: new Date() })
        .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Product not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating factory bale product:", { error: error });
      const failure = productWriteFailure(error);
      res.status(failure.status).json(failure.body);
    }
  });
}
