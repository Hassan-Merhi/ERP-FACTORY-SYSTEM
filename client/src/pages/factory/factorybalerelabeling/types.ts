/**
 * Types for the FactoryBaleRelabeling page.
 *
 * Extracted from FactoryBaleRelabeling.tsx during the Phase 4 god-file split.
 */
import { type A4DesignColor } from "@/lib/labelHtml";

export type Step = "upload" | "validate" | "done";

export interface ParsedRow {
  currentRef: string;
  rowNum: number;
}

export interface ValidationResult {
  currentRef: string;
  valid: boolean;
  error?: string;
  productName?: string;
  articleCode?: string;
  weightKg?: string;
  status?: string;
}

export interface ApplyItem {
  oldRef: string;
  newRef: string;
  productName: string;
  articleCode: string;
  weightKg: string;
}

export interface RelabelSession {
  id: number;
  createdAt: string | null;
  uploadedFilename: string | null;
  printFormat: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
}

export interface LabelPreviewCardProps {
  item: ApplyItem;
  designColor: A4DesignColor;
  printFormat: "A4" | "A5" | "STICKER";
}
