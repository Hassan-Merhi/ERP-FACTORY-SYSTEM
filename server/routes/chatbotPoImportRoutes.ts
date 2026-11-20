import { prepareZmwPurchaseCost } from "../services/accounting/zambiaPurchaseCosting";
import { requiresExplicitImportCurrency } from "./import/poImportCurrency";
import { HttpError } from "../lib/httpError";
/**
 * Chatbot PO-import routes.
 *
 * AI-powered purchase-order file parsing and the confirm/import flow that
 * turns a parsed PO into purchase-order + line records. Extracted from
 * chatbotRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { logger } from "../lib/logger";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { clearERPContextCache } from "../chatService";
import { requireAIActionPermission, logAIAction } from "../lib/aiActionPermission";
import { poLineItems, purchaseOrders, supplierProformas } from "@shared/schema";
import { supplierService } from "./suppliers/supplierService";
import { MoneyDecimal, moneyString, parseMoneyInput } from "../lib/money";
import { amountOrZero, registerChatbotPoImportRoutesPart1 } from "./registerChatbotPoImportRoutesPart1";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

// Amounts go through parseMoneyInput / String(); the draft carries strings for
// line amounts and numbers for charges.
const amount = z.union([z.string(), z.number()]).nullable().optional();
const text = z.string().nullable().optional();
const confirmPoImportInput = {
  query: emptyQuery,
  body: z.strictObject({
    poNumber: text,
    containerNumber: text,
    importDate: text,
    currency: text,
    currencyConfirmed: z.boolean().optional(),
    supplierId: z.union([z.number(), z.string()]).nullable().optional(),
    exchangeRate: amount,
    lines: z
      .array(
        z.strictObject({
          rawName: text,
          rawCode: z.unknown().optional(), // sent by client/src/components/chat-widget/POImportDraftCard.tsx; not used
          stockItemId: z.union([z.number(), z.string()]).nullable().optional(),
          stockItemName: z.unknown().optional(), // sent by client/src/components/chat-widget/POImportDraftCard.tsx; not used
          itemName: text,
          qty: amount,
          rate: amount,
          lineTotal: z.unknown().optional(), // sent by client/src/components/chat-widget/POImportDraftCard.tsx; not used
        })
      )
      .optional(),
    charges: z
      .strictObject({
        freight: amount,
        surcharge: amount,
        fumigation: amount,
        documentCharges: amount,
        discount: amount,
        otherCharges: amount,
      })
      .nullable()
      .optional(),
  }),
} satisfies RequestSchemas;

export function registerChatbotPoImportRoutes(app: Express) {
  registerChatbotPoImportRoutesPart1(app);
  registerChatbotPoImportRoutesPart2(app);
}

function registerChatbotPoImportRoutesPart2(app: Express) {
  // ── PO Import Confirm ─────────────────────────────────────────────
  app.post(
    "/api/chatbot/confirm-po-import",
    requireAuth,
    requireNonPOS,
    validateRequest(confirmPoImportInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const denied = await requireAIActionPermission(req, "write");
        if (denied) return res.status(denied.code).json({ message: denied.message });

        const { poNumber, containerNumber, importDate, currency, supplierId, lines, charges } = req.body;
        const nativeZmw = String(currency || "USD").toUpperCase() === "ZMW";

        // The AI draft takes its currency from the sheet and defaults to USD. For
        // a USD-base / ZMW-display company the reviewer must confirm USD or ZMW
        // explicitly, so Kwacha prices can never be booked as dollars by default.
        if (requiresExplicitImportCurrency(await storage.getCompanyById(companyId))) {
          const confirmedCurrency = String(currency || "").toUpperCase();
          if (req.body.currencyConfirmed !== true || (confirmedCurrency !== "USD" && confirmedCurrency !== "ZMW")) {
            return res.status(409).json({
              code: "PO_IMPORT_CURRENCY_UNCONFIRMED",
              message: "Confirm whether this purchase is in USD or Kwacha (ZMW) before importing it for this company.",
            });
          }
        }

        if (!poNumber) return res.status(400).json({ message: "PO number is required" });
        if (!containerNumber) return res.status(400).json({ message: "Container number is required" });
        if (!supplierId) return res.status(400).json({ message: "Supplier is required" });
        if (!lines?.length) return res.status(400).json({ message: "At least one line item is required" });

        const visibleSuppliers = await supplierService.list(companyId, "", true);
        if (!visibleSuppliers.some((supplier) => supplier.id === Number(supplierId))) {
          return res.status(400).json({ message: "Supplier not found" });
        }

        // Every line must carry a quantity and rate that parse; one that did not
        // used to be written as 'NaN', which Postgres numeric accepts.
        const parsedLines = (lines as Array<{ qty?: unknown; rate?: unknown }>).map((line) => ({
          qty: parseMoneyInput(line.qty),
          rate: parseMoneyInput(line.rate),
        }));
        if (parsedLines.some((line) => !line.qty || !line.rate)) {
          return res.status(400).json({ message: "Invalid amount" });
        }

        // One effective document date for the approved rate, the container, the
        // PO's locked historical rate date and both company purchase vouchers.
        const effectiveImportDate: string = importDate || new Date().toISOString().split("T")[0];
        // Rate approval and ALL native line/charge normalization precede any
        // container or accounting write. Existing USD import remains unchanged.
        const zwmHistorical = nativeZmw
          ? await prepareZmwPurchaseCost({
              companyId,
              date: effectiveImportDate,
              exchangeRate: req.body.exchangeRate,
              lines: parsedLines.map((line) => ({ quantity: line.qty!.toFixed(), rate: line.rate!.toFixed() })),
              charges: charges || {},
            })
          : null;

        const unresolved = lines.filter((l: { stockItemId?: unknown }) => !l.stockItemId);
        if (unresolved.length > 0) {
          return res.status(400).json({
            message: `${unresolved.length} item(s) still unresolved: ${unresolved.map((l: { rawName?: unknown; itemName?: unknown }) => l.rawName || l.itemName).join(", ")}`,
          });
        }

        // Duplicate PO number check
        const existingPO = await db
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.poNumber, poNumber), eq(purchaseOrders.companyId, companyId)))
          .limit(1);
        if (existingPO.length > 0) {
          return res.status(409).json({
            message: `A purchase order with number "${poNumber}" already exists. Please use a different PO number.`,
          });
        }

        // Get or create container
        let container = await storage.getContainerByNumber(containerNumber);
        if (!container) {
          container = await storage.createContainer({
            companyId,
            containerNumber,
            supplierId: Number(supplierId),
            status: "OTW",
            importDate: effectiveImportDate,
          });
        } else {
          // Container-level duplicate check: prevent re-importing same container
          const existingPOs = await db
            .select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.containerId, container.id), eq(purchaseOrders.companyId, companyId)))
            .limit(5);

          if (existingPOs.length > 0) {
            return res.status(409).json({
              message: `Container "${containerNumber}" already has ${existingPOs.length} PO(s) imported (${existingPOs.map((p) => p.poNumber).join(", ")}). To avoid duplicates, please delete the existing POs first or use a different container number.`,
            });
          }
        }

        // Each line total is qty x rate rounded half up to cents, and the PO's
        // items total is the sum of those line totals, so the two always agree.
        const storedLines = parsedLines.map((line, index) => ({
          qty: line.qty!,
          rate: zwmHistorical ? new MoneyDecimal(zwmHistorical.lines[index].rate) : line.rate!,
          lineTotal: zwmHistorical
            ? new MoneyDecimal(zwmHistorical.lines[index].lineTotal)
            : line.qty!.times(line.rate!).toDecimalPlaces(2),
        }));
        const itemsTotal = storedLines.reduce((sum, line) => sum.plus(line.lineTotal), new MoneyDecimal(0));
        const purchaseCharges = zwmHistorical ?? charges;
        const freightAmt = amountOrZero(purchaseCharges?.freight);
        const surchargeAmt = amountOrZero(purchaseCharges?.surcharge);
        const fumigationAmt = amountOrZero(purchaseCharges?.fumigation);
        const docChargesAmt = amountOrZero(purchaseCharges?.documentCharges);
        const discountAmt = amountOrZero(purchaseCharges?.discount);
        const otherChargesAmt = amountOrZero(purchaseCharges?.otherCharges);
        const grandTotal = itemsTotal
          .plus(freightAmt)
          .plus(surchargeAmt)
          .plus(fumigationAmt)
          .plus(docChargesAmt)
          .minus(discountAmt)
          .plus(otherChargesAmt);

        const atomicNativeLines = zwmHistorical
          ? lines.map(
              (
                line: {
                  stockItemId: unknown;
                  itemName?: string;
                  rawName?: string;
                },
                index: number
              ) => ({
                stockItemId: Number(line.stockItemId),
                itemName: line.itemName || line.rawName || "Unknown Item",
                quantity: storedLines[index].qty.toFixed(3),
                rate: storedLines[index].rate.toFixed(2),
                lineTotal: storedLines[index].lineTotal.toFixed(2),
                nativeRate: zwmHistorical.lines[index].nativeRate,
                nativeLineTotal: zwmHistorical.lines[index].nativeLineTotal,
              })
            )
          : undefined;
        const purchaseOrderInput = {
          companyId,
          poNumber,
          containerId: container.id,
          supplierId: Number(supplierId),
          currency: currency || "USD",
          ...(zwmHistorical
            ? {
                historicalExchangeRate: zwmHistorical.historicalExchangeRate,
                historicalRateDate: zwmHistorical.historicalRateDate,
                nativeLineCount: zwmHistorical.nativeLineCount,
                nativeItemsTotal: zwmHistorical.nativeItemsTotal,
                nativeFreight: zwmHistorical.nativeFreight,
                nativeSurcharge: zwmHistorical.nativeSurcharge,
                nativeFumigation: zwmHistorical.nativeFumigation,
                nativeDocumentCharges: zwmHistorical.nativeDocumentCharges,
                nativeDiscount: zwmHistorical.nativeDiscount,
                nativeOtherCharges: zwmHistorical.nativeOtherCharges,
              }
            : {}),
          itemsTotal: moneyString(itemsTotal),
          freight: moneyString(freightAmt),
          surcharge: moneyString(surchargeAmt),
          fumigation: moneyString(fumigationAmt),
          documentCharges: moneyString(docChargesAmt),
          discount: moneyString(discountAmt),
          otherCharges: moneyString(otherChargesAmt),
          status: "Open",
          chargesEdited: [freightAmt, surchargeAmt, fumigationAmt, docChargesAmt, discountAmt, otherChargesAmt].some(
            (amount) => amount.greaterThan(0)
          ),
        };
        // Native Kwacha lines commit atomically with the PO and both company
        // vouchers; the USD path keeps its original two-argument call.
        const po = atomicNativeLines
          ? await storage.createPurchaseOrder(purchaseOrderInput, effectiveImportDate, atomicNativeLines)
          : await storage.createPurchaseOrder(purchaseOrderInput, importDate);

        // ZMW entries were inserted alongside both company vouchers; a later
        // line insert failure cannot leave an orphaned posted purchase.
        if (!zwmHistorical)
          for (const [index, line] of lines.entries()) {
            const stored = storedLines[index];
            await db.insert(poLineItems).values({
              poId: po.id,
              stockItemId: Number(line.stockItemId),
              itemName: line.itemName || line.rawName || "Unknown Item",
              quantity: stored.qty.toFixed(3),
              rate: stored.rate.toFixed(2),
              lineTotal: stored.lineTotal.toFixed(2),
            });
          }

        // Fetch available proformas for the download-after-import offer
        const availableProformas = await db
          .select({ id: supplierProformas.id, reference: supplierProformas.reference })
          .from(supplierProformas)
          .where(and(eq(supplierProformas.companyId, companyId), eq(supplierProformas.supplierId, Number(supplierId))))
          .orderBy(desc(supplierProformas.createdAt));

        await logAIAction({
          req,
          actionType: "write",
          actionName: "po_import",
          inputJson: {
            poNumber,
            containerNumber,
            supplierId: Number(supplierId),
            lineCount: lines.length,
            currency: currency || "USD",
          },
          outputJson: { poId: po.id, containerId: container.id, grandTotal: grandTotal.toFixed(2) },
          status: "success",
          createdRecordId: po.id,
        });

        clearERPContextCache(companyId);
        res.json({
          success: true,
          poId: po.id,
          poNumber: po.poNumber,
          containerNumber,
          containerId: container.id,
          supplierId: Number(supplierId),
          lineCount: lines.length,
          itemsTotal: itemsTotal.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          crossCompany: !!(await storage.getParentCompanyId()),
          availableProformas,
        });
      } catch (error: unknown) {
        if (error instanceof HttpError) return res.status(error.statusCode).json({ message: error.message });
        logger.error("PO import confirm error:", { error: error });
        res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
