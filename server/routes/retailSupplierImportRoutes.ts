import type { Express } from "express";
import { requireAuth, requireNonPOS } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  previewRetailSupplierCatalog,
  retailSupplierCatalogPreviewRowsSchema,
} from "../services/retail/retailSupplierCatalogPreview";
import { describeRetailSupplierBarcode } from "../services/retail/retailSupplierBarcodeIntake";
import { postRetailSupplierPurchase } from "../services/retail/retailSupplierPurchaseService";
import {
  listRetailSupplierPurchases,
  getRetailSupplierPurchaseDetail,
  findRetailSupplierPurchaseByRequest,
} from "../services/retail/retailSupplierPurchaseHistory";
import { requireRetailCompany } from "./retailCompanyGuard";

/**
 * Retail supplier stock import routes (split out of retailRoutes.ts, which
 * registers them first so the route order is unchanged).
 */
export function registerRetailSupplierImportRoutes(app: Express) {
  // Supplier purchase history is read-only, company scoped, and never derives
  // balances from a duplicate source of truth. All amounts come from posted
  // retail purchase records and their central voucher IDs.
  app.get("/api/retail/supplier-import/history", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const supplierId = req.query.supplierId ? Number(req.query.supplierId) : undefined;
      if (supplierId !== undefined && (!Number.isSafeInteger(supplierId) || supplierId < 1)) {
        return res.status(400).json({ message: "Invalid supplier filter" });
      }
      const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 10000
      ) {
        return res.status(400).json({ message: "Invalid history pagination" });
      }
      const query = typeof req.query.query === "string" ? req.query.query : "";
      res.set("Cache-Control", "no-store");
      return res.json(await listRetailSupplierPurchases(companyId, { supplierId, query, limit, offset }));
    } catch (error) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/supplier-import/history/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const operationId = Number(req.params.id);
      if (!Number.isSafeInteger(operationId) || operationId < 1) {
        return res.status(400).json({ message: "Invalid supplier receipt ID" });
      }
      const result = await getRetailSupplierPurchaseDetail(companyId, operationId);
      if (!result) return res.status(404).json({ message: "Supplier receipt not found" });
      res.set("Cache-Control", "no-store");
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // An interrupted client can safely check whether its confirmed purchase
  // committed. This is read-only and never reissues barcode sequences.
  app.get("/api/retail/supplier-import/requests/:key", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const key = String(req.params.key ?? "").trim();
      if (!key || key.length > 191) return res.status(400).json({ message: "Invalid request ID" });
      const result = await findRetailSupplierPurchaseByRequest(companyId, key);
      if (!result) return res.status(404).json({ message: "No committed purchase for this request ID" });
      res.set("Cache-Control", "no-store");
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Supplier stock is NEVER passed through the legacy absolute-quantity bulk import.
  app.post("/api/retail/supplier-import/confirm", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const actor = { userId: String(req.user!.id), username: req.user?.username ?? null };
      const result = await postRetailSupplierPurchase(companyId, actor, req.body);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(/already|conflict|does not reconcile|changed during/i.test(message) ? 409 : 400).json({ message });
    }
  });

  // Phase 2: company-scoped catalog reconciliation. Read-only by design:
  // supplier inventory and payable must be posted atomically in Phase 4.
  app.post("/api/retail/supplier-import/catalog-preview", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const rows = retailSupplierCatalogPreviewRowsSchema.parse(req.body?.rows);
      const preview = await previewRetailSupplierCatalog(companyId, rows);
      const barcodePlans = rows.map((row, i) => ({
        rowNumber: row.rowNumber,
        ...describeRetailSupplierBarcode(row, preview.decisions[i]),
      }));
      // "generate" is explicitly a promise for confirmation, not a reserved
      // number: preview must never consume the company's EAN-13 sequence.
      res.set("Cache-Control", "no-store");
      return res.json({ ...preview, barcodePlans });
    } catch (error) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
