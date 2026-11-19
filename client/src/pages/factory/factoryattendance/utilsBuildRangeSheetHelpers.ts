// Extracted from ./utilsBuildRangeSheet.tsx

export const STATUS_COLORS: Record<string, string> = {
  Present: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  Absent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  Late: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "Half Day": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  Leave: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

export // Format a Date as YYYY-MM-DD using local time (not UTC) to avoid
// timezone-shift bugs where toISOString() returns the previous day in UTC+ zones.
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayStr() {
  return localDateStr(new Date());
}

export const LABELS = {
  en: {
    title: "Weekly Attendance Sheet",
    resultTitle: "Weekly Attendance Report",
    workerName: "Worker Name",
    notes: "Notes / Signature",
    preparedBy: "Prepared By",
    supervisor: "Supervisor",
    approvedBy: "Approved By",
    totalWorkers: "Total Workers",
    week: "Week",
    shift: "Shift",
    present: "P = Present",
    absent: "A = Absent",
    mark: "Mark P / A or \u2713 / \u2717 in each cell",
  },
  ar: {
    title: "\u0643\u0634\u0641 \u0627\u0644\u062D\u0636\u0648\u0631 \u0627\u0644\u0623\u0633\u0628\u0648\u0639\u064A",
    resultTitle:
      "\u062A\u0642\u0631\u064A\u0631 \u0627\u0644\u062D\u0636\u0648\u0631 \u0627\u0644\u0623\u0633\u0628\u0648\u0639\u064A",
    workerName: "\u0627\u0633\u0645 \u0627\u0644\u0639\u0627\u0645\u0644",
    notes: "\u0645\u0644\u0627\u062D\u0638\u0627\u062A / \u062A\u0648\u0642\u064A\u0639",
    preparedBy: "\u0623\u0639\u062F\u0647",
    supervisor: "\u0627\u0644\u0645\u0634\u0631\u0641",
    approvedBy: "\u0627\u0639\u062A\u0645\u062F\u0647",
    totalWorkers: "\u0645\u062C\u0645\u0648\u0639 \u0627\u0644\u0639\u0645\u0627\u0644",
    week: "\u0627\u0644\u0623\u0633\u0628\u0648\u0639",
    shift: "\u0627\u0644\u0648\u0631\u062F\u064A\u0629",
    present: "\u062D = \u062D\u0627\u0636\u0631",
    absent: "\u063A = \u063A\u0627\u0626\u0628",
    mark: "\u0636\u0639 \u062D / \u063A \u0623\u0648 \u2713 / \u2717 \u0641\u064A \u0643\u0644 \u062E\u0627\u0646\u0629",
  },
} as const;

export type AttendancePersonKind = "worker" | "employee";

export const WEEKLY_CSS = `
  @page { size: A4 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, 'Noto Sans Arabic', sans-serif; font-size: 7.5pt; color: #111; margin: 0; }
  h1 { font-size: 13pt; text-align: center; margin: 0 0 2px; }
  .subtitle { text-align: center; font-size: 8pt; color: #555; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; table-layout: fixed; }
  col.col-num   { width: 3%; }
  col.col-name  { width: 22%; }
  col.col-day   { width: 10%; }
  col.col-notes { width: 13%; }
  th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 2px; font-size: 7pt; text-align: center; white-space: nowrap; overflow: hidden; }
  th.name-col { text-align: left; }
  td { border: 1px solid #ccc; padding: 2px 3px; font-size: 7.5pt; vertical-align: middle; height: 17px; }
  td.num { text-align: center; color: #888; }
  td.name { text-align: left; unicode-bidi: plaintext; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.day { text-align: center; }
  td.notes { font-size: 7pt; }
  tr:nth-child(even) td { background: #f7f7f7; }
  .legend { margin-top: 6px; font-size: 7pt; color: #555; text-align: center; }
  .legend span { margin: 0 10px; }
  .footer { margin-top: 12px; display: flex; justify-content: space-between; font-size: 7.5pt; }
  .footer div { border-top: 1px solid #333; padding-top: 3px; width: 120px; text-align: center; }
  @media print { button { display: none; } }
`;

export const WEEKLY_COLGROUP = `
  <colgroup>
    <col class="col-num">
    <col class="col-name">
    <col class="col-day"><col class="col-day"><col class="col-day">
    <col class="col-day"><col class="col-day"><col class="col-day">
    <col class="col-notes">
  </colgroup>
`;

export const STATUS_MARKS: Record<string, string> = {
  Present: "\u2713",
  Absent: "\u2717",
  Late: "L",
  "Half Day": "\u00BD",
  Leave: "\u2014",
};
