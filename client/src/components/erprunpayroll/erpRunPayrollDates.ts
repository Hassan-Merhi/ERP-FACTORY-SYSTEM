// Extracted from ./useERPRunPayrollModel.ts to keep that module under the source-size cap.

/** Ten consecutive "DD-Mon" column headers starting at the payroll run date. */
export function getRunDateHeaders(runDate: string): string[] {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const base = new Date(runDate + "T00:00:00");
  return Array.from({ length: 10 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}`;
  });
}
