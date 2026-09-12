/**
 * AI-powered PO text extraction for the PO file import feature.
 *
 * Parses any text content (PDF, CSV, Excel raw text) into a structured
 * purchase-order object regardless of layout or column names. Extracted from
 * chatService.ts; behaviour is unchanged.
 */
import { logger } from "../lib/logger";
import { getSelectedAIProvider, getAvailableProviders, callAIWithFallback } from "./aiProviders";

export interface ExtractedPurchaseOrder {
  poNumber: string;
  containerNumber: string;
  supplierName: string;
  supplierCode: string;
  importDate: string;
  currency: string;
  items: { name: string; code: string; quantity: number; rate: number }[];
  freight: number;
  surcharge: number;
  fumigation: number;
  documentCharges: number;
  discount: number;
  otherCharges: number;
}

export async function extractPOFromText(rawText: string): Promise<ExtractedPurchaseOrder | null> {
  const available = getAvailableProviders();
  if (!available.length) return null;

  const today = new Date().toISOString().split("T")[0];
  const systemPrompt = `You are a data extraction assistant. Extract purchase order data from the provided text and return ONLY valid JSON with no markdown, no explanation.

Required JSON structure:
{
  "poNumber": "string (PO/invoice number, or empty if not found)",
  "containerNumber": "string (container/shipment number, or empty if not found)",
  "supplierName": "string (supplier/vendor name, or empty)",
  "supplierCode": "string (supplier code, or empty)",
  "importDate": "string (YYYY-MM-DD format, use ${today} if not found)",
  "currency": "string (USD, EUR, etc. Default USD)",
  "items": [
    { "name": "string", "code": "string (barcode/SKU/item code or empty)", "quantity": number, "rate": number }
  ],
  "freight": number,
  "surcharge": number,
  "fumigation": number,
  "documentCharges": number,
  "discount": number,
  "otherCharges": number
}

Rules:
- items array must include every product/item line with quantity > 0 and rate > 0
- All numeric fields default to 0 if not found
- Return ONLY the JSON object, nothing else`;

  const selectedProvider = await getSelectedAIProvider();
  try {
    const { response } = await callAIWithFallback(
      selectedProvider,
      systemPrompt,
      [],
      `Extract PO data from this text:\n\n${rawText.slice(0, 8000)}`
    );
    const cleaned = response
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (err) {
    logger.error("[ChatService] extractPOFromText AI error:", { error: err });
    return null;
  }
}
