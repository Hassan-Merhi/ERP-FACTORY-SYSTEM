import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
/**
 * Phase 9 — one Excel workbook with order summary, all trips, charges, PO
 * exports, signed invoice and explicitly bounded chronological audit history.
 * No ERP PO import occurs here. All user-supplied strings are safe text cells.
 */
import type ExcelJS from "exceljs";
import { createWorkbook } from "../../../excelHelper";
import type { FactoryDispatchOrderOverview } from "./loadingDispatchOrderOverviewData";
import type { DispatchHistoryEntry } from "./loadingDispatchOrderHistoryData";

type Cell = string | number | null;
const safe = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = typeof v === "string" ? v : JSON.stringify(v);
  let lead = 0;
  while (lead < t.length && t.charCodeAt(lead) <= 32) lead++;
  return /[\t\r\n]/.test(t.slice(0, lead)) || (lead < t.length && "=+@-".includes(t[lead])) ? "'" + t : t;
};
const money = (v: string | null) => (v === null ? null : Number(v));
const date = (v: string | null) => (v ? new Date(v).toISOString().replace("T", " ").replace("Z", " UTC") : null);
function sheet(wb: ExcelJS.Workbook, title: string, head: string[], lines: Cell[][], moneyColumns: number[] = []) {
  const ws = wb.addWorksheet(title, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(head);
  lines.forEach((line) => ws.addRow(line.map(safe)));
  ws.columns = head.map((h, i) => ({
    width: Math.max(
      15,
      Math.min(54, Math.max(h.length + 3, ...lines.slice(0, 70).map((row) => String(row[i] ?? "").length + 2)))
    ),
  }));
  const header = ws.getRow(1);
  header.height = 27;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3560" } };
  header.alignment = { vertical: "middle", wrapText: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: head.length } };
  for (const index of moneyColumns) ws.getColumn(index).numFmt = "#,##0.00;[Red](#,##0.00);0.00";
  for (let i = 2; i <= ws.rowCount; i++) {
    if (i % 2 === 0)
      ws.getRow(i).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF2F6FC" },
      };
    ws.getRow(i).alignment = { vertical: "middle" };
  }
  ws.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  return ws;
}
export function buildFactoryDispatchOrderDashboardWorkbook(
  data: FactoryDispatchOrderOverview,
  history: DispatchHistoryEntry[],
  historyHasMore: boolean
): ExcelJS.Workbook {
  const wb = createWorkbook();
  wb.creator = "HMD Factory Dispatch";
  wb.title = "Factory loading #" + data.order.id + " — Order dashboard";
  wb.subject = "Signed multi-truck overview, financial postings and manual ERP PO export evidence";
  wb.created = new Date();
  const s = data.summary;
  const statuses: Cell[][] = [
    ["Generated (UTC)", date(data.generatedAt)],
    ["Loading / Order ID", data.order.id],
    ["Container", data.order.containerNumber],
    ["Customer", data.order.customerName],
    ["Order status", data.order.status],
    ["Final invoice number", data.invoice?.invoiceNumber ?? data.order.invoiceNumber],
    ["Financial schema installed", data.schemaReady ? "Yes" : "NO — NOT INSTALLED"],
    ["All trips", s.tripCount],
    ["Closed trips", s.closedTrips],
    ["Open trips", s.openTrips],
    ["Remaining Pending Loading bales", s.originalLoadingBales],
    ["Active scanned bale events", s.scannedBales],
    ["Unique shipped bale IDs", s.uniqueScannedBales],
    ["Unshipped Pending Loading bales", s.unshippedBales],
    ["Unexpected scanned bales", s.unexpectedScannedBales],
    ["Posted goods (USD)", money(s.goodsSubtotal)],
    ["Posted customer-billable trip charges (USD)", money(s.billableCharges)],
    ["Posted customer discounts (USD)", money(s.discounts)],
    ["Existing truck receivable, already posted (USD)", money(s.tripCustomerTotal)],
    ["Original loading charges (USD)", money(s.originalOrderCharges)],
    ["One finalized customer invoice (USD)", money(s.invoiceTotal)],
    ["Posted internal trip expenses (USD)", money(s.internalExpenses)],
    ["Generated ERP PO Excel files", s.generatedPoFiles],
    ["ERP PO imported into Normal ERP?", "UNKNOWN — manual import not verified by Factory"],
    ["Order reconciliation signed", s.signed ? "Yes" : "No"],
    ["One invoice finalized", s.finalized ? "Yes" : "No"],
    ["Invoice identity matches original order", s.invoiceConsistent ? "Yes" : "Not verified"],
    ...data.notices.map((note, i): Cell[] => ["Notice " + (i + 1), note]),
  ];
  sheet(wb, "Order Overview", ["Field", "Value"], statuses);
  sheet(
    wb,
    "Truck Trips",
    [
      "Trip #",
      "Trip ID",
      "Physical status",
      "Closed at UTC",
      "Scanned bales",
      "Scanned KG",
      "Financial status",
      "Posting revision",
      "Original POST ID",
      "Posted goods USD",
      "Billable charges USD",
      "Discounts USD",
      "Existing customer receivable USD",
      "Posted at UTC",
      "PO Excel generated",
      "ERP PO #",
      "ERP container #",
      "Supplier code",
      "Normal ERP import",
      "Notes",
    ],
    data.trips.map((t) => [
      t.dispatchNumber,
      t.id,
      t.status,
      date(t.closedAt),
      t.scannedBales,
      Number(t.scannedWeightKg),
      t.financialStatus,
      t.postingRevision,
      t.postingId,
      money(t.goodsSubtotal),
      money(t.billableCharges),
      money(t.discounts),
      money(t.customerTotal),
      date(t.postedAt),
      date(t.exportedAt),
      t.poNumber,
      t.erpContainerNumber,
      t.supplierCode,
      t.erpImportStatus === "NOT_TRACKED_MANUAL" ? "UNCONFIRMED — manual import" : "No PO file generated",
      t.notes,
    ]),
    [10, 11, 12, 13]
  );
  sheet(
    wb,
    "Charge Ledger",
    [
      "Type",
      "Trip #",
      "Trip ID",
      "Charge / Expense",
      "Amount USD",
      "Account code",
      "Account name",
      "Offset account",
      "Voucher ID",
      "Posting state",
    ],
    data.charges.map((c) => [
      c.kind,
      c.dispatchNumber,
      c.dispatchId,
      c.name,
      Number(c.amount),
      c.accountCode,
      c.accountName,
      c.offsetAccountCode,
      c.postedVoucherId,
      c.status,
    ]),
    [5]
  );
  sheet(
    wb,
    "ERP PO Files",
    [
      "Trip #",
      "Trip ID",
      "PO file generated UTC",
      "ERP PO #",
      "ERP container #",
      "ERP supplier code",
      "Factory posted customer total USD",
      "ERP import verified?",
    ],
    data.trips.map((t) => [
      t.dispatchNumber,
      t.id,
      date(t.exportedAt),
      t.poNumber,
      t.erpContainerNumber,
      t.supplierCode,
      money(t.customerTotal),
      "NO — Factory cannot confirm the separate manual ERP PO import",
    ]),
    [7]
  );
  sheet(
    wb,
    "Invoice & Postings",
    ["Reference", "Value"],
    [
      ["Loading order", data.order.id],
      ["Invoice", data.invoice?.invoiceNumber ?? data.order.invoiceNumber],
      ["Invoice workflow state", data.invoice?.status ?? "Not signed"],
      ["Signed at UTC", date(data.invoice?.signedAt ?? null)],
      ["Signed by user ID", data.invoice?.signedBy ?? null],
      ["Finalized at UTC", date(data.invoice?.finalizedAt ?? null)],
      ["Original truck POST IDs", data.invoice?.includedPostingIds.join(", ") ?? ""],
      ["Combined invoice voucher IDs", data.invoice?.finalizationVoucherIds.join(", ") ?? ""],
      ["Already-posted receivable USD", money(s.tripCustomerTotal)],
      ["Original charges USD", money(s.originalOrderCharges)],
      ["One finalized invoice USD", money(s.invoiceTotal)],
      ["Double-posting policy", "No second customer debit for posted trips"],
      ["ERP supplier import", "Manual only; not confirmed by Factory download"],
    ]
  );
  const aud: Cell[][] = history.map((a) => [
    a.source,
    a.id,
    a.dispatchId,
    a.eventType,
    a.actorUsername,
    date(a.createdAt),
    a.reason,
    JSON.stringify(a.details),
  ]);
  if (historyHasMore)
    aud.unshift([
      "NOTICE",
      null,
      null,
      "TRUNCATED",
      null,
      null,
      "This Excel file contains only the 1,000 newest events. Use the paginated in-app history to view older events.",
      null,
    ]);
  sheet(
    wb,
    "Audit History",
    ["Source", "Event ID", "Trip ID", "Event", "Actor", "UTC date", "Reason", "Original details JSON"],
    aud
  );
  styleFactoryOperationalWorkbook(
    wb,
    wb.worksheets.map((worksheet) => ({
      name: worksheet.name,
      headerRow: 1,
    }))
  );
  return wb;
}
