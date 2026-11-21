// Extracted from ./phase4ReportCases.ts
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase4UpcomingArrivals({
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
    import_date: string | null;
    grand_total: string;
    currency: string;
    days_until_eta: number | null;
  }>(sql`
        SELECT c.container_number, c.status, c.eta,
          s.legal_name AS supplier,
          c.transporter, c.tracking_location,
          c.import_date,
          CAST(c.grand_total AS numeric) AS grand_total,
          c.currency,
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
  const tableRows4 = rows.rows.map((r) => {
    const days = r.days_until_eta ?? 0;
    const daysLabel = days <= 0 ? "TODAY/OVERDUE" : `${days}d`;
    return [
      r.container_number,
      r.status,
      String(r.eta).slice(0, 10),
      daysLabel,
      r.supplier,
      r.transporter || "—",
      r.tracking_location || "—",
    ];
  });
  return {
    queryType: "upcoming_arrivals",
    title: "Upcoming Container Arrivals",
    subtitle: `Next ${daysAhead} days · ${tableRows4.length} container(s) expected`,
    table: {
      headers: ["Container #", "Status", "ETA", "Days Away", "Supplier", "Transporter", "Last Location"],
      rows: tableRows4,
    },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4WorkerProductivity({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const rows = await db.execute<{
    full_name: string;
    total_bales: string;
    total_kg: string;
    avg_kg_per_bale: string;
  }>(sql`
        SELECT fw.full_name,
          COUNT(fb.id) AS total_bales,
          COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS total_kg,
          COALESCE(AVG(CAST(fb.weight_kg AS numeric)), 0) AS avg_kg_per_bale
        FROM factory_bales fb
        JOIN factory_workers fw ON fw.id = fb.worker_id
        WHERE fb.company_id = ${companyId}
          AND fb.status = 'Pressed'
          AND CAST(fb.pressed_at AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY fw.id, fw.full_name
        ORDER BY total_bales DESC
        LIMIT ${rowLimit}
      `);
  const tableRows4 = rows.rows.map((r, i) => [
    String(i + 1),
    r.full_name,
    String(r.total_bales),
    fmtDec(toMoney(r.total_kg).toNumber()),
    fmtDec(toMoney(r.avg_kg_per_bale).toNumber()),
  ]);
  return {
    queryType: "worker_productivity",
    title: "Worker Productivity Ranking",
    subtitle: `${dateFrom} → ${dateTo} · by bales pressed`,
    table: { headers: ["Rank", "Worker", "Bales", "Total Kg", "Avg Kg/Bale"], rows: tableRows4 },
    noData: tableRows4.length === 0,
  };
}

export async function runPhase4PosSalesSummary({
  params,
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const itemFilter = params.entityName;
  const rows = await db.execute<{
    product_name: string;
    article_code: string | null;
    total_qty: string | null;
    total_revenue: string | null;
    num_sales: string;
    currency_code: string | null;
  }>(sql`
        SELECT fpsi.product_name, fpsi.article_code,
          SUM(fpsi.quantity) AS total_qty,
          SUM(CAST(fpsi.total_amount AS numeric)) AS total_revenue,
          COUNT(DISTINCT fps.id) AS num_sales,
          fpsi.currency_code
        FROM factory_pos_sale_items fpsi
        JOIN factory_pos_sales fps ON fps.id = fpsi.sale_id AND fps.status = 'COMPLETED'
        WHERE fps.company_id = ${companyId}
          AND CAST(fps.tx_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${itemFilter ? sql`AND fpsi.product_name ILIKE ${"%" + itemFilter + "%"}` : sql``}
        GROUP BY fpsi.product_name, fpsi.article_code, fpsi.currency_code
        ORDER BY total_revenue DESC
        LIMIT ${rowLimit}
      `);
  const totalsRow = await db.execute<{ num_transactions: string; grand_total: string | null }>(sql`
        SELECT COUNT(id) AS num_transactions,
          SUM(CAST(total_amount AS numeric)) AS grand_total
        FROM factory_pos_sales
        WHERE company_id = ${companyId} AND status = 'COMPLETED'
          AND CAST(tx_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
      `);
  const t4 = totalsRow.rows[0];
  const tableRows4 = rows.rows.map((r) => {
    const rev = toMoney(r.total_revenue).toNumber();
    return [r.product_name, r.article_code || "—", String(r.total_qty), fmt(rev), r.currency_code, String(r.num_sales)];
  });
  const stats4 = [
    { label: "Total Transactions", value: String(t4?.num_transactions || 0) },
    {
      label: "Grand Total Revenue",
      value: fmt(toMoney(t4?.grand_total).toNumber()),
      highlight: "positive",
    },
  ];
  return {
    queryType: "pos_sales_summary",
    title: itemFilter ? `POS Sales: ${itemFilter}` : "POS Sales Summary",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats4,
    table: {
      headers: ["Product", "Article Code", "Qty", "Revenue", "Currency", "Sales"],
      rows: tableRows4,
    },
    noData: tableRows4.length === 0,
  };
}
