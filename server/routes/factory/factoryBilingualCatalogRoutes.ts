import type { Express, Request } from "express";
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { factoryBaleProducts, factoryCategories } from "@shared/schema";
import {
  parseFactoryCatalogLanguage,
  resolveFactoryCategoryName,
  resolveFactoryProductLanguage,
  type FactoryCatalogLanguage,
} from "@shared/factoryBilingualContract";
import {
  mapFactoryLegacyProductEdit,
  suppressUnchangedFactoryArabicFallbacks,
} from "@shared/factoryBilingualCatalogPresentation";
import { registerFactoryArabicTranslationRoutes } from "./factoryArabicTranslationRoutes";

const LANGUAGE_COOKIE = "factory_catalog_language";

function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function getRequestLanguage(req: import("express").Request): FactoryCatalogLanguage {
  return parseFactoryCatalogLanguage(
    req.query?.lang ?? req.headers?.["x-factory-catalog-language"] ?? readCookie(req.headers?.cookie, LANGUAGE_COOKIE),
    "en"
  );
}

function getFactoryCompanyId(req: Request): number | null {
  const companyId = Number(req.session?.factoryCompanyId);
  return Number.isSafeInteger(companyId) && companyId > 0 ? companyId : null;
}

function mapCategory(category: typeof factoryCategories.$inferSelect, language: FactoryCatalogLanguage) {
  return {
    ...category,
    nameEn: category.name,
    nameAr: category.nameAr,
    displayName: resolveFactoryCategoryName(category, language),
    language,
  };
}

function sendFactoryCompanyAccessError(res: import("express").Response) {
  return res.status(403).json({
    message: "You do not have access to the selected Factory company.",
    code: "FACTORY_COMPANY_ACCESS_REQUIRED",
  });
}

async function sendCategories(req: import("express").Request, res: import("express").Response, companyId: number) {
  const language = getRequestLanguage(req);
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [eq(factoryCategories.companyId, companyId), isNull(factoryCategories.deletedAt)];
  if (query)
    filters.push(or(ilike(factoryCategories.name, `%${query}%`), ilike(factoryCategories.nameAr, `%${query}%`))!);

  const results = await db
    .select()
    .from(factoryCategories)
    .where(and(...filters))
    .orderBy(asc(factoryCategories.name));
  return res.json(results.map((category) => mapCategory(category, language)));
}

async function sendProducts(req: import("express").Request, res: import("express").Response, companyId: number) {
  const language = getRequestLanguage(req);
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [eq(factoryBaleProducts.companyId, companyId), isNull(factoryBaleProducts.deletedAt)];
  if (query) {
    filters.push(
      or(
        ilike(factoryBaleProducts.articleCode, `%${query}%`),
        ilike(factoryBaleProducts.name, `%${query}%`),
        ilike(factoryBaleProducts.nameAr, `%${query}%`),
        ilike(factoryBaleProducts.description, `%${query}%`),
        ilike(factoryBaleProducts.descriptionAr, `%${query}%`),
        ilike(factoryCategories.name, `%${query}%`),
        ilike(factoryCategories.nameAr, `%${query}%`)
      )!
    );
  }

  const rows = await db
    .select({
      product: factoryBaleProducts,
      categoryName: factoryCategories.name,
      categoryNameAr: factoryCategories.nameAr,
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
    rows.map(({ product, categoryName, categoryNameAr }) => {
      const resolved = resolveFactoryProductLanguage({ ...product, categoryName, categoryNameAr }, language);
      return {
        ...product,
        nameEn: product.name,
        nameAr: product.nameAr,
        descriptionEn: product.description,
        descriptionAr: product.descriptionAr,
        categoryName,
        categoryNameAr,
        displayName: resolved.name,
        displayDescription: resolved.description,
        displayCategoryName: resolved.categoryName,
        language,
      };
    })
  );
}

async function sendProductDetail(
  req: import("express").Request,
  res: import("express").Response,
  companyId: number,
  id: number
) {
  const language = getRequestLanguage(req);
  const [row] = await db
    .select({
      product: factoryBaleProducts,
      categoryName: factoryCategories.name,
      categoryNameAr: factoryCategories.nameAr,
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
    .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)))
    .limit(1);

  if (!row) return res.status(404).json({ message: "Product not found" });
  const resolved = resolveFactoryProductLanguage(
    { ...row.product, categoryName: row.categoryName, categoryNameAr: row.categoryNameAr },
    language
  );
  return res.json({
    ...row.product,
    nameEn: row.product.name,
    nameAr: row.product.nameAr,
    descriptionEn: row.product.description,
    descriptionAr: row.product.descriptionAr,
    categoryName: row.categoryName,
    categoryNameAr: row.categoryNameAr,
    displayName: resolved.name,
    displayDescription: resolved.description,
    displayCategoryName: resolved.categoryName,
    language,
  });
}

async function applyDeferredProductArabic(
  req: import("express").Request,
  payload: unknown,
  deferred: { nameAr?: string | null; descriptionAr?: string | null },
  suppressFallbacks: boolean
) {
  const payloadObject = (payload ?? {}) as { product?: { id?: unknown } | null } & Record<string, unknown>;
  const current = payloadObject.product ?? payloadObject;
  const productId = Number(current?.id);
  const companyId = getFactoryCompanyId(req);
  if (!companyId || !Number.isSafeInteger(productId) || productId <= 0) return payload;

  const safe = suppressFallbacks ? suppressUnchangedFactoryArabicFallbacks(deferred, current) : deferred;
  if (safe.nameAr === undefined && safe.descriptionAr === undefined) return payload;

  const update: Partial<typeof factoryBaleProducts.$inferInsert> = { updatedAt: new Date() };
  if (safe.nameAr !== undefined) update.nameAr = safe.nameAr;
  if (safe.descriptionAr !== undefined) update.descriptionAr = safe.descriptionAr;

  const [product] = await db
    .update(factoryBaleProducts)
    .set(update)
    .where(
      and(
        eq(factoryBaleProducts.id, productId),
        eq(factoryBaleProducts.companyId, companyId),
        isNull(factoryBaleProducts.deletedAt)
      )
    )
    .returning();
  return product ? (payloadObject.product ? { ...payloadObject, product } : product) : payload;
}

function prepareMutation(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const method = req.method.toUpperCase();
  const path = req.path;
  const language = getRequestLanguage(req);
  let productArabic: { nameAr?: string | null; descriptionAr?: string | null } = {};
  let categoryNameAr: string | null | undefined;
  let suppressFallbacks = false;

  if (req.body && method === "POST" && path === "/bale-products") {
    if (typeof req.body.nameEn === "string" && req.body.nameEn.trim()) req.body.name = req.body.nameEn.trim();
    if (Object.prototype.hasOwnProperty.call(req.body, "nameAr"))
      productArabic.nameAr = typeof req.body.nameAr === "string" ? req.body.nameAr.trim() || null : null;
    if (Object.prototype.hasOwnProperty.call(req.body, "descriptionAr"))
      productArabic.descriptionAr =
        typeof req.body.descriptionAr === "string" ? req.body.descriptionAr.trim() || null : null;
    if (Object.prototype.hasOwnProperty.call(req.body, "descriptionEn"))
      req.body.description = typeof req.body.descriptionEn === "string" ? req.body.descriptionEn.trim() || null : null;
    delete req.body.nameEn;
    delete req.body.nameAr;
    delete req.body.descriptionEn;
    delete req.body.descriptionAr;
  } else if (req.body && method === "PATCH" && /^\/bale-products\/\d+$/.test(path)) {
    const mapped = mapFactoryLegacyProductEdit(req.body, language);
    req.body = mapped.body;
    productArabic = mapped.deferredArabic;
    suppressFallbacks = language === "ar";
  }

  if (
    req.body &&
    method === "POST" &&
    path === "/categories" &&
    Object.prototype.hasOwnProperty.call(req.body, "nameAr")
  ) {
    categoryNameAr = typeof req.body.nameAr === "string" ? req.body.nameAr.trim() || null : null;
    delete req.body.nameAr;
  } else if (req.body && method === "PATCH" && /^\/categories\/\d+$/.test(path)) {
    if (Object.prototype.hasOwnProperty.call(req.body, "nameAr")) {
      categoryNameAr = typeof req.body.nameAr === "string" ? req.body.nameAr.trim() || null : null;
      delete req.body.nameAr;
    } else if (language === "ar" && Object.prototype.hasOwnProperty.call(req.body, "name")) {
      categoryNameAr = typeof req.body.name === "string" ? req.body.name.trim() || null : null;
      delete req.body.name;
    }
  }

  const needsProduct = productArabic.nameAr !== undefined || productArabic.descriptionAr !== undefined;
  const needsCategory = categoryNameAr !== undefined;
  if (!needsProduct && !needsCategory) return next();

  const originalJson = res.json.bind(res);
  res.json = ((payload) => {
    void (async () => {
      let output = payload;
      if (needsProduct) output = await applyDeferredProductArabic(req, output, productArabic, suppressFallbacks);
      if (needsCategory) {
        const companyId = getFactoryCompanyId(req);
        const categoryId = Number(output?.id);
        if (companyId && Number.isSafeInteger(categoryId) && categoryId > 0) {
          const [category] = await db
            .update(factoryCategories)
            .set({ nameAr: categoryNameAr, updatedAt: new Date() })
            .where(
              and(
                eq(factoryCategories.id, categoryId),
                eq(factoryCategories.companyId, companyId),
                isNull(factoryCategories.deletedAt)
              )
            )
            .returning();
          if (category) output = category;
        }
      }
      originalJson(output);
    })().catch((error) => {
      logger.error("Factory bilingual catalog mutation mapping failed", { error, method, path });
      if (!res.headersSent) res.status(500);
      originalJson({ message: getErrorMessage(error) });
    });
    return res;
  }) as typeof res.json;
  return next();
}

async function factoryBilingualCatalogMiddleware(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  if (req.method !== "GET") return prepareMutation(req, res, next);
  if (req.query.legacy === "1") return next();

  const categoriesRequest = /^\/categories\/?$/.test(req.path);
  const productsRequest = /^\/bale-products\/?$/.test(req.path);
  const productDetailMatch = req.path.match(/^\/bale-products\/(\d+)\/?$/);
  if (!categoriesRequest && !productsRequest && !productDetailMatch) return next();

  try {
    const companyId = getFactoryCompanyId(req);
    if (!companyId) return sendFactoryCompanyAccessError(res);
    if (categoriesRequest) return await sendCategories(req, res, companyId);
    if (productsRequest) return await sendProducts(req, res, companyId);
    const id = Number(productDetailMatch?.[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return next();
    return await sendProductDetail(req, res, companyId, id);
  } catch (error: unknown) {
    logger.error("Error fetching bilingual Factory catalog", { error });
    return res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerFactoryBilingualCatalogRoutes(app: Express) {
  registerFactoryArabicTranslationRoutes(app);
  app.use("/api/factory", requireAuth, factoryBilingualCatalogMiddleware);
}
