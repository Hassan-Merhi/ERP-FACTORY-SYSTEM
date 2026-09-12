/**
 * Types for the StockTransferForm page.
 *
 * Extracted from StockTransferForm.tsx during the Phase 4 god-file split.
 */
import { z } from "zod";
import { stockTransferFormSchema } from "./utils";

export interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
}

export interface Location {
  id: number;
  code?: string;
  name: string;
}

export type StockTransferFormData = z.infer<typeof stockTransferFormSchema>;

export interface StockTransferFormProps {
  voucherIdToEdit: number | null;
  isPOS: boolean;
  posUser?: { assignedLocationId?: number | null };
}
