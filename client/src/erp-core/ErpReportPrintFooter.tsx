import { useErpDateFormat } from "./erpDisplay";

/**
 * Visible in browser print/save-as-PDF only; uses the user's chosen date
 * format and identifies the company and active report period.
 */
export function ErpReportPrintFooter({
  title,
  companyName,
  fromDate,
  toDate,
  generatedAt = new Date(),
}: {
  title: string;
  companyName?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  generatedAt?: Date;
}) {
  const { formatDisplayDate, formatDisplayDateTime, formatDisplayTime } = useErpDateFormat();
  // Some embedded/legacy report providers expose only the date formatter.
  // Keep printable reports usable without changing the active user preference.
  const generatedLabel =
    typeof formatDisplayDateTime === "function"
      ? formatDisplayDateTime(generatedAt)
      : `${formatDisplayDate(generatedAt)}${typeof formatDisplayTime === "function" ? `, ${formatDisplayTime(generatedAt)}` : ""}`;
  const period = fromDate || toDate
    ? `${fromDate ? formatDisplayDate(fromDate) : "Beginning"} – ${toDate ? formatDisplayDate(toDate) : "Present"}`
    : "All dates";

  return (
    <footer className="hidden border-t pt-2 text-xs text-muted-foreground print:block" data-erp-print-footer="">
      <span className="font-medium">{title}</span>
      {companyName ? <span> · {companyName}</span> : null}
      <span> · {period}</span>
      <span> · Generated {generatedLabel}</span>
    </footer>
  );
}
