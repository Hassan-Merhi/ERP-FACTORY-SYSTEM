// Extracted from ./schemaCompatibilityReportCases.ts
import { db, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";

export async function runSchemaCompatibilityUpcomingArrivals({
  todayDate,
  companyId,
  rowLimit,
}: {
  todayDate: DataQueryContext["todayDate"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const daysAhead = 30;
  const futureDate = new Date(todayDate.getTime() + daysAhead * 86400000).toISOString().slice(0, 10);
  const rows = await db.execute<{
    container_number: string;
    status: string;
    eta: string | null;
    supplier: string | null;
    transporter: string | null;
    tracking_location: string | null;
    days_until_eta: number | null;
  }>(sql`
        SELECT c.container_number, c.status, c.eta,
          s.legal_name AS supplier,
          c.transporter, c.tracking_location,
          CAST(c.eta AS date) - CURRENT_DATE AS days_until_eta
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND c.status NOT IN ('Offloaded', 'Arrived')
          AND c.eta IS NOT NULL
          AND CAST(c.eta AS date) <= ${futureDate}
        ORDER BY c.eta ASC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((r) => {
    const days = r.days_until_eta ?? 0;
    return [
      r.container_number,
      r.status,
      r.eta ? String(r.eta).slice(0, 10) : "—",
      days <= 0 ? "TODAY/OVERDUE" : `${days}d`,
      r.supplier,
      r.transporter || "—",
      r.tracking_location || "—",
    ];
  });
  return {
    queryType: "upcoming_arrivals",
    title: "Upcoming Container Arrivals",
    subtitle: `Next ${daysAhead} days · ${tableRows.length} container(s) expected`,
    table: {
      headers: ["Container #", "Status", "ETA", "Days Away", "Supplier", "Transporter", "Last Location"],
      rows: tableRows,
    },
    noData: tableRows.length === 0,
  };
}
