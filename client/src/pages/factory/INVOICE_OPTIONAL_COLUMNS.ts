// Extracted from ./FactoryInvoices.tsx to keep that module under the source-size cap.
import type { InvoiceColumnKey } from "./factoryinvoices/InvoiceOrderRow";

// All permitted invoice columns are visible unless the user chooses to hide them.
export const INVOICE_OPTIONAL_COLUMNS: { key: InvoiceColumnKey; label: string }[] = [
  { key: "loading", label: "Loading #" },
  { key: "proforma", label: "Proforma" },
  { key: "container", label: "Container" },
  { key: "bookingInfo", label: "Booking Info" },
  { key: "destination", label: "Destination" },
  { key: "notes", label: "Notes" },
  { key: "date", label: "Date" },
  { key: "status", label: "Status" },
  { key: "bales", label: "Bales" },
  { key: "weight", label: "Weight" },
  { key: "remaining", label: "Remaining" },
  { key: "extras", label: "Extras" },
  { key: "total", label: "Total" },
];
