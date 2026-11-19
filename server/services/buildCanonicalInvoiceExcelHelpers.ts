// Extracted from ./buildCanonicalInvoiceExcel.ts
import { sql } from "drizzle-orm";
import { db } from "../db";
import { buildSafeFilename } from "../lib/contentDisposition";
import { FACTORY_DOCUMENT_LABELS, type FactoryDocumentLanguage } from "./factoryDocumentLanguage";
import { type CanonicalInvoiceDocument, resultRows, safeString } from "./factoryInvoiceDocumentModel";
import { buildLiveCanonicalInvoiceDocument } from "./factoryInvoiceDocumentSource";

export function currencySymbol(currency: unknown): string {
  const code = safeString(currency, "USD").toUpperCase();
  return (
    (
      {
        USD: "$",
        GBP: "£",
        EUR: "€",
        CFA: "CFA",
        XOF: "CFA",
        XAF: "CFA",
      } as Record<string, string>
    )[code] ?? code
  );
}

export function excelMoneyFormat(currency: string): string {
  const symbol = currencySymbol(currency);
  if (symbol === "CFA") return '"CFA " #,##0.00';
  if (symbol.length <= 3) return `"${symbol}"#,##0.00`;
  return `"${symbol} "#,##0.00`;
}

function isCanonicalSnapshot(value: unknown): value is CanonicalInvoiceDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanonicalInvoiceDocument>;
  return candidate.version === 1 && Number.isInteger(candidate.orderId) && Array.isArray(candidate.lines);
}

async function readUsableSnapshot(orderId: number, companyId: number): Promise<CanonicalInvoiceDocument | null> {
  const result = await db.execute(sql`
    SELECT s.snapshot, co.status AS current_status
    FROM factory_invoice_document_snapshots s
    INNER JOIN customer_orders co ON co.id = s.order_id AND co.company_id = s.company_id
    WHERE s.order_id = ${orderId} AND s.company_id = ${companyId}
    LIMIT 1
  `);
  const row = resultRows<{ snapshot: unknown; current_status: unknown }>(result)[0];
  if (!row || String(row.current_status || "") !== "FINALIZED" || !isCanonicalSnapshot(row.snapshot)) return null;
  return row.snapshot;
}

async function persistSnapshot(document: CanonicalInvoiceDocument, force: boolean): Promise<CanonicalInvoiceDocument> {
  const frozen: CanonicalInvoiceDocument = {
    ...document,
    lines: document.lines.map((line) => ({ ...line })),
    charges: document.charges.map((charge) => ({ ...charge })),
    frozenAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(frozen);

  if (force) {
    await db.execute(sql`
      INSERT INTO factory_invoice_document_snapshots (order_id, company_id, snapshot, frozen_at, updated_at)
      VALUES (${document.orderId}, ${document.companyId}, ${payload}::jsonb, NOW(), NOW())
      ON CONFLICT (order_id) DO UPDATE
      SET company_id = EXCLUDED.company_id,
          snapshot = EXCLUDED.snapshot,
          frozen_at = EXCLUDED.frozen_at,
          updated_at = NOW()
    `);
    return frozen;
  }

  const inserted = await db.execute(sql`
    INSERT INTO factory_invoice_document_snapshots (order_id, company_id, snapshot, frozen_at, updated_at)
    VALUES (${document.orderId}, ${document.companyId}, ${payload}::jsonb, NOW(), NOW())
    ON CONFLICT (order_id) DO NOTHING
    RETURNING snapshot
  `);
  const insertedSnapshot = resultRows<{ snapshot: unknown }>(inserted)[0]?.snapshot;
  if (isCanonicalSnapshot(insertedSnapshot)) return insertedSnapshot;
  return (await readUsableSnapshot(document.orderId, document.companyId)) ?? frozen;
}

export async function getCanonicalInvoiceDocument(
  orderId: number,
  companyId: number
): Promise<CanonicalInvoiceDocument | null> {
  const existing = await readUsableSnapshot(orderId, companyId);
  if (existing) return existing;

  const live = await buildLiveCanonicalInvoiceDocument(orderId, companyId);
  if (!live) return null;
  if (live.status === "FINALIZED") return persistSnapshot(live, false);
  return live;
}

export async function freezeCanonicalInvoiceDocument(
  orderId: number,
  companyId: number,
  force = true
): Promise<CanonicalInvoiceDocument | null> {
  const live = await buildLiveCanonicalInvoiceDocument(orderId, companyId);
  if (!live) return null;
  if (live.status !== "FINALIZED") return live;
  return persistSnapshot(live, force);
}

export function buildCanonicalInvoiceFilename(document: CanonicalInvoiceDocument, extension: "xlsx" | "pdf"): string {
  return buildSafeFilename(
    [document.containerNumber, document.customerName, document.destination, document.invoiceNumber],
    extension
  );
}

export function unitPriceLabel(document: CanonicalInvoiceDocument, language: FactoryDocumentLanguage): string {
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const modes = new Set(document.lines.map((line) => line.pricingMode));
  if (modes.size > 1) return labels.unitPrice;
  return modes.has("per_kg") ? labels.pricePerKg : labels.pricePerBale;
}

export function concatBuffers(chunks: Buffer[]): Buffer {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(output, offset);
    offset += chunk.length;
  }
  return output;
}
