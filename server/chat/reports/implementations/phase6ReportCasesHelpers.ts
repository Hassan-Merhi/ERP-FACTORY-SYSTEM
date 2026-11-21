// Extracted from ./phase6ReportCases.ts
import { db, sql } from "./reportShardSupport";
import { toMoney, plusMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase6CustomerProformas({
  params,
  companyId,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const custFilter6 = params.entityName;
  const rows = await db.execute<{
    id: number;
    proforma_name: string;
    customer: string | null;
    is_active: boolean;
    created_at: Date;
    line_count: string;
    total_qty: string;
    total_value: string;
  }>(sql`
        SELECT cp.id, cp.name AS proforma_name, cu.legal_name AS customer,
          cp.is_active, cp.created_at,
          COUNT(cpl.id) AS line_count,
          COALESCE(SUM(cpl.quantity), 0) AS total_qty,
          COALESCE(SUM(CAST(cpl.price_per_bale AS numeric) * cpl.quantity), 0) AS total_value
        FROM customer_proformas cp
        JOIN customers cu ON cu.id = cp.customer_id
        LEFT JOIN customer_proforma_lines cpl ON cpl.proforma_id = cp.id
        WHERE cp.company_id = ${companyId}
          AND cp.deleted_at IS NULL
          ${custFilter6 ? sql`AND cu.legal_name ILIKE ${"%" + custFilter6 + "%"}` : sql``}
        GROUP BY cp.id, cp.name, cu.legal_name, cp.is_active, cp.created_at
        ORDER BY cp.is_active DESC, cu.legal_name
        LIMIT ${rowLimit}
      `);
  const tableRows6 = rows.rows.map((r) => [
    r.proforma_name,
    r.customer,
    String(r.line_count),
    String(r.total_qty),
    fmt(toMoney(r.total_value).toNumber()),
    r.is_active ? "Active" : "Inactive",
    String(r.created_at).slice(0, 10),
  ]);
  return {
    queryType: "customer_proformas",
    title: custFilter6 ? `Customer Proformas: ${custFilter6}` : "Customer Proformas",
    subtitle: `${tableRows6.length} proforma(s)`,
    table: {
      headers: ["Proforma", "Customer", "Items", "Total Qty", "Total Value", "Status", "Created"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}

export async function runPhase6FactoryMixBatches({
  params,
  companyId,
  rowLimit,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const statusFilter6 = params.entityName?.toUpperCase() || null;
  const rows = await db.execute<{
    batch_code: string;
    name: string | null;
    batch_date: string | null;
    status: string;
    total_kg: string | null;
    used_kg: string | null;
    cost_per_kg: string | null;
    total_cost: string | null;
    operator_user: string | null;
  }>(sql`
        SELECT fmb.batch_code, fmb.name, fmb.batch_date, fmb.status,
          CAST(fmb.total_weight_kg AS numeric) AS total_kg,
          CAST(fmb.used_kg AS numeric) AS used_kg,
          CAST(fmb.cost_per_kg AS numeric) AS cost_per_kg,
          CAST(fmb.total_cost AS numeric) AS total_cost,
          fmb.operator_user
        FROM factory_mix_batches fmb
        WHERE fmb.company_id = ${companyId}
          AND fmb.deleted_at IS NULL
          ${statusFilter6 ? sql`AND fmb.status = ${statusFilter6}` : sql``}
          ${params.dateFrom ? sql`AND fmb.batch_date >= ${params.dateFrom}` : sql``}
        ORDER BY fmb.batch_date DESC, fmb.id DESC
        LIMIT ${rowLimit}
      `);
  let totWeight = 0,
    totUsed = 0,
    totCost = 0;
  const tableRows6 = rows.rows.map((r) => {
    const totalKg = toMoney(r.total_kg).toNumber();
    const usedKg = toMoney(r.used_kg).toNumber();
    const remainKg = totalKg - usedKg;
    const pct = totalKg > 0 ? ((usedKg / totalKg) * 100).toFixed(1) + "%" : "—";
    totWeight += totalKg;
    totUsed += usedKg;
    totCost = plusMoney(totCost, r.total_cost);
    return [
      r.batch_code,
      r.name || "—",
      r.batch_date ? String(r.batch_date).slice(0, 10) : "—",
      r.status,
      fmtDec(totalKg),
      fmtDec(usedKg),
      fmtDec(remainKg),
      pct,
      fmtDec(toMoney(r.cost_per_kg).toNumber()),
      r.operator_user || "—",
    ];
  });
  const stats6 = [
    { label: "Batches", value: String(tableRows6.length) },
    { label: "Total Weight Kg", value: fmtDec(totWeight) },
    { label: "Used Kg", value: fmtDec(totUsed) },
    { label: "Remaining Kg", value: fmtDec(totWeight - totUsed), highlight: "positive" },
    { label: "Total Cost", value: fmt(totCost) },
  ];
  return {
    queryType: "factory_mix_batches",
    title: statusFilter6 ? `Mix Batches — ${statusFilter6}` : "Factory Mix Batches",
    subtitle: `${tableRows6.length} batch(es)`,
    stats: stats6,
    table: {
      headers: ["Code", "Name", "Date", "Status", "Total Kg", "Used Kg", "Remaining", "Usage%", "Cost/Kg", "Operator"],
      rows: tableRows6,
    },
    noData: tableRows6.length === 0,
  };
}
