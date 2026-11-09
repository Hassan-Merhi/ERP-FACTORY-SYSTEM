import { paymentDayKey } from "./rentalReportingPresentation";

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
