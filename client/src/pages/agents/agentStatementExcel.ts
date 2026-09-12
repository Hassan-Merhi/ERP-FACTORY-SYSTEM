/**
 * Agent statement Excel export.
 *
 * Builds the statement rows (pure) and writes the workbook exactly as the
 * original inline handler in pages/Agents.tsx did — including the FX-rate
 * note row, the opening-balance row, and the column widths.
 */
import { format } from "date-fns";
import { utils, writeFile } from "@/lib/excelHelper";
import type { Account, GroupedVoucher } from "./agentStatementMath";

export interface AgentStatementExcelContext {
  account: Account;
  vouchersWithBalance: GroupedVoucher[];
  openingBalance: number;
  formatAmount: (value: number) => string;
  /** "USD @ rate 1.2345 per USD" style note, or null when not exporting in FX. */
  fxNote: string | null;
}

export function buildAgentStatementExcelRows(ctx: AgentStatementExcelContext): string[][] {
  const { account, vouchersWithBalance, openingBalance, formatAmount, fxNote } = ctx;

  // Build header row — include FX rate when exporting in a converted currency.
  const rows = [
    ["Ledger", "Type", "Debit", "Credit", "Running Balance", "Date", "Notes", ...(fxNote ? ["FX Rate"] : [])],
  ];
  if (fxNote) rows.push(["", "", "", "", "", "", "", fxNote]);
  const firstDate = vouchersWithBalance[0]?.voucherDate.split("T")[0] ?? "";
  const openingDateFmt = firstDate ? format(new Date(firstDate + "T00:00:00"), "dd MMM yyyy") : "";
  rows.push([account.name, "Opening Balance", "", "", formatAmount(openingBalance), openingDateFmt, ""]);
  for (const v of vouchersWithBalance) {
    const dateFmt = format(new Date(v.voucherDate.split("T")[0] + "T00:00:00"), "dd MMM yyyy");
    const note = v.voucherDescription?.trim() || v.narration?.trim() || "";
    rows.push([
      account.name,
      v.voucherType,
      v.totalDebit > 0 ? formatAmount(v.totalDebit) : "",
      v.totalCredit > 0 ? formatAmount(v.totalCredit) : "",
      formatAmount(v.runningBalance ?? 0),
      dateFmt,
      note,
    ]);
  }
  return rows;
}

export async function exportAgentStatementExcel(account: Account, rows: string[][]): Promise<void> {
  const wb = utils.book_new();
  utils.book_append_sheet(
    wb,
    {
      ...utils.aoa_to_sheet(rows),
      "!cols": [{ wch: 25 }, { wch: 14 }, { wch: 15 }, { wch: 15 }, { wch: 18 }, { wch: 14 }, { wch: 30 }],
    },
    account.name.substring(0, 31).replace(/[\\/*?[\]:]/g, "_")
  );
  await writeFile(wb, `Agent_Statement_${account.name.replace(/[\\/*?[\]:]/g, "_").substring(0, 40)}.xlsx`);
}
