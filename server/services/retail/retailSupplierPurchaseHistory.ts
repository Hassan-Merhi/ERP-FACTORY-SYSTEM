import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { locations, retailProductVariants, retailStockMovements, retailStockOperations, storedFiles } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { db } from "../../db";

export interface RetailSupplierPurchaseHistoryFilter {
  supplierId?: number;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface RetailSupplierPurchaseListEntry {
  operationId: number;
  invoiceReference: string;
  deliveryReference: string | null;
  partialReceipt: boolean;
  invoiceDate: string;
  supplierId: number;
  supplierName: string;
  locationId: number;
  locationName: string;
  currency: string;
  purchaseTotal: string;
  baseTotal: string;
  voucherId: number;
  variantCount: number;
  unitsReceived: number;
  invoiceFileId: number | null;
  createdAt: Date;
  createdBy: string;
}

export interface RetailSupplierPurchaseItem {
  rowNumber: number;
  variantId: number;
  barcode: string;
  quantity: number;
  name?: string;
  brand?: string;
  color?: string;
  size?: string;
  unitCost?: string;
  sellingPrice?: string;
}

function numericId(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
function positiveUnits(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
function metadata(row: { metadata: Record<string, unknown> }) {
  return row.metadata ?? {};
}

export function savedRetailSupplierPurchaseItems(data: Record<string, unknown>): RetailSupplierPurchaseItem[] {
  const entries = data.items;
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => {
    if (!entry || typeof entry !== "object") throw new Error("Corrupted supplier import receipt line");
    const line = entry as Record<string, unknown>;
    const result = {
      rowNumber: Number(line.rowNumber),
      variantId: numericId(line.variantId),
      barcode: String(line.barcode ?? ""),
      quantity: positiveUnits(line.quantity),
      name: typeof line.name === "string" ? line.name : undefined,
      brand: typeof line.brand === "string" ? line.brand : undefined,
      color: typeof line.color === "string" ? line.color : undefined,
      size: typeof line.size === "string" ? line.size : undefined,
      unitCost: typeof line.unitCost === "string" ? line.unitCost : undefined,
      sellingPrice: typeof line.sellingPrice === "string" ? line.sellingPrice : undefined,
    };
    if (!Number.isSafeInteger(result.rowNumber) || result.rowNumber < 2 ||
      !result.variantId || !result.barcode.trim() || !result.quantity) {
      throw new Error("Corrupted supplier import receipt line");
    }
    return result;
  });
}

export async function listRetailSupplierPurchases(companyId: number, filter: RetailSupplierPurchaseHistoryFilter = {}) {
  const limit = Math.min(100, Math.max(1, Math.trunc(filter.limit ?? 30)));
  const offset = Math.min(10000, Math.max(0, Math.trunc(filter.offset ?? 0)));
  const terms = [
    eq(retailStockOperations.companyId, companyId),
    eq(retailStockOperations.operationType, "supplier_purchase"),
  ];
  if (filter.supplierId) {
    terms.push(sql`${retailStockOperations.metadata}->>'supplierId' = ${String(filter.supplierId)}`);
  }
  if (filter.query?.trim()) {
    const text = filter.query.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&");
    terms.push(ilike(retailStockOperations.referenceId, `%${text}%`));
  }
  const batches = await db.select({
    id: retailStockOperations.id,
    // The list only needs summary fields; excluding the line array avoids
    // returning many megabytes for 25 receipts of up to 5,000 items each.
    metadata: sql<Record<string, unknown>>`${retailStockOperations.metadata} - 'items'`,
    referenceId: retailStockOperations.referenceId,
    createdAt: retailStockOperations.createdAt,
    createdBy: retailStockOperations.createdBy,
  }).from(retailStockOperations)
    .where(and(...terms))
    .orderBy(desc(retailStockOperations.createdAt), desc(retailStockOperations.id))
    .limit(limit + 1).offset(offset);
  const hasMore = batches.length > limit;
  const current = batches.slice(0, limit);
  const supplierIds = [...new Set(current.map(op => numericId(metadata(op).supplierId)).filter(Boolean))];
  const locationIds = [...new Set(current.map(op => numericId(metadata(op).locationId)).filter(Boolean))];
  const [suppliers, locationsList] = await Promise.all([
    supplierIds.length
      ? db.select({ id: companyScopedSuppliers.id, name: companyScopedSuppliers.legalName })
        .from(companyScopedSuppliers)
        .where(and(eq(companyScopedSuppliers.companyId, companyId), inArray(companyScopedSuppliers.id, supplierIds)))
      : Promise.resolve([]),
    locationIds.length
      ? db.select({ id: locations.id, name: locations.name })
        .from(locations).where(and(eq(locations.companyId, companyId), inArray(locations.id, locationIds)))
      : Promise.resolve([]),
  ]);
  const bySupplier = new Map(suppliers.map(row => [row.id, row.name]));
  const byLocation = new Map(locationsList.map(row => [row.id, row.name]));
  const records: RetailSupplierPurchaseListEntry[] = current.map(op => {
    const data = metadata(op);
    const supplierId = numericId(data.supplierId);
    const locationId = numericId(data.locationId);
    return {
      operationId: op.id,
      invoiceReference: String(data.invoiceReference ?? op.referenceId ?? ""),
      deliveryReference: typeof data.deliveryReference === "string" && data.deliveryReference ? data.deliveryReference : null,
      partialReceipt: data.partialReceipt === true,
      invoiceDate: String(data.invoiceDate ?? ""),
      supplierId, supplierName: bySupplier.get(supplierId) ?? `Supplier #${supplierId}`,
      locationId, locationName: byLocation.get(locationId) ?? `Location #${locationId}`,
      currency: String(data.currency ?? "USD"),
      purchaseTotal: String(data.purchaseTotal ?? "0"),
      baseTotal: String(data.baseTotal ?? "0"),
      voucherId: numericId(data.voucherId),
      variantCount: Math.max(0, Number(data.variantCount ?? 0)),
      unitsReceived: Math.max(0, Number(data.unitsReceived ?? 0)),
      invoiceFileId: numericId(data.invoiceFileId) || null,
      createdAt: op.createdAt,
      createdBy: op.createdBy,
    };
  });
  return { rows: records, nextOffset: hasMore ? offset + limit : null };
}

export async function getRetailSupplierPurchaseDetail(companyId: number, operationId: number) {
  const [op] = await db.select({
    id: retailStockOperations.id,
    metadata: retailStockOperations.metadata,
    referenceId: retailStockOperations.referenceId,
    createdAt: retailStockOperations.createdAt,
    createdBy: retailStockOperations.createdBy,
    idempotencyKey: retailStockOperations.idempotencyKey,
  }).from(retailStockOperations).where(and(
    eq(retailStockOperations.companyId, companyId),
    eq(retailStockOperations.operationType, "supplier_purchase"),
    eq(retailStockOperations.id, operationId),
  )).limit(1);
  if (!op) return null;
  const data = metadata(op);
  const items = savedRetailSupplierPurchaseItems(data);
  const fileId = numericId(data.invoiceFileId);
  const [invoiceFile] = fileId ? await db.select({
    id: storedFiles.id, fileName: storedFiles.fileName,
    fileType: storedFiles.fileType, fileSize: storedFiles.fileSize,
  }).from(storedFiles).where(and(
    eq(storedFiles.companyId, companyId), eq(storedFiles.id, fileId),
  )).limit(1) : [undefined];
  const variantIds = [...new Set(items.map(item => item.variantId))];
  const existingVariants = variantIds.length ? await db.select({
    id: retailProductVariants.id, barcode: retailProductVariants.barcode,
  }).from(retailProductVariants).where(and(
    eq(retailProductVariants.companyId, companyId),
    inArray(retailProductVariants.id, variantIds),
  )) : [];
  const currentBarcodes = new Map(existingVariants.map(variant => [variant.id, variant.barcode]));
  const barcodesMatch = items.every(item => currentBarcodes.get(item.variantId) === item.barcode);
  const movements = await db.select({
    eventKey: retailStockMovements.eventKey,
    variantId: retailStockMovements.variantId,
    quantityDelta: retailStockMovements.quantityDelta,
    barcode: sql<string>`${retailStockMovements.metadata}->>'barcode'`,
  }).from(retailStockMovements).where(and(
    eq(retailStockMovements.companyId, companyId),
    eq(retailStockMovements.referenceType, "supplier_purchase"),
    eq(retailStockMovements.referenceId, String(op.id)),
  ));
  const movementByRow = new Map(movements.map(row => [row.eventKey, row]));
  const movementsMatch = items.every(item => {
    const matched = movementByRow.get(`supplier-purchase:${op.id}:${item.rowNumber}`);
    return matched && matched.variantId === item.variantId &&
      Number(matched.quantityDelta) === item.quantity &&
      (matched.barcode == null || matched.barcode === item.barcode);
  }) && movements.length === items.length;
  const supplierId = numericId(data.supplierId);
  const locationId = numericId(data.locationId);
  const [[supplier], [location]] = await Promise.all([
    db.select({ name: companyScopedSuppliers.legalName }).from(companyScopedSuppliers)
      .where(and(eq(companyScopedSuppliers.companyId, companyId), eq(companyScopedSuppliers.id, supplierId))).limit(1),
    db.select({ name: locations.name }).from(locations)
      .where(and(eq(locations.companyId, companyId), eq(locations.id, locationId))).limit(1),
  ]);
  return {
    operationId: op.id,
    invoiceReference: String(data.invoiceReference ?? op.referenceId ?? ""),
    deliveryReference: typeof data.deliveryReference === "string" && data.deliveryReference ? data.deliveryReference : null,
    partialReceipt: data.partialReceipt === true,
    invoiceDate: String(data.invoiceDate ?? ""),
    createdAt: op.createdAt,
    createdBy: op.createdBy,
    supplierId, supplierName: supplier?.name ?? `Supplier #${supplierId}`,
    locationId, locationName: location?.name ?? `Location #${locationId}`,
    currency: String(data.currency ?? "USD"),
    exchangeRate: String(data.exchangeRate ?? "1"),
    purchaseTotal: String(data.purchaseTotal ?? "0"),
    baseTotal: String(data.baseTotal ?? "0"),
    voucherId: numericId(data.voucherId),
    items,
    totalUnits: items.reduce((sum, item) => sum + item.quantity, 0),
    movementsMatch,
    barcodesMatch,
    reprintAllowed: movementsMatch && barcodesMatch && items.length > 0,
    invoiceFile: invoiceFile ? {
      ...invoiceFile,
      downloadUrl: `/api/files/${invoiceFile.id}/download`,
    } : null,
  };
}

export async function findRetailSupplierPurchaseByRequest(companyId: number, idempotencyKey: string) {
  const [op] = await db.select({ id: retailStockOperations.id })
    .from(retailStockOperations).where(and(
      eq(retailStockOperations.companyId, companyId),
      eq(retailStockOperations.operationType, "supplier_purchase"),
      eq(retailStockOperations.idempotencyKey, idempotencyKey),
    )).limit(1);
  return op ? getRetailSupplierPurchaseDetail(companyId, op.id) : null;
}
