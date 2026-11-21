// Extracted from ./RentalPaymentsLog.tsx
import { type RentalModule } from "@/properties/config/rentalModulePolicy";

export const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type PaymentRow = {
  id: number;
  paymentDate: string;
  amount: string;
  forYear: number;
  forMonth: number;
  notes: string | null;
  contractId: number;
  unitId: number;
  currency?: string;
  cashAccountId: number | null;
  voucherId: number | null;
  tenantName: string | null;
  unitNumber: string | null;
  locationGroup: string | null;
  sourceModule?: string;
  reconciliationCategory?: "ACTIVE_RENT" | "GUARANTEE" | "ENDED_RENT" | "SCHEDULED" | "OTHER";
  postingStatus?: string;
  receiptKind?: string;
  readOnly?: boolean;
};

export interface Props {
  testIdPrefix: string;
  rentalModule: RentalModule;
}
