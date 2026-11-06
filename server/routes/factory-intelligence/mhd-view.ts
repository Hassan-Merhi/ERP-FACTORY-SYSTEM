/** Company-scoped, display-only product aliases and ordering for Factory MHD View. */
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { eq, sql } from "drizzle-orm";
import { requireRole } from "../../auth";
import { factorySettings } from "@shared/schema";
import { INITIAL_FACTORY_FEATURES } from "./settings";
import { getErrorMessage } from "../../lib/httpHandlers";

type ViewRow = { articleCode: string; itemName: string; sortOrder: number };
type ViewSnapshot = { revision: number; rows: ViewRow[]; updatedAt: string };
type MhdView = ViewSnapshot & { history: ViewSnapshot[] };
type ProductRow = { id: number; articleCode: string; name: string };

const normalizeCode = (code: string) => code.trim().toUpperCase();
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const companyFor = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId);

function readView(extra: unknown): MhdView {
  const raw = isObject(extra) ? extra.mhdView : null;
  if (!isObject(raw)) return { revision: 0, rows: [], updatedAt: "", history: [] };
  const rows = Array.isArray(raw.rows) ? raw.rows.filter((item): item is ViewRow =>
    isObject(item) && typeof item.articleCode === "string" &&
    typeof item.itemName === "string" && Number.isSafeInteger(item.sortOrder)) : [];
  const history = Array.isArray(raw.history) ? raw.history.filter((item): item is ViewSnapshot =>
    isObject(item) && Number.isSafeInteger(item.revision) &&
    typeof item.updatedAt === "string" && Array.isArray(item.rows)).slice(-5) : [];
  return {
    revision: Number.isSafeInteger(raw.revision) ? Number(raw.revision) : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    rows,
    history,
  };
}

async function companyProducts(db: AppDb, companyId: number): Promise<ProductRow[]> {
  const raw = await db.execute(sql`
    SELECT id, article_code AS "articleCode", name
      FROM factory_bale_products
     WHERE company_id = ${companyId} AND deleted_at IS NULL AND active = TRUE
     ORDER BY name, id
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as Array<Record<string, unknown>>;
  return rows.filter((row) => typeof row.articleCode === "string" && String(row.articleCode).trim()).map((row) => ({
    id: Number(row.id),
    articleCode: String(row.articleCode).trim(),
    name: String(row.name ?? ""),
  }));
}

export function registerFactoryMhdViewRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  app.get("/api/factory/mhd-view", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyFor(req);
    if (!Number.isSafeInteger(companyId) || companyId <= 0) return res.status(400).json({ message: "No Factory company selected" });
    try {
      const [settings, products] = await Promise.all([
        db.select({ extraSettings: factorySettings.extraSettings }).from(factorySettings)
          .where(eq(factorySettings.companyId, companyId)).limit(1),
        companyProducts(db, companyId),
      ]);
      res.set("Cache-Control", "private, no-store");
      return res.json({
        ...readView(settings[0]?.extraSettings),
        products,
        canEdit: ["Admin", "Owner", "Developer"].includes(String(req.user?.role ?? "")),
      });
    } catch (error) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/factory/mhd-view", requireAuth, requireRole("Admin", "Owner"), async (req: Request, res: Response) => {
    const companyId = companyFor(req);
    if (!Number.isSafeInteger(companyId) || companyId <= 0) return res.status(400).json({ message: "No Factory company selected" });
    const input: unknown = req.body?.rows;
    const expectedRevision: unknown = req.body?.expectedRevision;
    if (!Array.isArray(input) || input.length > 10000 || !Number.isSafeInteger(expectedRevision)) {
      return res.status(400).json({ message: "Expected ordered rows and a valid revision" });
    }

    const seen = new Set<string>();
    const requested: Array<{ articleCode: string; itemName: string }> = [];
    for (const item of input) {
      if (!isObject(item) || typeof item.articleCode !== "string" ||
          typeof item.itemName !== "string" || item.itemName.length > 250 ||
          !item.articleCode.trim() || item.articleCode.length > 150) {
        return res.status(400).json({ message: "Each row requires an article code and optional item name" });
      }
      const code = normalizeCode(item.articleCode);
      if (seen.has(code)) return res.status(400).json({ message: "Duplicate article code: " + code });
      seen.add(code);
      requested.push({ articleCode: code, itemName: item.itemName.trim() });
    }

    try {
      const products = await companyProducts(db, companyId);
      const known = new Map<string, ProductRow>();
      const ambiguous = new Set<string>();
      for (const product of products) {
        const code = normalizeCode(product.articleCode);
        if (known.has(code)) ambiguous.add(code);
        else known.set(code, product);
      }
      const unknown = requested.filter((row) => !known.has(row.articleCode) || ambiguous.has(row.articleCode));
      if (unknown.length) return res.status(400).json({
        message: "Unknown or ambiguous Factory article codes",
        articleCodes: unknown.slice(0, 50).map((row) => row.articleCode),
      });
      const rows: ViewRow[] = requested.map((item, index) => ({
        articleCode: known.get(item.articleCode)!.articleCode,
        itemName: item.itemName,
        sortOrder: index,
      }));
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(650741, ${companyId})`);
        await tx.insert(factorySettings).values({ companyId, ...INITIAL_FACTORY_FEATURES }).onConflictDoNothing();
        const [current] = await tx.select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings).where(eq(factorySettings.companyId, companyId)).for("update");
        const prior = readView(current?.extraSettings);
        if (prior.revision !== expectedRevision) return null;
        const history = prior.revision > 0
          ? [...prior.history, { revision: prior.revision, rows: prior.rows, updatedAt: prior.updatedAt }].slice(-5)
          : [];
        const next: MhdView = { rows, revision: prior.revision + 1, updatedAt: new Date().toISOString(), history };
        await tx.update(factorySettings).set({
          extraSettings: sql`COALESCE(${factorySettings.extraSettings}, '{}'::jsonb) || ${JSON.stringify({ mhdView: next })}::jsonb`,
        }).where(eq(factorySettings.companyId, companyId));
        return next;
      });
      if (!result) return res.status(409).json({ message: "MHD View was updated by someone else. Reload and retry." });
      res.set("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
