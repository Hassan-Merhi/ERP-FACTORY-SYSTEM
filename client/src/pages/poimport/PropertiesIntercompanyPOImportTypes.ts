// Extracted from ./PropertiesIntercompanyPOImport.tsx to keep that module under the source-size cap.
import { PROPERTIES_PO_IMPORT_ERRORS } from "@/i18n/propertiesPoImportTranslations";

export const API = "/api/intercompany-container-trading";

interface DestinationCompany {
  id: number;
  name: string;
  code: string;
}

interface PropertiesSupplier {
  id: number;
  companyId: number;
  legalName: string;
  code: string;
}

export interface TradingSetup {
  sourceCompanyId: number;
  destinations: DestinationCompany[];
  suppliers: PropertiesSupplier[];
  policies: Array<{ id: number; destinationCompanyId: number; tradeEnabled: boolean }>;
}

interface ImportContainer {
  containerNumber: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: number;
  chargesTotal: number;
  grandTotal: number;
  supplierCode: string;
}

export interface WorkbookPreview {
  fileName: string;
  sha256: string;
  rowCount: number;
  containers: ImportContainer[];
}

export interface AutoRelationship {
  relationshipId: number;
  destinationCompanyId: number;
  tradeEnabled: boolean;
}

export interface StockVerification {
  fileSha256: string;
  sourceCompanyId: number;
  verifiedRows: number;
  createdItemCount: number;
  reusedLineCount: number;
  rows: Array<{
    containerNumber: string;
    destinationCompanyId: number;
    excelRow: number;
    code: string;
    name: string;
    uom: string;
    sourceStockItemId: number;
    destinationStockItemId: number | null;
    action: "create" | "reuse";
  }>;
}

export interface ImportOutcome {
  batchId: number;
  createdDestinationStockItems: number;
  containerCount: number;
  totalIntercompanyCost: string;
  containers: Array<{
    containerNumber: string;
    destinationCompanyId: number;
    destinationPoId: number;
    sourcePoIds: number[];
    landedTotal: string;
  }>;
}

export async function postForm<T>(url: string, body: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body, credentials: "include" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: PROPERTIES_PO_IMPORT_ERRORS.fileProcessing }));
    throw new Error(error.message || PROPERTIES_PO_IMPORT_ERRORS.fileProcessing);
  }
  return (await response.json()) as T;
}
