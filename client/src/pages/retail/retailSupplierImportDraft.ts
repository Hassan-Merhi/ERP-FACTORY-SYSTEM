/** Phase 1: client-side preflight only. NEVER post these rows to /api/retail/import:
 * the legacy endpoint sets absolute stock and does not create supplier payable. */
export interface RetailSupplierImportRow {
  rowNumber: number;
  name: string;
  brand: string;
  category: string;
  color: string;
  size: string;
  quantity: number;
  costPrice: number;
  sellingPrice: number;
  mainImage: string;
  extraImages: string[];
  sku: string;
  barcode: string;
  description: string;
  errors: string[];
  warnings: string[];
}

export const RETAIL_SUPPLIER_IMPORT_LIMIT = 5000;
export const RETAIL_SUPPLIER_TEMPLATE_COLUMNS = [
  "Item Name", "Category", "Brand", "Size", "Color", "Quantity",
  "Cost Price", "Selling Price", "Main Image", "Extra Images",
  "SKU", "Barcode", "Description",
] as const;

type SourceRow = { rowNumber: number; values: Record<string, unknown> };
const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[ _-]+/g, "");
const normalizeIdentity = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

function field(values: Record<string, unknown>, ...aliases: string[]): unknown {
  const keys = new Map(Object.entries(values).map(([key, value]) => [normalizeHeader(key), value]));
  for (const alias of aliases) {
    const value = keys.get(normalizeHeader(alias));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function asText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (typeof input === "number" && Number.isFinite(input)) return String(input);
  if (input == null) return "";
  return String(input).trim();
}

function validPrice(input: unknown): number | null {
  if (input === "" || input == null) return null;
  const raw = asText(input);
  // Reject formatted prices instead of guessing whether commas mean thousands or decimals.
  if (!/^(?:\d+)(?:\.\d{1,4})?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value <= 1_000_000_000 ? value : null;
}

export function parseRetailSupplierImportRows(sources: SourceRow[]): RetailSupplierImportRow[] {
  const seenVariants = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  const seenSkus = new Map<string, number>();

  return sources.map(({ rowNumber, values }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const name = asText(field(values, "Item Name", "Name"));
    const category = asText(field(values, "Category"));
    const brand = asText(field(values, "Brand")) || "Other / No Brand";
    const size = asText(field(values, "Size"));
    const color = asText(field(values, "Color")) || "Default";
    const qtyInput = asText(field(values, "Quantity", "Qty"));
    const costInput = field(values, "Cost Price", "Cost");
    const sellingInput = field(values, "Selling Price", "Price");
    const mainImage = asText(field(values, "Main Image", "Image", "ImageUrl", "VariantImageUrl"));
    const extraImageInput = asText(field(values, "Extra Images"));
    const extraImages = extraImageInput.split(/[;,|]/).map(value => value.trim()).filter(Boolean);
    const rawSku = field(values, "SKU", "Code");
    const rawBarcode = field(values, "Barcode");
    const sku = asText(rawSku);
    const barcode = asText(rawBarcode);
    const description = asText(field(values, "Description"));
    const quantity = Number(qtyInput);
    const costPrice = validPrice(costInput);
    const sellingPrice = validPrice(sellingInput);

    if (!name) errors.push("Item Name is required");
    if (!category) errors.push("Category is required");
    // Excel numeric cells silently remove leading zeroes and can round long
    // identifiers. Require explicit text for all scanner identities.
    if (typeof rawSku === "number") errors.push("SKU was stored as a number in Excel; format the column as Text and restore its original digits");
    if (typeof rawBarcode === "number") errors.push("Barcode was stored as a number in Excel; format the column as Text and restore its original digits");
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100000) {
      errors.push("Quantity must be an integer from 1 to 100,000");
    }
    if (costPrice === null) errors.push("Cost Price must be a non-negative number (up to 4 decimals)");
    if (sellingPrice === null) errors.push("Selling Price must be a non-negative number (up to 4 decimals)");
    if (barcode && !/^[a-zA-Z0-9-]{4,191}$/.test(barcode)) {
      errors.push("Barcode must be 4–191 letters, digits or hyphens");
    }
    if (sku.length > 191) errors.push("SKU must be 191 characters or fewer");
    if (name.length > 240) errors.push("Item Name must be 240 characters or fewer");
    if (brand.length > 120) errors.push("Brand must be 120 characters or fewer");
    if (category.length > 160) errors.push("Category must be 160 characters or fewer");
    if (size.length > 100 || color.length > 100) errors.push("Size and Color must be 100 characters or fewer");
    if (description.length > 5000) errors.push("Description must be 5000 characters or fewer");

    const variantKey = [sku ? normalizeIdentity(sku) : normalizeIdentity(brand) + "/" + normalizeIdentity(name),
      normalizeIdentity(color), normalizeIdentity(size)].join("|");
    if (name) {
      const prior = seenVariants.get(variantKey);
      if (prior !== undefined) errors.push(`Duplicate product/size/color (also Excel row ${prior})`);
      else seenVariants.set(variantKey, rowNumber);
    }
    if (barcode) {
      const prior = seenBarcodes.get(normalizeIdentity(barcode));
      if (prior !== undefined) errors.push(`Duplicate Barcode (also Excel row ${prior})`);
      else seenBarcodes.set(normalizeIdentity(barcode), rowNumber);
    }
    if (sku) {
      // SKU identifies a sellable variant; do not allow a single SKU for different variants.
      const prior = seenSkus.get(normalizeIdentity(sku));
      if (prior !== undefined) errors.push(`Duplicate SKU (also Excel row ${prior})`);
      else seenSkus.set(normalizeIdentity(sku), rowNumber);
    }
    if (!barcode) warnings.push("A barcode will be assigned when the supplier purchase is confirmed");
    if (mainImage || extraImages.length) warnings.push("Image filenames will be verified against the ZIP before the purchase is posted");

    return {
      rowNumber, name, category, brand, size, color,
      quantity: Number.isFinite(quantity) ? quantity : 0,
      costPrice: costPrice ?? 0, sellingPrice: sellingPrice ?? 0,
      mainImage, extraImages, sku, barcode, description, errors, warnings,
    };
  });
}

export function summarizeRetailSupplierImport(rows: RetailSupplierImportRow[]) {
  const valid = rows.filter(row => row.errors.length === 0);
  return {
    totalRows: rows.length,
    validRows: valid.length,
    invalidRows: rows.length - valid.length,
    totalUnits: valid.reduce((total, row) => total + row.quantity, 0),
    totalCost: valid.reduce((total, row) => total + Math.round(row.costPrice * row.quantity * 10000) / 10000, 0),
    // Not a booking, payable, inventory valuation or posted ledger entry.
  };
}
