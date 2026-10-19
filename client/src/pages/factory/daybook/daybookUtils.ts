/**
 * Pure helpers for the Factory Daybook page.
 *
 * Every function here is a pure transform of daybook rows or a static lookup
 * table - no React, no hooks, no I/O - which is what makes them safe to move
 * and cheap to unit test.
 */
import type { DaybookEntry, BaleMeta, DisplayEntry } from "./types";
import { formatFactoryBaleRemovalDescription } from "@shared/factoryBaleRemovalDescription";

/**
 * Overlay small live loading totals onto already-loaded daybook rows.
 * Retains untouched rows by reference, and never changes non-USD or unrelated
 * transactions. The amounts come from customer_orders, not client pricing.
 */
export function withLiveLoadingAmounts(
  entries: DaybookEntry[],
  amounts?: Record<string, string>
): DaybookEntry[] {
  if (!amounts) return entries;
  return entries.map((entry) => {
    if (entry.txType !== "LOADING_CREATED" || entry.referenceId == null || entry.currencyCode !== "USD") {
      return entry;
    }
    const amount = amounts[String(entry.referenceId)];
    if (amount == null || (amount === entry.amountCurrency && amount === entry.amountUsd)) return entry;
    return { ...entry, amountCurrency: amount, amountUsd: amount };
  });
}

export function parseBalesMeta(entry: DaybookEntry): BaleMeta[] {
  if (!entry.metaJson) return [];
  try {
    const parsed = JSON.parse(entry.metaJson);
    return Array.isArray(parsed.bales) ? parsed.bales : [];
  } catch {
    return [];
  }
}

// Merge multiple BALE_STOCK_ENTRY records (e.g. several batches in one day)
// into a single synthetic entry so the detail popup shows ALL bales together.
export function mergeBaleEntries(entries: DaybookEntry[]): DaybookEntry {
  if (entries.length === 1) return entries[0];
  const allBales = entries.flatMap((e) => parseBalesMeta(e));
  const totalCurrency = entries.reduce((s, e) => s + parseFloat(e.amountCurrency || "0"), 0);
  const totalUsd = entries.reduce((s, e) => s + parseFloat(e.amountUsd || "0"), 0);
  const base = entries[0];
  const productNames = [...new Set(allBales.map((b) => b.productName || b.ref || "Unknown"))];
  return {
    ...base,
    amountCurrency: totalCurrency.toFixed(2),
    amountUsd: totalUsd.toFixed(2),
    metaJson: JSON.stringify({ bales: allBales }),
    description: `${allBales.length} bales - ${productNames.join(" | ")}`,
  };
}

// Expand multi-bale BALE_STOCK_ENTRY rows into one virtual row per bale so
// each bale gets its own named row (like single-bale entries already do).
// The cost is divided equally across bales.
export function expandBaleEntries(entries: DaybookEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const e of entries) {
    if (e.txType === "BALE_STOCK_ENTRY") {
      const bales = parseBalesMeta(e);
      if (bales.length > 1) {
        const totalAmt = parseFloat(e.amountCurrency || "0");
        const totalUsd = parseFloat(e.amountUsd || "0");
        bales.forEach((bale, i) => {
          out.push({
            ...e,
            metaJson: JSON.stringify({ bales: [bale] }),
            amountCurrency: (totalAmt / bales.length).toFixed(2),
            amountUsd: (totalUsd / bales.length).toFixed(2),
            _vKey: `${e.id}_b${i}`,
            _source: e,
          } as DisplayEntry);
        });
        continue;
      }
    }
    out.push({ ...e, _vKey: String(e.id), _source: e } as DisplayEntry);
  }
  return out;
}

export function formatDaybookDescription(entry: DaybookEntry): string {
  if (entry.txType === "BALE_REMOVAL" && entry.metaJson) {
    try {
      const meta = JSON.parse(entry.metaJson);
      const references = parseBalesMeta(entry)
        .map((bale) => bale.ref)
        .filter((ref): ref is string => typeof ref === "string" && !!ref.trim());
      // Older rows already contain these details in metadata; display them
      // consistently without rewriting financial/audit history in the DB.
      if (references.length && typeof meta.actorName === "string" && meta.actorName.trim()) {
        return formatFactoryBaleRemovalDescription({
          references,
          username: meta.actorName,
          reason: typeof meta.reason === "string" ? meta.reason : "",
        });
      }
    } catch {
      // Legacy/malformed metadata: retain the original stored description.
    }
  }
  if (entry.txType === "BALE_STOCK_ENTRY") {
    const bales = parseBalesMeta(entry);
    if (bales.length === 1) return bales[0].productName || bales[0].ref || "Unknown";
    if (bales.length > 1) return `${bales.length} bales`;
    return entry.description
      .replace(/^Stock entry:\s*/i, "")
      .replace(/\d+ bales? - /i, "")
      .replace(/\s*[–-]\s*REF\w+/g, "")
      .replace(/,\s*REF\w+/g, "")
      .trim();
  }
  return entry.description;
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  AUD: "A$",
  LBP: "LL",
  LKR: "₨",
};
export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] || code + " ";
}

export const TX_TYPE_LABELS: Record<string, string> = {
  LOADING_CREATED: "Loading Started",
  CONTAINER_IMPORT: "Container Import",
  OFFLOAD_RAW_STOCK: "Offload Raw Stock",
  COMMISSION: "Commission",
  DUTY: "Duty",
  BALE_PRESSING: "Bale Pressing",
  BALE_FINALIZE: "Bale Finalize",
  BALE_STOCK_ENTRY: "Bale Stock Entry",
  BALE_REMOVAL: "Bale Removal",
  BALE_TRANSFER: "Bale Transfer",
  BALE_IMPORT: "Bale Import",
  BALE_REIMPORT: "Bale Reimport",
  OPENING_BALANCE_RAW: "Opening Balance",
  MIX_BATCH_CREATED: "Mix Batch Created",
  ORDER_VERIFIED: "Order Verified",
  INVOICE: "Invoice",
  PAYMENT: "Payment",
  RECEIPT: "Receipt",
  JOURNAL: "Journal",
  DOC_UPLOAD: "Doc Upload",
  DOC_DELETE: "Doc Delete",
  FREIGHT_ADD: "Freight Add",
  FREIGHT_DELETE: "Freight Delete",
  FREIGHT_PAYMENT: "Freight Payment",
  FREIGHT_PAYMENT_DELETE: "Freight Pmt Delete",
  WORKER_CREATED: "Worker Created",
  WORKER_EDITED: "Worker Edited",
  WORKER_IMPORT: "Worker Import",
  CONTRACT_ENDED: "Contract Ended",
  CONTRACT_SETTLED: "Contract Settled",
  WORKER_PHOTO_UPLOADED: "Worker Photo",
  PAYROLL_GENERATED: "Payroll Generated",
  PAYROLL_PAYMENT: "Payroll Payment",
  PAYROLL_STATUS_CHANGE: "Payroll Status",
  BALE_SALE: "POS Sale",
  POS_EXPENSE: "POS Deduction",
  SUPPLIER_PAYMENT: "Supplier Payment",
  SUPPLIER_PAYMENT_DELETE: "Supplier Pmt. Deleted",
  ORDER_CANCELLED: "Order Cancelled",
  REPORT_GENERATED: "Report Generated",
  PAYMENT_VOIDED: "Payment Voided",
  RECEIPT_VOIDED: "Receipt Voided",
  JOURNAL_VOIDED: "Journal Voided",
};

export function formatTxType(type: string): string {
  if (TX_TYPE_LABELS[type]) return TX_TYPE_LABELS[type];
  return type
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getFactoryTxTypeBadge(type: string): {
  variant: "default" | "secondary" | "destructive" | "outline";
  className?: string;
} {
  switch (type) {
    case "PAYMENT":
    case "SUPPLIER_PAYMENT":
    case "FREIGHT_PAYMENT":
    case "PAYROLL_PAYMENT":
      return { variant: "outline", className: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40" };
    case "RECEIPT":
      return {
        variant: "outline",
        className: "bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/40",
      };
    case "JOURNAL":
      return {
        variant: "outline",
        className: "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/40",
      };
    case "INVOICE":
      return { variant: "outline", className: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40" };
    case "CONTAINER_IMPORT":
      return {
        variant: "outline",
        className: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40",
      };
    case "COMMISSION":
    case "DUTY":
      return { variant: "outline", className: "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/40" };
    case "BALE_PRESSING":
    case "BALE_FINALIZE":
      return {
        variant: "outline",
        className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/40",
      };
    case "BALE_STOCK_ENTRY":
    case "BALE_IMPORT":
    case "BALE_REIMPORT":
    case "OPENING_BALANCE_RAW":
      return {
        variant: "outline",
        className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
      };
    case "BALE_SALE":
      return {
        variant: "outline",
        className: "bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/40",
      };
    case "POS_EXPENSE":
      return { variant: "outline", className: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40" };
    case "BALE_REMOVAL":
    case "BALE_TRANSFER":
      return { variant: "outline", className: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40" };
    case "OFFLOAD_RAW_STOCK":
      return {
        variant: "outline",
        className: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40",
      };
    case "FREIGHT_ADD":
      return {
        variant: "outline",
        className: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40",
      };
    case "LOADING_CREATED":
      return { variant: "outline", className: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40" };
    case "ORDER_VERIFIED":
      return { variant: "outline", className: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/40" };
    case "PAYROLL_GENERATED":
    case "WORKER_CREATED":
    case "WORKER_EDITED":
    case "WORKER_IMPORT":
    case "CONTRACT_ENDED":
    case "CONTRACT_SETTLED":
      return {
        variant: "outline",
        className: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/40",
      };
    default:
      return { variant: "outline" };
  }
}

export const VOUCHER_TX_TYPES: Record<string, string> = {
  PAYMENT: "payment",
  RECEIPT: "receipt",
  JOURNAL: "journal",
  INVOICE: "receipt",
  FREIGHT_PAYMENT: "payment",
  BALE_SALE: "factory_pos",
  POS_EXPENSE: "factory_pos",
};
