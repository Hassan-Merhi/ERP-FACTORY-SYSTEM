import type { Express } from "express";
import { isValidIsoDate } from "../lib/requestValidation";
import { registerDaybookPaginationRoutes } from "./daybookPaginationRoutes";
import { registerSupplierPurchaseOrderPaginationRoutes } from "./vouchers/supplierPurchaseOrderPaginationRoutes";
import { registerVoucherPaginationRoutes } from "./vouchers/voucherPaginationRoutes";
import { registerVoucherQueryRoutes } from "./vouchers/voucherQueryRoutes";
import { registerVoucherCreateRoutes } from "./vouchers/voucherCreateRoutes";
import { registerVoucherPaymentRoutes } from "./vouchers/voucherPaymentRoutes";
import { registerCentralGenericVoucherCreateRoute } from "./vouchers/centralGenericVoucherCreateRoute";
import { registerCentralPaymentReceiptCreateRoute } from "./vouchers/centralPaymentReceiptCreateRoute";
import { registerVoucherExactReversalRoute } from "./vouchers/voucherExactReversalRoute";
import { registerCentralPaymentReceiptLifecycleRoutes } from "./vouchers/centralPaymentReceiptLifecycleRoute";
import { registerGoldenCoastPosSettlementDeleteRoute } from "./vouchers/goldenCoastPosSettlementDeleteRoute";
import { registerCentralPaymentReceiptDeleteRoute } from "./vouchers/centralPaymentReceiptDeleteRoute";
import { registerCentralJournalCreateRoute } from "./vouchers/centralJournalCreateRoute";
import { registerCentralJournalLifecycleRoutes } from "./vouchers/centralJournalLifecycleRoute";
import { registerCentralStockTransferDeleteRoutes } from "./vouchers/centralStockTransferDeleteRoute";
import { registerExactStockAdjustmentLifecycleRoutes } from "./vouchers/exactStockAdjustmentLifecycleRoute";
import { registerVoucherJournalRoutes } from "./vouchers/voucherJournalRoutes";
import { registerVoucherSalesUpdateRoutes } from "./vouchers/sales-update";
import { registerVoucherPurchaseUpdateRoutes } from "./vouchers/voucherPurchaseUpdateRoutes";
import { registerVoucherTransferRoutes } from "./vouchers/transfer";
import { registerExactStockTransferEditRoute } from "./vouchers/exactStockTransferEditRoute";
import { registerSmartTransferPreviewRoutes } from "./vouchers/smartTransferPreviewRoutes";
import { registerStockTransferLifecycleRoutes } from "./vouchers/stockTransferLifecycleRoutes";
import { registerStockTransferRevisionLifecycleRoutes } from "./vouchers/stockTransferRevisionLifecycleRoutes";
import { registerImmutableStockTransferRevisionRoutes } from "./vouchers/immutableStockTransferRevisionRoutes";
import { registerAdminPostUpdateStockTransferRevisionRoute } from "./vouchers/adminPostUpdateStockTransferRevisionRoute";

function registerVoucherDetailCompatibility(app: Express) {
  app.get("/api/vouchers/:id", (_req, res, next) => {
    const sendJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body) && "transferData" in body && !("transfer" in body)) {
        const voucherDetail = body as Record<string, unknown>;
        return sendJson({
          ...voucherDetail,
          transfer: voucherDetail.transferData,
        });
      }

      return sendJson(body);
    }) as typeof res.json;

    next();
  });
}

function registerVoucherCreateDateValidation(app: Express): void {
  app.use(
    ["/api/vouchers/with-entries", "/api/vouchers/payment-receipt", "/api/vouchers/journal"],
    (req, res, next) => {
      if (req.method !== "POST" || !req.session?.userId) return next();

      const rawDate =
        req.baseUrl === "/api/vouchers/with-entries" ? req.body?.voucher?.voucherDate : req.body?.voucherDate;
      if (rawDate !== undefined && !isValidIsoDate(rawDate)) {
        return res.status(400).json({ message: "voucherDate must be a valid YYYY-MM-DD date" });
      }

      next();
    }
  );
}

export function registerVoucherRoutes(app: Express) {
  // The ERP Daybook uses one SQL-paged chronological union of vouchers and offloads.
  registerDaybookPaginationRoutes(app);

  // Supplier purchase-order reads follow the company-owned supplier model and
  // shadow the historical cross-company compatibility route below.
  registerSupplierPurchaseOrderPaginationRoutes(app);

  // Native SQL pagination shadows the legacy array reader while preserving its
  // array response for callers that do not explicitly request pagination.
  registerVoucherPaginationRoutes(app);

  // Stock adjustments reverse and reapply the exact persisted quantity/value.
  // Register before both the legacy adjustment editor and generic voucher delete.
  registerExactStockAdjustmentLifecycleRoutes(app);

  // Posted transfer edits use the exact persisted quantity/value lifecycle.
  // Draft/optional edits fall through to the dedicated save/finalize flow.
  registerExactStockTransferEditRoute(app);

  // Stock-transfer lifecycle routes must shadow the older direct transfer editor.
  registerStockTransferLifecycleRoutes(app);
  // The current admin editor writes the transfer first and then posts the
  // immutable revision snapshot. Accept that already-applied baseline before
  // the canonical stale guard; untouched and POS revisions still fall through.
  registerAdminPostUpdateStockTransferRevisionRoute(app);
  registerImmutableStockTransferRevisionRoutes(app);
  registerStockTransferRevisionLifecycleRoutes(app);

  // The daybook detail dialog reads `transfer`, while the canonical voucher
  // endpoint currently returns `transferData`. Preserve both keys so source and
  // destination locations render without changing existing API consumers.
  registerVoucherDetailCompatibility(app);
  registerVoucherQueryRoutes(app);

  // Validate date-shaped SQL inputs before they reach a driver cast. Keep this
  // behind an authenticated session so malformed unauthenticated requests still
  // receive the normal 401 from the route's auth middleware.
  registerVoucherCreateDateValidation(app);

  // Program 2 protected creation handlers call next() for unsupported legacy
  // compatibility shapes, so they must be registered before the old creators.
  registerCentralGenericVoucherCreateRoute(app);
  registerVoucherCreateRoutes(app);

  registerCentralPaymentReceiptCreateRoute(app);
  registerVoucherExactReversalRoute(app);
  registerCentralPaymentReceiptLifecycleRoutes(app);
  // Golden Coast POS cash settlements are normally programme-locked, but their
  // dedicated delete lifecycle must run before the generic mutation guard so a
  // manual cash-transfer delete and a POS cascade can remove the linked pair.
  registerGoldenCoastPosSettlementDeleteRoute(app);
  registerCentralPaymentReceiptDeleteRoute(app);
  registerVoucherPaymentRoutes(app);

  registerCentralJournalCreateRoute(app);
  registerCentralJournalLifecycleRoutes(app);
  registerVoucherJournalRoutes(app);

  // Stock Transfer deletion must run before the generic voucher delete routes,
  // which server/routes.ts registers once immediately after this registry.
  registerCentralStockTransferDeleteRoutes(app);

  registerVoucherSalesUpdateRoutes(app);
  registerVoucherPurchaseUpdateRoutes(app);
  registerVoucherTransferRoutes(app);
  registerSmartTransferPreviewRoutes(app);
}
