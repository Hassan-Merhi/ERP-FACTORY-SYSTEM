/** Date parsing helper for track-trace.com scraper. */
/** Parse a date string into YYYY-MM-DD. Returns null if unparseable. */
export function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s === "-" || s === "—" || s.toLowerCase() === "n/a") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ddMonYYYY = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{4})/);
  if (ddMonYYYY) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const m = months[ddMonYYYY[2].toLowerCase()];
    if (m) return `${ddMonYYYY[3]}-${m}-${ddMonYYYY[1].padStart(2, "0")}`;
  }
  const monDDYYYY = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (monDDYYYY) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const m = months[monDDYYYY[1].toLowerCase()];
    if (m) return `${monDDYYYY[3]}-${m}-${monDDYYYY[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
