import { and, eq, inArray, sql } from "drizzle-orm";
import { retailProductVariants } from "@shared/schema";
import type { RetailTransaction } from "./retailStockLedger";

/**
 * In-store barcodes use the GS1 "restricted circulation" EAN-13 range (leading
 * digit 2). They never collide with real manufacturer EAN/UPC codes, are
 * accepted by every hardware scanner, and stay stable for the life of the
 * variant: generation only happens when a variant has no barcode yet.
 */
const GENERATED_PREFIX = "2";
const SEQUENCE_DIGITS = 11;

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error("EAN-13 body must be 12 digits");
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    const digit = Number(first12[index]);
    sum += index % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(value: string): boolean {
  return /^\d{13}$/.test(value) && ean13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

export function formatGeneratedRetailBarcode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= 10 ** SEQUENCE_DIGITS) {
    throw new Error("Retail barcode sequence is exhausted");
  }
  const body = `${GENERATED_PREFIX}${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;
  return `${body}${ean13CheckDigit(body)}`;
}

async function reserveSequenceBlock(tx: RetailTransaction, companyId: number, count: number): Promise<number> {
  // Atomic upsert-increment: concurrent callers receive disjoint blocks.
  const result = await tx.execute(sql`
    INSERT INTO retail_barcode_sequences (company_id, next_value, updated_at)
    VALUES (${companyId}, ${1 + count}, now())
    ON CONFLICT (company_id)
    DO UPDATE SET next_value = retail_barcode_sequences.next_value + ${count}, updated_at = now()
    RETURNING next_value - ${count} AS start_value
  `);
  const row = (result as unknown as { rows: Array<{ start_value: string | number }> }).rows[0];
  return Number(row.start_value);
}

/**
 * Issues `count` barcodes that are unique within the company. Values already
 * used by a manually entered barcode are skipped, never reassigned.
 */
export async function allocateRetailBarcodes(
  tx: RetailTransaction,
  companyId: number,
  count: number,
  reserved: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const issued: string[] = [];
  let attempts = 0;
  while (issued.length < count) {
    attempts += 1;
    if (attempts > 20) throw new Error("Could not allocate a unique retail barcode");
    const needed = count - issued.length;
    const start = await reserveSequenceBlock(tx, companyId, needed);
    const candidates = Array.from({ length: needed }, (_, index) => formatGeneratedRetailBarcode(start + index));
    const taken = await tx
      .select({ barcode: retailProductVariants.barcode })
      .from(retailProductVariants)
      .where(and(eq(retailProductVariants.companyId, companyId), inArray(retailProductVariants.barcode, candidates)));
    const takenSet = new Set(taken.map((row) => row.barcode));
    for (const candidate of candidates) {
      if (!takenSet.has(candidate) && !reserved.has(candidate)) issued.push(candidate);
    }
  }
  return issued;
}
