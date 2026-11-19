// Extracted from ./phase7ReportCases.ts
import { db, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";

export async function runPhase7ContainerTracking({
  params,
  companyId,
  rowLimit,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const cn7 = params.containerNumber || params.entityName;
  if (!cn7) {
    return {
      queryType: "container_tracking",
      title: "Container Tracking",
      summary: "Please specify a container number.",
    };
  }
  const containerRow7 = await db.execute<{
    id: number;
    container_number: string;
    status: string;
    eta: string | null;
    transporter: string | null;
    tracking_last_location: string | null;
    tracking_last_description: string | null;
    tracking_changed_at: Date | null;
  }>(sql`
        SELECT c.id, c.container_number, c.status, c.eta, c.transporter,
          c.tracking_last_location, c.tracking_last_description, c.tracking_changed_at
        FROM containers c
        WHERE c.company_id = ${companyId}
          AND c.container_number ILIKE ${"%" + cn7 + "%"}
        LIMIT 1
      `);
  if (!containerRow7.rows.length) {
    return {
      queryType: "container_tracking",
      title: "Container Tracking",
      summary: `No container found matching "${cn7}".`,
    };
  }
  const ctr7 = containerRow7.rows[0];
  const evtRows = await db.execute<{
    event_time: Date | null;
    event_status: string | null;
    event_location: string | null;
    event_description: string | null;
    provider: string | null;
  }>(sql`
        SELECT cte.event_time, cte.event_status, cte.event_location, cte.event_description, cte.provider
        FROM container_tracking_events cte
        WHERE cte.container_id = ${ctr7.id}
        ORDER BY cte.event_time DESC
        LIMIT ${rowLimit}
      `);
  const tableRows7 = evtRows.rows.map((r) => [
    r.event_time ? String(r.event_time).slice(0, 16) : "—",
    r.event_status || "—",
    r.event_location || "—",
    (r.event_description || "").slice(0, 50),
    r.provider,
  ]);
  const stats7 = [
    { label: "Container #", value: ctr7.container_number },
    { label: "Status", value: ctr7.status },
    { label: "ETA", value: ctr7.eta ? String(ctr7.eta).slice(0, 10) : "—" },
    { label: "Transporter", value: ctr7.transporter || "—" },
    { label: "Last Location", value: ctr7.tracking_last_location || "—" },
  ];
  return {
    queryType: "container_tracking",
    title: `Tracking: ${ctr7.container_number}`,
    subtitle: ctr7.tracking_last_description
      ? `Latest: ${(ctr7.tracking_last_description as string).slice(0, 60)}`
      : `${tableRows7.length} event(s)`,
    stats: stats7,
    table: { headers: ["Time", "Status", "Location", "Description", "Provider"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7AuditTrail({
  params,
  companyId,
  dateFrom,
  rowLimit,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const tableFilter7 = params.entityName;
  const rows = await db.execute<{
    username: string | null;
    action: string;
    table_name: string | null;
    record_identifier: string | null;
    created_at: Date;
  }>(sql`
        SELECT al.username, al.action, al.table_name, al.record_identifier,
          al.created_at
        FROM audit_log al
        WHERE al.company_id = ${companyId}
          AND al.created_at >= ${dateFrom}
          ${tableFilter7 ? sql`AND (al.table_name ILIKE ${"%" + tableFilter7 + "%"} OR al.record_identifier ILIKE ${"%" + tableFilter7 + "%"})` : sql``}
        ORDER BY al.created_at DESC
        LIMIT ${rowLimit}
      `);
  const actionMap: Record<string, number> = {};
  const tableRows7 = rows.rows.map((r) => {
    actionMap[r.action] = (actionMap[r.action] || 0) + 1;
    return [String(r.created_at).slice(0, 16), r.username, r.action, r.table_name, r.record_identifier || "—"];
  });
  const stats7 = [
    { label: "Total Events", value: String(tableRows7.length) },
    ...Object.entries(actionMap).map(([a, c]) => ({
      label: a.charAt(0).toUpperCase() + a.slice(1) + "s",
      value: String(c),
    })),
  ];
  return {
    queryType: "audit_trail",
    title: tableFilter7 ? `Audit Trail: ${tableFilter7}` : "Audit Trail",
    subtitle: `Since ${dateFrom} · most recent first`,
    stats: stats7,
    table: { headers: ["Timestamp", "User", "Action", "Table", "Record"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}
