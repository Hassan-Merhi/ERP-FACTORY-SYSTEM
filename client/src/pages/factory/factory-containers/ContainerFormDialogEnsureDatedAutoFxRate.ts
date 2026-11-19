// Extracted from ./ContainerFormDialog.tsx to keep that module under the source-size cap.
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import type { ContainerWithSupplier } from "./otwHelpers";
import type { ApiListRow } from "@shared/apiTypes";

/**
 * Strip unnecessary trailing decimal zeros without scientific notation.
 * "19780.000" → "19780"  "0.3800" → "0.38"  "1.18000000" → "1.18"
 */
export function stripTrailingZeros(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  if (!s || s === "null" || s === "undefined") return "";
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Normalize null / "null" / undefined / "undefined" to empty string. */
export function normalizeText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s === "null" || s === "undefined" ? "" : s;
}

export type FormData = {
  containerNumber: string;
  supplierId: string;
  origin: string;
  totalKg: string;
  ratePerKg: string;
  arrivalDate: string;
  notes: string;
  status: string;
  commissionAmount: string;
  commissionCurrencyCode: string;
  commissionAccountId: string;
  commissionSupplierId: string;
  commissionNotes: string;
  freight: string;
  freightCurrencyCode: string;
  freightAccountId: string;
  freightPaidBy: "supplier" | "own";
  freightSupplierId: string;
  freightOwnAccountId: string;
  otherCharges: string;
  otherChargesAccountId: string;
};

export type OtherChargeLine = { amount: string; currencyCode: string; ledgerAccountId: string; narration: string };

/**
 * An auto quote is read-only until it is explicitly recorded. Confirm it via
 * the audited FX endpoint before a container write that needs a dated rate.
 * Never silently use today's quote for an older arrival date.
 */
export async function ensureDatedAutoFxRate(currencyCode: string, arrivalDate: string): Promise<void> {
  if (currencyCode === "USD") return;
  const date = arrivalDate.trim();
  const lookupPath = date
    ? `/api/factory/fx-rates/${currencyCode}/${date}`
    : `/api/factory/fx-rates/latest/${currencyCode}`;
  const lookupResponse = await factoryApiRequest("GET", lookupPath);
  if (!lookupResponse.ok) {
    const error = await lookupResponse.json().catch(() => null);
    throw new Error(error?.message || `No ${currencyCode} exchange rate is available for this container date.`);
  }
  const lookup = (await lookupResponse.json()) as { saved?: boolean };
  if (lookup.saved) return;

  // Saving is a user-initiated action (Create/Update), not a side effect of a
  // read or opening the dialog. The server records the FX rate and audit trail.
  const confirmResponse = await factoryApiRequest("POST", "/api/factory/fx-rates/fetched", {
    currencyCode,
    ...(date ? { date } : {}),
  });
  if (!confirmResponse.ok) {
    if (confirmResponse.status === 403) {
      throw new Error("An Admin or Owner must confirm the dated factory auto exchange rate.");
    }
    const error = await confirmResponse.json().catch(() => null);
    throw new Error(
      error?.message ||
        `Unable to confirm the dated ${currencyCode} auto exchange rate. An Admin or Owner must record it first.`
    );
  }
}

export const BLANK_FORM: FormData = {
  containerNumber: "",
  supplierId: "",
  origin: "",
  totalKg: "",
  ratePerKg: "",
  arrivalDate: "",
  notes: "",
  status: "PENDING",
  commissionAmount: "",
  commissionCurrencyCode: "USD",
  commissionAccountId: "",
  commissionSupplierId: "",
  commissionNotes: "",
  freight: "",
  freightCurrencyCode: "USD",
  freightAccountId: "",
  freightPaidBy: "supplier",
  freightSupplierId: "",
  freightOwnAccountId: "",
  otherCharges: "",
  otherChargesAccountId: "",
};

export interface ContainerFormDialogProps {
  open: boolean;
  editingContainer: ContainerWithSupplier | null;
  suppliers: FactorySupplier[] | undefined;
  ledgerAccounts: ApiListRow[];
  onClose: () => void;
}
