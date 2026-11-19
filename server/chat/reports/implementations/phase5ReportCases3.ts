// Extracted from ./phase5ReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase5DebitNoteSummary({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    voucher_date: string;
    voucher_number: string;
    description: string | null;
    amount: string;
    currency: string;
  }>(sql`
        SELECT v.voucher_date, v.voucher_number, v.description,
          CAST(v.total_amount AS numeric) AS amount, v.currency
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.voucher_type = 'Debit Note'
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  let totalDN = 0;
  const tableRows5 = rows.rows.map((r) => {
    const amt = toMoney(r.amount).toNumber();
    totalDN += amt;
    return [
      String(r.voucher_date).slice(0, 10),
      r.voucher_number,
      (r.description || "").slice(0, 50),
      fmt(amt),
      r.currency,
    ];
  });
  const stats5 = [
    { label: "Debit Notes Issued", value: String(tableRows5.length) },
    { label: "Total Amount", value: fmt(totalDN), highlight: "negative" },
  ];
  return {
    queryType: "debit_note_summary",
    title: "Debit Notes",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats5,
    table: { headers: ["Date", "Voucher #", "Description", "Amount", "Currency"], rows: tableRows5 },
    noData: tableRows5.length === 0,
  };
}
