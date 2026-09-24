import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import type { Express, Request } from "express";
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { factoryBaleProducts, factoryCategories } from "@shared/schema/factoryTrilingualCatalogTables";
import { resolveFactoryCategoryName, resolveFactoryProductLanguage } from "@shared/factoryBilingualContract";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";

function factoryCompanyId(req: Request): number | null {
  const value = Number(req.session?.factoryCompanyId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isFrenchRequest(req: Request): boolean {
  const header = req.headers["x-factory-catalog-language"];
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  return req.query.lang === "fr" || header === "fr" || /(?:^|;\s*)factory_catalog_language=fr(?:;|$)/.test(cookie);
}

function accessError(res: import("express").Response) {
  return res.status(403).json({
    message: "You do not have access to the selected Factory company.",
    code: "FACTORY_COMPANY_ACCESS_REQUIRED",
  });
}

export function registerFactoryFrenchCatalogReadRoutes(app: Express): void {
  app.get("/api/factory/categories", requireAuth, async (req, res, next) => {
    if (!isFrenchRequest(req)) return next();
    try {
      const companyId = factoryCompanyId(req);
      if (!companyId) return accessError(res);
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const filters = [eq(factoryCategories.companyId, companyId), isNull(factoryCategories.deletedAt)];
      if (query) {
        filters.push(
          or(
            punctuationInsensitiveSearch(factoryCategories.name, query),
            punctuationInsensitiveSearch(factoryCategories.nameAr, query),
            punctuationInsensitiveSearch(factoryCategories.nameFr, query)
          )!
        );
      }
      const rows = await db
        .select()
        .from(factoryCategories)
        .where(and(...filters))
        .orderBy(asc(factoryCategories.name));
      return res.json(
        rows.map((category) => ({
          ...category,
          nameEn: category.name,
          displayName: resolveFactoryCategoryName(category, "fr"),
          language: "fr",
        }))
      );
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bale-products", requireAuth, async (req, res, next) => {
    if (!isFrenchRequest(req)) return next();
    try {
      const companyId = factoryCompanyId(req);
      if (!companyId) return accessError(res);
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const filters = [eq(factoryBaleProducts.companyId, companyId), isNull(factoryBaleProducts.deletedAt)];
      if (query) {
        filters.push(
          or(
            punctuationInsensitiveSearch(factoryBaleProducts.articleCode, query),
            punctuationInsensitiveSearch(factoryBaleProducts.name, query),
            punctuationInsensitiveSearch(factoryBaleProducts.nameAr, query),
            punctuationInsensitiveSearch(factoryBaleProducts.nameFr, query),
            punctuationInsensitiveSearch(factoryBaleProducts.description, query),
            punctuationInsensitiveSearch(factoryBaleProducts.descriptionAr, query),
            punctuationInsensitiveSearch(factoryBaleProducts.descriptionFr, query),
            punctuationInsensitiveSearch(factoryCategories.name, query),
            punctuationInsensitiveSearch(factoryCategories.nameAr, query),
            punctuationInsensitiveSearch(factoryCategories.nameFr, query)
          )!
        );
      }
      const rows = await db
        .select({
          product: factoryBaleProducts,
          categoryName: factoryCategories.name,
          categoryNameAr: factoryCategories.nameAr,
          categoryNameFr: factoryCategories.nameFr,
        })
        .from(factoryBaleProducts)
        .leftJoin(
          factoryCategories,
          and(
            eq(factoryCategories.id, factoryBaleProducts.categoryId),
            eq(factoryCategories.companyId, companyId),
            isNull(factoryCategories.deletedAt)
          )
        )
        .where(and(...filters))
        .orderBy(asc(factoryBaleProducts.id));

      return res.json(
        rows.map(({ product, categoryName, categoryNameAr, categoryNameFr }) => {
          const resolved = resolveFactoryProductLanguage(
            { ...product, categoryName, categoryNameAr, categoryNameFr },
            "fr"
          );
          return {
            ...product,
            nameEn: product.name,
            descriptionEn: product.description,
            categoryName,
            categoryNameAr,
            categoryNameFr,
            displayName: resolved.name,
            displayDescription: resolved.description,
            displayCategoryName: resolved.categoryName,
            language: "fr",
          };
        })
      );
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bale-products/:id", requireAuth, async (req, res, next) => {
    if (!isFrenchRequest(req)) return next();
    try {
      const companyId = factoryCompanyId(req);
      const id = Number(req.params.id);
      if (!companyId) return accessError(res);
      if (!Number.isSafeInteger(id) || id <= 0) return next();
      const [row] = await db
        .select({
          product: factoryBaleProducts,
          categoryName: factoryCategories.name,
          categoryNameAr: factoryCategories.nameAr,
          categoryNameFr: factoryCategories.nameFr,
        })
        .from(factoryBaleProducts)
        .leftJoin(
          factoryCategories,
          and(
            eq(factoryCategories.id, factoryBaleProducts.categoryId),
            eq(factoryCategories.companyId, companyId),
            isNull(factoryCategories.deletedAt)
          )
        )
        .where(
          and(
            eq(factoryBaleProducts.id, id),
            eq(factoryBaleProducts.companyId, companyId),
            isNull(factoryBaleProducts.deletedAt)
          )
        )
        .limit(1);
      if (!row) return res.status(404).json({ message: "Product not found" });
      const resolved = resolveFactoryProductLanguage(
        {
          ...row.product,
          categoryName: row.categoryName,
          categoryNameAr: row.categoryNameAr,
          categoryNameFr: row.categoryNameFr,
        },
        "fr"
      );
      return res.json({
        ...row.product,
        nameEn: row.product.name,
        descriptionEn: row.product.description,
        categoryName: row.categoryName,
        categoryNameAr: row.categoryNameAr,
        categoryNameFr: row.categoryNameFr,
        displayName: resolved.name,
        displayDescription: resolved.description,
        displayCategoryName: resolved.categoryName,
        language: "fr",
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
