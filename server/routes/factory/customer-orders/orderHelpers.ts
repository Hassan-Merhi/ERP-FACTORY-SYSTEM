import { buildSafeFilename as buildExportFilename } from "../../../lib/contentDisposition";
import {
  buildCanonicalInvoiceExcel,
  getCanonicalInvoiceDocument,
} from "../../../services/factoryInvoiceDocumentService";

export { buildExportFilename };

/**
 * Shared Commercial Invoice Excel builder.
 *
 * This is intentionally a very small adapter: browser downloads, automatic
 * WhatsApp sends and shipping ZIP packages must all render the exact same
 * canonical invoice document instead of independently rebuilding order data.
 */
export async function buildOrderExcelBuffer(
  orderId: number,
  companyId: number,
  hideSelling: boolean
): Promise<{ buffer: Buffer; fileName: string }> {
  const document = await getCanonicalInvoiceDocument(orderId, companyId);
  if (!document) throw new Error(`Order ${orderId} not found for company ${companyId}`);

  return buildCanonicalInvoiceExcel(document, {
    hideSelling,
    noCharges: false,
    language: "en",
  });
}
