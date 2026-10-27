import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, retailStockOperations, storedFiles } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { db } from "../../db";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import {
  normalizeVoucherEntryAmounts,
  normalizeCurrencyCode,
  validateHistoricalRate,
} from "../accounting/currencyAmounts";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import { ensureRetailAccountingSettingsTx } from "./retailAccountingSettingsService";
import { retailInventoryOpeningTx } from "./retailInventoryJournal";
import { addMovement, lockInventoryRow, setInventoryQuantity } from "./retailStockLedger";
import { writeRetailSupplierCatalogBatchTx } from "./retailSupplierCatalogBatch";
import type { RetailSupplierPurchaseItem } from "./retailSupplierPurchaseHistory";
import {
  retailSupplierFileMagicMatches,
  RETAIL_SUPPLIER_ALLOWED_IMAGE_TYPES,
  RETAIL_SUPPLIER_ALLOWED_INVOICE_TYPES,
} from "./retailSupplierImportFileValidation";

const price = z.coerce.number().finite().nonnegative().max(1_000_000_000);
export const retailSupplierPurchaseSchema = z
  .object({
    idempotencyKey: z.string().trim().min(12).max(191),
    supplierId: z.coerce.number().int().positive(),
    locationId: z.coerce.number().int().positive(),
    invoiceReference: z.string().trim().min(1).max(100),
    // A supplier invoice can be received in multiple batches only when every
    // batch declares partial receipt and has its own delivery reference.
    partialReceipt: z.boolean().default(false),
    deliveryReference: z.string().trim().max(100).optional().default(""),
    /** Company-owned PDF/JPG/PNG uploaded to the existing file store. */
    invoiceFileId: z.number().int().positive().nullable().optional(),
    invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.string().trim().min(3).max(3).default("USD"),
    exchangeRate: z.union([z.string(), z.number()]).nullable().optional(),
    lines: z
      .array(
        z.object({
          rowNumber: z.number().int().min(2),
          name: z.string().trim().min(1).max(240),
          brand: z.string().trim().max(120).default("Other / No Brand"),
          category: z.string().trim().min(1).max(160),
          color: z.string().trim().min(1).max(100).default("Default"),
          size: z.string().trim().min(1).max(100).default("One Size"),
          quantity: z.number().int().min(1).max(100000),
          costPrice: price,
          sellingPrice: price,
          description: z.string().trim().max(5000).optional(),
          sku: z.string().trim().max(191).default(""),
          barcode: z.string().trim().max(191).default(""),
          imageUrls: z
            .array(z.string().regex(/^\/api\/retail\/media\/\d+$/))
            .max(4)
            .default([]),
        })
      )
      .min(1)
      .max(5000),
  })
  .superRefine((input, context) => {
    if (input.partialReceipt && !input.deliveryReference.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryReference"],
        message: "Each partial receipt requires a unique delivery reference",
      });
    }
    if (!input.partialReceipt && input.deliveryReference.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryReference"],
        message: "Delivery reference is only used for partial supplier receipts",
      });
    }
  });
export type RetailSupplierPurchaseInput = z.infer<typeof retailSupplierPurchaseSchema>;
const postingDependencies = createDatabasePostingDependencies();

export function retailSupplierPurchaseFingerprint(input: RetailSupplierPurchaseInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function responseOf(meta: Record<string, unknown>) {
  return {
    operationId: Number(meta.operationId),
    voucherId: Number(meta.voucherId),
    supplierId: Number(meta.supplierId),
    locationId: Number(meta.locationId),
    invoiceReference: String(meta.invoiceReference),
    currency: String(meta.currency),
    purchaseTotal: String(meta.purchaseTotal),
    baseTotal: String(meta.baseTotal),
    items: meta.items as RetailSupplierPurchaseItem[],
    deliveryReference: typeof meta.deliveryReference === "string" ? meta.deliveryReference : "",
    partialReceipt: meta.partialReceipt === true,
    invoiceFileId: meta.invoiceFileId ? Number(meta.invoiceFileId) : null,
  };
}

// Catalog, barcode, inventory, payable, and durable request key share one DB transaction.
export async function postRetailSupplierPurchase(
  companyId: number,
  actor: { userId: string; username?: string | null },
  raw: unknown
) {
  const input = retailSupplierPurchaseSchema.parse(raw);
  const currency = normalizeCurrencyCode(input.currency);
  // vouchers.exchange_rate is NUMERIC(20,6); normalize entries and stock
  // valuation against the exact rate that the voucher itself can persist.
  // Otherwise a 10dp entry rate can disagree with the stored 6dp voucher rate.
  const sourceRate =
    currency === "USD"
      ? new Decimal(1)
      : validateHistoricalRate(input.exchangeRate, "Supplier invoice currency units per USD");
  const rate = sourceRate.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  if (!rate.isFinite() || rate.lte(0) || rate.gte("100000000000000")) {
    throw new Error("Supplier exchange rate is outside the supported accounting voucher precision");
  }
  const rateString = rate.toFixed(6);
  const fingerprint = retailSupplierPurchaseFingerprint(input);
  const transactionTotal = input.lines
    .reduce((sum, line) => sum.plus(new Decimal(line.quantity).times(line.costPrice)), new Decimal(0))
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  if (transactionTotal.lte(0) || transactionTotal.gte("100000000000000")) {
    throw new Error("Supplier purchase amount must be positive and fit the accounting ledger precision");
  }
  const debit = normalizeVoucherEntryAmounts({
    transactionCurrency: currency,
    baseCurrency: "USD",
    transactionDebitAmount: transactionTotal.toFixed(6),
    transactionCreditAmount: "0",
    historicalRate: rateString,
  });
  const credit = normalizeVoucherEntryAmounts({
    transactionCurrency: currency,
    baseCurrency: "USD",
    transactionDebitAmount: "0",
    transactionCreditAmount: transactionTotal.toFixed(6),
    historicalRate: rateString,
  });

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${20261024}, ${companyId})`);
    const [previous] = await tx
      .select({ metadata: retailStockOperations.metadata })
      .from(retailStockOperations)
      .where(
        and(
          eq(retailStockOperations.companyId, companyId),
          eq(retailStockOperations.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (previous) {
      if (previous.metadata?.fingerprint !== fingerprint || previous.metadata?.operationType !== "supplier_purchase") {
        throw new Error("Request ID was already used for a different stock operation");
      }
      return { replayed: true, ...responseOf(previous.metadata) };
    }
    const [supplier] = await tx
      .select({ id: companyScopedSuppliers.id })
      .from(companyScopedSuppliers)
      .where(
        and(
          eq(companyScopedSuppliers.id, input.supplierId),
          eq(companyScopedSuppliers.companyId, companyId),
          eq(companyScopedSuppliers.active, true),
          sql`${companyScopedSuppliers.deletedAt} IS NULL`
        )
      )
      .limit(1);
    if (!supplier) throw new Error("Supplier is inactive or does not belong to this company");
    const [location] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.companyId, companyId), eq(locations.id, input.locationId), eq(locations.active, true)))
      .limit(1);
    if (!location) throw new Error("Receiving location is not active in this company");
    const today = await companyBusinessDate(companyId, tx);
    if (input.invoiceDate > today) throw new Error("Supplier invoice date cannot be in the future");
    const opening = await retailInventoryOpeningTx(tx, companyId);
    if (!opening) {
      throw new Error("Apply the Retail inventory accounting opening before importing supplier purchases");
    }
    if (input.invoiceDate < String(opening.openingDate).slice(0, 10)) {
      throw new Error("Supplier invoice date cannot be earlier than the Retail inventory opening date");
    }
    const invoiceReceipts = await tx
      .select({
        id: retailStockOperations.id,
        metadata: retailStockOperations.metadata,
      })
      .from(retailStockOperations)
      .where(
        and(
          eq(retailStockOperations.companyId, companyId),
          eq(retailStockOperations.operationType, "supplier_purchase"),
          sql`${retailStockOperations.metadata}->>'supplierId' = ${String(input.supplierId)}`,
          sql`lower(trim(${retailStockOperations.referenceId})) = lower(trim(${input.invoiceReference}))`
        )
      );
    for (const prior of invoiceReceipts) {
      const old = prior.metadata ?? {};
      if (!input.partialReceipt || old.partialReceipt !== true) {
        throw new Error(
          "Supplier invoice already received; use a partial delivery reference only if prior receipts were partial"
        );
      }
      if (
        String(old.deliveryReference ?? "")
          .trim()
          .toLowerCase() === input.deliveryReference.trim().toLowerCase()
      ) {
        throw new Error("This supplier invoice delivery reference has already been received");
      }
      if (String(old.currency ?? "").toUpperCase() !== currency) {
        throw new Error("All partial deliveries of the same supplier invoice must use the same currency");
      }
    }

    const fileIds = [
      ...new Set(input.lines.flatMap((line) => line.imageUrls.map((url) => Number(url.split("/").pop())))),
    ];
    const pictureErrorMessage = "Supplier picture is missing, unsafe, or does not belong to this company";
    if (fileIds.some((fileId) => !Number.isSafeInteger(fileId) || fileId < 1)) {
      throw new Error(pictureErrorMessage);
    }
    const pictureFiles =
      fileIds.length === 0
        ? []
        : await tx
            .select({
              id: storedFiles.id,
              fileType: storedFiles.fileType,
              fileSize: storedFiles.fileSize,
              signature: sql<string>`left(${storedFiles.fileData}, 48)`,
            })
            .from(storedFiles)
            .where(and(eq(storedFiles.companyId, companyId), inArray(storedFiles.id, fileIds)))
            .limit(fileIds.length);
    const pictureFilesById = new Map(pictureFiles.map((file) => [file.id, file]));
    for (const fileId of fileIds) {
      const file = pictureFilesById.get(fileId);
      if (
        !file ||
        !RETAIL_SUPPLIER_ALLOWED_IMAGE_TYPES.has(file.fileType) ||
        file.fileSize < 1 ||
        file.fileSize > 10 * 1024 * 1024 ||
        !retailSupplierFileMagicMatches(file.fileType, file.signature)
      ) {
        throw new Error(pictureErrorMessage);
      }
    }

    if (input.invoiceFileId) {
      const [attachment] = await tx
        .select({
          id: storedFiles.id,
          fileType: storedFiles.fileType,
          fileSize: storedFiles.fileSize,
          signature: sql<string>`left(${storedFiles.fileData}, 48)`,
        })
        .from(storedFiles)
        .where(and(eq(storedFiles.companyId, companyId), eq(storedFiles.id, input.invoiceFileId)))
        .limit(1);
      if (
        !attachment ||
        !RETAIL_SUPPLIER_ALLOWED_INVOICE_TYPES.has(attachment.fileType) ||
        attachment.fileSize < 1 ||
        attachment.fileSize > 10 * 1024 * 1024 ||
        !retailSupplierFileMagicMatches(attachment.fileType, attachment.signature)
      ) {
        throw new Error("Invoice attachment must be a company-owned PDF, JPG or PNG with valid content, up to 10 MB");
      }
    }
    const [operation] = await tx
      .insert(retailStockOperations)
      .values({
        companyId,
        operationType: "supplier_purchase",
        idempotencyKey: input.idempotencyKey,
        referenceId: input.invoiceReference,
        createdBy: actor.userId,
        metadata: { operationType: "supplier_purchase", fingerprint, supplierId: input.supplierId },
      })
      .returning({ id: retailStockOperations.id });
    if (!operation) throw new Error("Cannot create supplier purchase receipt");

    const catalog = await writeRetailSupplierCatalogBatchTx(
      tx,
      companyId,
      input.lines.map((line) => ({
        ...line,
        costPrice: new Decimal(line.costPrice).div(rate).toDecimalPlaces(6).toNumber(),
      }))
    );
    const items: RetailSupplierPurchaseItem[] = [];
    let stockValueBefore = new Decimal(0),
      stockValueAfter = new Decimal(0);
    for (const [index, line] of input.lines.entries()) {
      const assigned = catalog.rows[index];
      const stock = await lockInventoryRow(tx, companyId, assigned.variantId, input.locationId);
      const beforeQty = new Decimal(stock.quantity),
        beforeAvg = new Decimal(stock.averageCost);
      const addedQty = new Decimal(line.quantity),
        unitCost = new Decimal(line.costPrice).div(rate);
      const totalQty = beforeQty.plus(addedQty),
        basis = Decimal.max(0, beforeQty);
      const nextAverage =
        basis.lte(0) || beforeAvg.lte(0)
          ? unitCost
          : basis.times(beforeAvg).plus(addedQty.times(unitCost)).div(basis.plus(addedQty));
      const avgStored = nextAverage.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
      stockValueBefore = stockValueBefore.plus(beforeQty.times(beforeAvg));
      stockValueAfter = stockValueAfter.plus(totalQty.times(avgStored));
      await setInventoryQuantity(
        tx,
        companyId,
        assigned.variantId,
        input.locationId,
        totalQty.toNumber(),
        avgStored.toNumber()
      );
      await addMovement(tx, {
        companyId,
        variantId: assigned.variantId,
        locationId: input.locationId,
        movementType: "receive",
        before: stock.quantity,
        after: totalQty.toNumber(),
        quantityDelta: line.quantity,
        eventKey: `supplier-purchase:${operation.id}:${line.rowNumber}`,
        referenceType: "supplier_purchase",
        referenceId: operation.id,
        createdBy: actor.userId,
        metadata: {
          supplierId: input.supplierId,
          invoiceReference: input.invoiceReference,
          invoiceCurrency: currency,
          invoiceUnitCost: line.costPrice,
          unitCostBase: unitCost.toDecimalPlaces(6).toFixed(6),
          barcode: assigned.barcode,
        },
      });
      items.push({
        rowNumber: line.rowNumber,
        variantId: assigned.variantId,
        barcode: assigned.barcode,
        quantity: line.quantity,
        name: line.name,
        brand: line.brand,
        color: line.color,
        size: line.size,
        unitCost: new Decimal(line.costPrice).toFixed(4),
        sellingPrice: new Decimal(line.sellingPrice).toFixed(4),
      });
    }
    const bookedCost = new Decimal(debit.baseDebitAmount);
    if (!stockValueAfter.minus(stockValueBefore).toDecimalPlaces(2).eq(bookedCost.toDecimalPlaces(2))) {
      throw new Error("Inventory valuation does not reconcile to supplier invoice; check stock cost/FX rate");
    }

    const settings = await ensureRetailAccountingSettingsTx(tx, companyId, input.locationId);
    const posting = await postBalancedVoucherTx(
      tx,
      {
        voucher: {
          companyId,
          locationId: input.locationId,
          voucherNumber: `RETAIL-SUP-${operation.id}`,
          voucherType: "Journal",
          voucherDate: input.invoiceDate,
          totalAmount: debit.debitAmount,
          optional: false,
          currency,
          exchangeRate: rateString,
          sourceModule: "Retail",
          description: `Supplier purchase ${input.invoiceReference}`,
        },
        entries: [
          {
            ledgerAccountId: settings.inventoryAssetLedgerAccountId,
            ...debit,
            narration: `Retail stock received · ${input.invoiceReference}`,
          },
          {
            supplierId: input.supplierId,
            ...credit,
            narration: `Supplier credit for stock · ${input.invoiceReference}`,
          },
        ],
        source: {
          sourceType: "retail-supplier-purchase",
          sourceId: String(operation.id),
          idempotencyKey: `retail-supplier-purchase:${companyId}:${operation.id}`,
        },
        actor: { userId: actor.userId, username: actor.username ?? null, reason: "Retail supplier stock purchase" },
      },
      postingDependencies
    );
    if (posting.replayed) throw new Error("Unexpected accounting replay; receipt not applied");
    const responseMeta = {
      operationType: "supplier_purchase",
      operationId: operation.id,
      fingerprint,
      supplierId: input.supplierId,
      locationId: input.locationId,
      invoiceReference: input.invoiceReference,
      invoiceDate: input.invoiceDate,
      partialReceipt: input.partialReceipt,
      deliveryReference: input.partialReceipt ? input.deliveryReference.trim() : "",
      invoiceFileId: input.invoiceFileId ?? null,
      currency,
      exchangeRate: rateString,
      voucherId: posting.voucher.id,
      purchaseTotal: transactionTotal.toFixed(6),
      baseTotal: debit.baseDebitAmount,
      variantCount: new Set(items.map((line) => line.variantId)).size,
      unitsReceived: items.reduce((total, line) => total + line.quantity, 0),
      items,
    };
    await tx
      .update(retailStockOperations)
      .set({ metadata: responseMeta })
      .where(and(eq(retailStockOperations.companyId, companyId), eq(retailStockOperations.id, operation.id)));
    return { replayed: false, ...responseOf(responseMeta) };
  });
}
