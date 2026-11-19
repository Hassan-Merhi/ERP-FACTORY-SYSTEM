// Extracted from ./PropertiesPaymentsPremium.tsx
import type { PaymentRow } from "../../RentalPaymentsLog";

export const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type PaymentsPeriod = "all" | "30days" | "month" | "year";

type Option = { value: string; label: string };

/** Properties Payments Log body; the page header and export menu are the shared ones in RentalPaymentsLog. */
export type Props = {
  payments: PaymentRow[];
  totalRecords: number;
  isLoading: boolean;
  isError: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  period: PaymentsPeriod;
  onPeriodChange: (value: PaymentsPeriod) => void;
  selectedUnit: string;
  onUnitChange: (value: string) => void;
  selectedTenant: string;
  onTenantChange: (value: string) => void;
  unitOptions: Option[];
  tenantOptions: Option[];
  totalAmount: string;
  amountLabel: string;
  /** Omitted for read-only roles: the delete action is hidden. */
  onDelete?: (payment: PaymentRow) => void;
};
