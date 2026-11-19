// Extracted from ./RetailVariantReports.tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface StockRow {
  variantId: number;
  brand: string;
  style: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
  quantity: number;
  lowStockThreshold: number;
  stockValue: number;
  locations: string;
  lastSaleAt: string | null;
}

export interface SalesRow {
  variantId: number;
  brand: string;
  style: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
  soldQuantity: number;
  returnedQuantity: number;
  netQuantity: number;
  netRevenue: number;
  netCost: number;
  profit: number;
}

export type ReportKind = "stock" | "sales";

export const selectClass = "h-10 px-2 text-sm";

const ALL = "__all__";

/** Filter dropdown whose "All" choice keeps the empty-string state value. */
export function FilterSelect({
  label,
  allLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  allLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger className={selectClass} aria-label={label}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const STATUS_OPTIONS = [
  { value: "all", label: "All stock" },
  { value: "in", label: "In stock" },
  { value: "low", label: "Low stock" },
  { value: "out", label: "Out of stock" },
  { value: "slow", label: "Slow-moving" },
];
