// Extracted from ./financialAndPartyReportShard.ts: report query handlers.
import { db, schema, eq, and, isNull, asc, ilike, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";
import { plusMoney, toMoney } from "../../../lib/money";

export async function runPhase1ContainersPendingOffload({
  companyId,
  rowLimit,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const pending = await db
    .select({
      containerNumber: schema.containers.containerNumber,
      status: schema.containers.status,
      eta: schema.containers.eta,
      transporter: schema.containers.transporter,
    })
    .from(schema.containers)
    .where(and(eq(schema.containers.companyId, companyId), isNull(schema.containers.offloadDate)))
    .orderBy(asc(schema.containers.eta))
    .limit(rowLimit);
  const tableRows = pending.map((c) => [c.containerNumber, c.status, c.eta || "—", c.transporter || "—"]);
  return {
    queryType: "containers_pending_offload",
    title: "Containers Pending Offload",
    subtitle: `${pending.length} container(s) not yet offloaded`,
    table: { headers: ["Container #", "Status", "ETA", "Transporter"], rows: tableRows },
    noData: pending.length === 0,
  };
}

export async function runPhase1ContainerStatus({
  params,
  userMessage,
  companyId,
}: {
  params: DataQueryContext["params"];
  userMessage: DataQueryContext["userMessage"];
  companyId: DataQueryContext["companyId"];
}) {
  const num = params.containerNumber || userMessage.match(/\b([A-Z]{4}\d{6,7})\b/)?.[1];
  if (!num) {
    return {
      queryType: "container_status",
      title: "Container Status",
      summary: "Please specify a container number (e.g. ABCU1234567).",
    };
  }
  const [container] = await db
    .select({
      containerNumber: schema.containers.containerNumber,
      status: schema.containers.status,
      importDate: schema.containers.importDate,
      eta: schema.containers.eta,
      offloadDate: schema.containers.offloadDate,
      transporter: schema.containers.transporter,
      trackingLocation: schema.containers.trackingLocation,
      trackingLastStatus: schema.containers.trackingLastStatus,
      trackingLastDescription: schema.containers.trackingLastDescription,
      trackingLastLocation: schema.containers.trackingLastLocation,
      borderDate: schema.containers.borderDate,
      grandTotal: schema.containers.grandTotal,
    })
    .from(schema.containers)
    .where(and(eq(schema.containers.companyId, companyId), ilike(schema.containers.containerNumber, `%${num}%`)))
    .limit(1);
  if (!container) {
    return {
      queryType: "container_status",
      title: `Container: ${num}`,
      summary: "Container not found.",
    };
  }
  const stats = [
    { label: "Container #", value: container.containerNumber, highlight: "neutral" },
    {
      label: "Status",
      value: container.status,
      highlight: container.status === "OFFLOADED" ? "positive" : "neutral",
    },
    { label: "Import Date", value: container.importDate || "—", highlight: "muted" },
    { label: "ETA", value: container.eta || "—", highlight: "muted" },
    {
      label: "Offload Date",
      value: container.offloadDate || "Not yet offloaded",
      highlight: container.offloadDate ? "positive" : "muted",
    },
    { label: "Transporter", value: container.transporter || "—", highlight: "muted" },
  ];
  if (container.trackingLastStatus)
    stats.push({ label: "Tracking Status", value: container.trackingLastStatus, highlight: "neutral" });
  if (container.trackingLastLocation)
    stats.push({ label: "Last Location", value: container.trackingLastLocation, highlight: "neutral" });
  if (container.trackingLastDescription)
    stats.push({ label: "Last Update", value: container.trackingLastDescription, highlight: "muted" });
  return {
    queryType: "container_status",
    title: `Container: ${container.containerNumber}`,
    subtitle: `Status: ${container.status}`,
    stats,
  };
}

export async function runPhase1BaleProduction({
  companyId,
  dateFrom,
  dateTo,
  fmtDec,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{ status: string; count: string; total_weight: string }>(sql`
        SELECT fb.status, COUNT(*) AS count,
          COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS total_weight
        FROM factory_bales fb
        WHERE fb.company_id = ${companyId} AND fb.deleted_at IS NULL
          AND fb.created_at::date BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY fb.status ORDER BY count DESC
      `);
  const totalBales = rows.rows.reduce((s: number, r) => s + parseInt(r.count || "0"), 0);
  const totalWeight = rows.rows.reduce((s: number, r) => plusMoney(s, r.total_weight), 0);
  const tableRows = rows.rows.map((r) => [
    String(r.status).replace(/_/g, " "),
    String(r.count),
    fmtDec(toMoney(r.total_weight).toNumber()) + " kg",
  ]);
  return {
    queryType: "bale_production",
    title: "Bale Production Summary",
    subtitle: `${dateFrom} to ${dateTo}`,
    stats: [
      { label: "Total Bales", value: fmt(totalBales), highlight: "positive" },
      { label: "Total Weight", value: fmtDec(totalWeight) + " kg", highlight: "positive" },
    ],
    table: tableRows.length > 0 ? { headers: ["Status", "Bales", "Weight"], rows: tableRows } : undefined,
    noData: totalBales === 0,
  };
}
