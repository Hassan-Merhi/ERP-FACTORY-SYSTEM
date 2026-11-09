import { paymentDayKey } from "./rentalReportingPresentation";
import type { RentalModule } from "./rentalModulePolicy";

/** Render the recorded calendar date without interpreting it in the browser's timezone. */
export function rentalPaymentDateLabel(rawDate: string): string {
  const day = paymentDayKey(rawDate);
  if (!day) return rawDate || "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(day + "T00:00:00.000Z"));
}

/** A single presentation policy; server authorization is authoritative. */
export function mayOfferRentalPaymentDelete(
  sourceModule: string | undefined,
  readOnly: boolean | undefined,
  pageModule: "PROPERTIES" | "ERP" | "FACTORY",
): boolean {
  return !readOnly && (pageModule !== "PROPERTIES" || sourceModule === "PROPERTIES");
}

/** Explicitly describe server-side retirement without assuming a transfer exists. */
export function rentalPaymentDeletionImpact(module: RentalModule): string {
  if (module === "PROPERTIES") {
    return "Its associated accounting entries will be retired. Properties receipts do not automatically transfer money to another company; any previously linked transfer, if present, will also be retired. This cannot be undone.";
  }
  return "Its associated accounting entries will be retired. Any linked inter-company transfer, if present, will also be retired in the relevant companies. This cannot be undone.";
}
