import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { logAudit } from "../../helpers/auditHelpers";
import type { Express, Request, Response } from "express";
import { db, type DbTransaction } from "../../../db";
import { requireAuth } from "../../../auth";
import { postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { factoryRawStock } from "@shared/schema";
import { registerRawStockReverseOffloadRoute } from "./rawStockReverseOffloadRoute";
import { toMoney } from "../../../lib/money";
import { rawStockOffloadRoutesStep } from "./rawStockOffloadRoutesStep";
import { rawStockOffloadRoutesTx } from "./rawStockOffloadRoutesTx";
import { rawStockOffloadRoutesTx2 } from "./rawStockOffloadRoutesTx2";

export function registerRawStockOffloadRoutes(app: Express) {
  app.post("/api/factory/raw-stock/offload", requireAuth, async (req: Request, res: Response) => {
    try {
      const rso1 = await rawStockOffloadRoutesStep({ req, res });
      if (rso1.done) return rso1.value;
      const {
        companyId,
        containerId,
        receivedKg,
        reqOtherChargesAccountId,
        reqOtherChargesSupplierId,
        reqOtherChargesCurrencyCode,
        currencyCode,
        reqOtherChargesFxRate,
        fxRateText,
        offloadDate,
        container,
        ocExpenseAcctId,
        dutyVal,
        chargesPayableAcctId,
        reqDutyAccountId,
      } = rso1;

      // ── Single atomic transaction: all DB writes happen here or not at all ────
      const offload: { rawStock?: typeof factoryRawStock.$inferSelect } = {};

      // Phase 21 (B): the offload audit, written on the offload's transaction on
      // both the first and the continuation receipt path.
      const writeOffloadAuditTx = async (tx: DbTransaction) => {
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId: companyId,
            action: "offload",
            tableName: "production_raw_stock",
            recordId: containerId,
            recordIdentifier: `Container #${containerId} — ${receivedKg} kg`,
            changes: null,
          },
          tx
        );
      };
      await db.transaction(async (tx) => {
        const rsot1 = await rawStockOffloadRoutesTx({ rso1, offload, tx, req, writeOffloadAuditTx });
        if (rsot1.done) return rsot1.value;
        const rsot2 = await rawStockOffloadRoutesTx2({ tx, rso1, offload, rsot1, req });

        // 9. Other Charges voucher (double-entry)
        if (rsot2.otherChargesAmount.greaterThan(0) && (reqOtherChargesAccountId || reqOtherChargesSupplierId)) {
          const ocVoucherCcy = reqOtherChargesCurrencyCode || currencyCode;
          const ocFx = reqOtherChargesFxRate || fxRateText;
          await postFactoryVoucherTx(tx, {
            companyId: companyId,
            voucherNumber: `FACTORY-OC-${containerId}-MAIN-${rsot2.receiptId}`,
            voucherDate: offloadDate,
            description: `Other charges on container ${container.containerNumber}`,
            currency: ocVoucherCcy,
            fxRateToUsd: ocFx,
            source: {
              sourceType: "factory-offload-other-charges",
              sourceId: `${containerId}:${rsot2.receiptId}`,
              phase: "main",
            },
            lines: [
              {
                ledgerAccountId: ocExpenseAcctId!,
                debit: rsot2.otherChargesAmount,
                narration: `Other charges expense - container ${container.containerNumber}`,
              },
              reqOtherChargesSupplierId
                ? {
                    // Supplier: Dr OC Expense / Cr Supplier Balance
                    factorySupplierId: parseInt(reqOtherChargesSupplierId),
                    credit: rsot2.otherChargesAmount,
                    narration: `Other charges payable to supplier - container ${container.containerNumber}`,
                  }
                : {
                    // Own-account other charges: Dr OC Expense / Cr chosen account.
                    ledgerAccountId: parseInt(reqOtherChargesAccountId),
                    credit: rsot2.otherChargesAmount,
                    narration: `Other charges paid via own account - container ${container.containerNumber}`,
                  },
            ],
          });
        }

        // 9b. Duty is a real accounting event, not merely a daybook cost.
        // The duty amount is recorded in the container currency and historical
        // offload FX rate. The selected duty account is the credit counterparty.
        // This remains atomic with offload cost, stock and any other journals.
        if (dutyVal > 0) {
          await postFactoryVoucherTx(tx, {
            companyId: companyId,
            voucherNumber: `FACTORY-DUTY-${containerId}-${rsot2.receiptId}`,
            voucherDate: offloadDate,
            description: `Duty on container ${container.containerNumber}`,
            currency: currencyCode,
            fxRateToUsd: fxRateText,
            source: {
              sourceType: "factory-offload-duty",
              sourceId: `${containerId}:${rsot2.receiptId}`,
              phase: "duty",
            },
            lines: [
              {
                ledgerAccountId: chargesPayableAcctId,
                debit: String(dutyVal),
                narration: `Duty incurred - container ${container.containerNumber}`,
              },
              {
                ledgerAccountId: parseInt(reqDutyAccountId),
                credit: String(dutyVal),
                narration: `Duty paid or payable through account - container ${container.containerNumber}`,
              },
            ],
          });
        }

        // 10. Additional charges vouchers (double-entry, Dr Factory Charges Payable / Cr chosen)
        for (const inserted of rsot1.insertedAdditionalCharges) {
          const chargeExact = toMoney(inserted.amount);
          if (chargeExact.lessThanOrEqualTo(0)) continue;
          if (!inserted.ledgerAccountId && !inserted.supplierId) continue;
          const addlChargeCcy = inserted.currencyCode || currencyCode;
          const addlChargeFx = inserted.fxRateToUsd || fxRateText;
          await postFactoryVoucherTx(tx, {
            companyId: companyId,
            voucherNumber: `FACTORY-OC-${containerId}-${inserted.id}`,
            voucherDate: offloadDate,
            description: `${inserted.description} - container ${container.containerNumber}`,
            currency: addlChargeCcy,
            fxRateToUsd: addlChargeFx,
            source: { sourceType: "factory-offload-additional-charge", sourceId: inserted.id, phase: "offload" },
            lines: [
              {
                ledgerAccountId: chargesPayableAcctId,
                debit: chargeExact,
                narration: `${inserted.description} payable - container ${container.containerNumber}`,
              },
              inserted.ledgerAccountId
                ? {
                    ledgerAccountId: inserted.ledgerAccountId,
                    credit: chargeExact,
                    narration: `${inserted.description} - container ${container.containerNumber}`,
                  }
                : {
                    factorySupplierId: inserted.supplierId,
                    credit: chargeExact,
                    narration: `${inserted.description} - container ${container.containerNumber}`,
                  },
            ],
          });
        }

        await writeOffloadAuditTx(tx);
        // (First-receipt event was recorded at step 3 above, inside this same transaction.)
      }); // ── end transaction ────────────────────────────────────────────────────

      res.json({ rawStock: offload.rawStock, commission: rso1.commissionRecord });
    } catch (error: unknown) {
      logger.error("Error offloading container:", { error: error });
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── Reverse Offload ──────────────────────────────────────────────────────────
  registerRawStockReverseOffloadRoute(app);
}
