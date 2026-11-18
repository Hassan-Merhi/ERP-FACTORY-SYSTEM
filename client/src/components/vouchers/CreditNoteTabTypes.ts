// Extracted from ./CreditNoteTab.tsx to keep that module under the source-size cap.
import { z } from "zod";
import type { CombinedAccount } from "@/components/AccountAutocomplete";

export interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
}

export interface InventoryItem {
  stockItemId: number;
  quantity: string;
  averageRate: string;
}

export interface Location {
  id: number;
  code?: string;
  name: string;
}

export interface CreditNoteItem {
  rowKey: string;
  stockItemId: number;
  stockItemName: string;
  locationId: number;
  locationName: string;
  quantity: string;
  refundRate: string;
  inventoryCost: string;
  uom: string;
}

let creditNoteRowSequence = 0;

export function nextCreditNoteRowKey(prefix = "row"): string {
  creditNoteRowSequence += 1;
  return `${prefix}-${Date.now()}-${creditNoteRowSequence}`;
}

export interface CreditNoteData {
  voucher: {
    id: number;
    voucherNumber: string;
    voucherType: string;
    voucherDate: string;
    description: string;
    totalAmount: string;
    currency?: string | null;
    exchangeRate?: string | number | null;
  };
  cashAccountId: number;
  cashAccountType: string;
  items: Array<{
    stockItemId: number;
    stockItemName: string;
    stockItemCode: string;
    locationId: number;
    locationName: string;
    quantity: string;
    refundRate: string;
    inventoryCost: string;
    uom: string;
  }>;
}

export const creditNoteSchema = z.object({
  noteType: z.enum(["Credit Note", "Debit Note"]),
  voucherDate: z.string().min(1, "Date is required"),
  cashAccountType: z.string().min(1, "Account type is required"),
  cashAccountId: z.number().min(1, "Cash/Bank account is required"),
  cashAccountName: z.string().optional(),
  description: z.string().optional(),
});

export type CreditNoteFormData = z.infer<typeof creditNoteSchema>;

export interface CreditNoteTabProps {
  allAccounts: CombinedAccount[];
  editVoucherId?: number | null;
}
