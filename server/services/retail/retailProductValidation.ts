import type { RetailProductWrite } from "@shared/schema";

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export function validateRetailVariantPayload(input: RetailProductWrite): void {
  const barcodes = new Set<string>();
  const variantKeys = new Set<string>();

  for (const variant of input.variants) {
    const barcode = normalize(variant.barcode);
    const variantKey = `${normalize(variant.color)}|${normalize(variant.size)}`;

    // Blank barcodes are issued by the server, so only typed barcodes can collide here.
    if (barcode && barcodes.has(barcode)) throw new Error(`Duplicate barcode in product: ${variant.barcode}`);
    if (variantKeys.has(variantKey)) {
      throw new Error(`Duplicate color/size in product: ${variant.color} / ${variant.size}`);
    }

    if (barcode) barcodes.add(barcode);
    variantKeys.add(variantKey);

    const locationIds = new Set<number>();
    for (const stock of variant.stocks) {
      if (locationIds.has(stock.locationId)) {
        throw new Error(`Location ${stock.locationId} is repeated for size ${variant.size}`);
      }
      locationIds.add(stock.locationId);
    }
  }
}
