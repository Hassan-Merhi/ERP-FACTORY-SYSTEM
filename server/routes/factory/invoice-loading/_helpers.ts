/**
 * Shared state and helpers for the factoryInvoiceLoadingRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryInvoiceLoadingRoutes.ts.
 */
import { db } from "../../../db";
import {
  customerOrders,
  customerOrderLines,
  customers,
  factoryInvoiceLoadingSessions,
  factoryInvoiceLoadingBales,
} from "@shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import type { Alignment, Border, Cell, CellValue, Worksheet } from "exceljs";

// ── Helpers ────────────────────────────────────────────────────────────────────

export function getCompanyId(req: import("express").Request): number | null {
  return req.session.factoryCompanyId || req.session.currentCompanyId || null;
}

/**
 * Build a full loading summary for an invoice.
 * "loaded" counts only OPEN and COMPLETED sessions — CANCELLED sessions are excluded.
 */
export async function buildLoadingSummary(invoiceId: number, companyId: number, activeSessionId?: number) {
  // 1. Invoice + customer
  const [invoiceRow] = await db
    .select({
      id: customerOrders.id,
      companyId: customerOrders.companyId,
      customerId: customerOrders.customerId,
      invoiceNumber: customerOrders.invoiceNumber,
      orderDate: customerOrders.orderDate,
      status: customerOrders.status,
      totalQtyBales: customerOrders.totalQtyBales,
      grandTotal: customerOrders.grandTotal,
      containerNumber: customerOrders.containerNumber,
      destination: customerOrders.destination,
      customerName: customers.legalName,
      customerCode: customers.code,
    })
    .from(customerOrders)
    .leftJoin(customers, eq(customerOrders.customerId, customers.id))
    .where(and(eq(customerOrders.id, invoiceId), eq(customerOrders.companyId, companyId)));

  if (!invoiceRow) return null;

  // 2. Invoice lines
  const lines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, invoiceId));

  // 3. Invoice bales (exact bale membership — the official list)
  // Use SELECT * so this query succeeds even when newer columns (bale_reference,
  // article_code, bale_name, price_used, location_id) are temporarily absent from
  // the production table.  A Drizzle-generated SELECT that names those columns
  // fails at parse time with "column X does not exist", which would break the
  // entire loading page.  SELECT * returns whatever exists; JS defaults fill gaps.
  const _invoiceBalesRawResult = await db.execute(
    sql`SELECT * FROM customer_order_bales WHERE order_id = ${invoiceId}`
  );
  // Columns are read off `Record<string, unknown>` rows because the SELECT * above
  // deliberately does not name them: each value is coerced here rather than
  // asserted, so a column that is absent in production still yields the same
  // defaults the untyped version produced.
  const invoiceBalesRaw = resultRows(_invoiceBalesRawResult).map((r) => ({
    id: Number(r.id),
    baleId: Number(r.bale_id),
    baleReference: String(r.bale_reference ?? ""),
    articleCode: r.article_code != null ? String(r.article_code) : null,
    baleName: r.bale_name != null ? String(r.bale_name) : null,
    weight: r.weight != null ? String(r.weight) : "",
    priceUsed: String(r.price_used ?? "0"),
  }));

  // 4. All loading sessions for this invoice
  const sessions = await db
    .select({
      id: factoryInvoiceLoadingSessions.id,
      status: factoryInvoiceLoadingSessions.status,
      truckNo: factoryInvoiceLoadingSessions.truckNo,
      driverName: factoryInvoiceLoadingSessions.driverName,
      notes: factoryInvoiceLoadingSessions.notes,
      startedAt: factoryInvoiceLoadingSessions.startedAt,
      completedAt: factoryInvoiceLoadingSessions.completedAt,
      cancelledAt: factoryInvoiceLoadingSessions.cancelledAt,
      createdByName: factoryInvoiceLoadingSessions.createdByName,
    })
    .from(factoryInvoiceLoadingSessions)
    .where(
      and(
        eq(factoryInvoiceLoadingSessions.invoiceId, invoiceId),
        eq(factoryInvoiceLoadingSessions.companyId, companyId)
      )
    )
    .orderBy(factoryInvoiceLoadingSessions.startedAt);

  // 5. All loading bale rows for ACTIVE (non-cancelled) sessions only
  const activeSessions = sessions.filter((s) => s.status !== "CANCELLED");
  const activeSessionIds = activeSessions.map((s) => s.id);

  let loadedBaleRows: Array<{
    id: number;
    sessionId: number;
    baleId: number;
    baleReference: string;
    articleCode: string | null;
    productName: string | null;
    weightKg: string;
    scannedAt: Date;
    scannedByName: string | null;
  }> = [];
  if (activeSessionIds.length > 0) {
    loadedBaleRows = await db
      .select({
        id: factoryInvoiceLoadingBales.id,
        sessionId: factoryInvoiceLoadingBales.sessionId,
        baleId: factoryInvoiceLoadingBales.baleId,
        baleReference: factoryInvoiceLoadingBales.baleReference,
        articleCode: factoryInvoiceLoadingBales.articleCode,
        productName: factoryInvoiceLoadingBales.productName,
        weightKg: factoryInvoiceLoadingBales.weightKg,
        scannedAt: factoryInvoiceLoadingBales.scannedAt,
        scannedByName: factoryInvoiceLoadingBales.scannedByName,
      })
      .from(factoryInvoiceLoadingBales)
      .where(inArray(factoryInvoiceLoadingBales.sessionId, activeSessionIds));
  }

  // 6. Also get all bale rows for each session (including cancelled) for per-session totals
  const allSessionIds = sessions.map((s) => s.id);
  let allSessionBaleRows: Array<{ sessionId: number }> = [];
  if (allSessionIds.length > 0) {
    allSessionBaleRows = await db
      .select({ sessionId: factoryInvoiceLoadingBales.sessionId })
      .from(factoryInvoiceLoadingBales)
      .where(inArray(factoryInvoiceLoadingBales.sessionId, allSessionIds));
  }

  const sessionBaleCountMap = new Map<number, number>();
  for (const row of allSessionBaleRows) {
    sessionBaleCountMap.set(row.sessionId, (sessionBaleCountMap.get(row.sessionId) || 0) + 1);
  }

  // 7. Build per-line loaded/remaining
  const loadedBaleIdSet = new Set(loadedBaleRows.map((b) => b.baleId));
  const linesSummary = lines.map((line) => {
    const invoiceQty = line.qty || 0;
    const lineBales = invoiceBalesRaw.filter((b) => b.articleCode === line.articleCode);
    const alreadyLoaded = lineBales.filter((b) => loadedBaleIdSet.has(b.baleId)).length;
    const currentSession = activeSessionId
      ? loadedBaleRows.filter((b) => b.sessionId === activeSessionId && b.articleCode === line.articleCode).length
      : 0;
    return {
      lineId: line.id,
      articleCode: line.articleCode,
      productName: line.baleName,
      invoiceQty,
      invoiceWeight: Number(line.totalWeight || 0),
      alreadyLoaded,
      currentSessionLoaded: currentSession,
      remaining: invoiceQty - alreadyLoaded,
      pricePerBale: line.pricePerBale,
    };
  });

  // 8. Totals
  // Only count bales that are in the invoice's official bale list (not overloaded extras).
  // loadedBaleIdSet may include bales scanned in overloading scenarios that are not
  // part of this invoice; using .size directly would inflate alreadyLoaded and shrink
  // remaining incorrectly (e.g. 18 not loaded – 7 overloaded = 11 instead of 18).
  const totalInvoiceBales = invoiceBalesRaw.length || invoiceRow.totalQtyBales || 0;
  const invoiceBaleIdSet = new Set(invoiceBalesRaw.map((b) => b.baleId));
  const totalAlreadyLoaded = [...loadedBaleIdSet].filter((id) => invoiceBaleIdSet.has(id)).length;
  const totalRemaining = totalInvoiceBales - totalAlreadyLoaded;

  // 9. Per-session totals
  const sessionsWithTotals = sessions.map((s) => ({
    ...s,
    totalBales: sessionBaleCountMap.get(s.id) || 0,
  }));

  // 10. Invoice bales with loaded flag
  const invoiceBalesWithStatus = invoiceBalesRaw.map((b) => {
    const loadedRow = loadedBaleRows.find((lr) => lr.baleId === b.baleId);
    return {
      baleId: b.baleId,
      baleReference: b.baleReference,
      articleCode: b.articleCode,
      productName: b.baleName,
      weightKg: b.weight,
      priceUsed: b.priceUsed,
      loaded: !!loadedRow,
      loadedSessionId: loadedRow?.sessionId ?? null,
      loadedAt: loadedRow?.scannedAt ?? null,
    };
  });

  // 11. If there's an active session, return its scanned bales
  let currentSessionBales: typeof loadedBaleRows = [];
  if (activeSessionId) {
    currentSessionBales = loadedBaleRows.filter((b) => b.sessionId === activeSessionId);
  }

  return {
    invoice: invoiceRow,
    lines: linesSummary,
    totals: {
      invoiceBales: totalInvoiceBales,
      alreadyLoaded: totalAlreadyLoaded,
      remaining: totalRemaining,
    },
    sessions: sessionsWithTotals,
    invoiceBales: invoiceBalesWithStatus,
    currentSessionBales,
  };
}

// ── Route registration ─────────────────────────────────────────────────────────

/**
 * ExcelJS cell-formatting helpers for the loading-report exports.
 *
 * Declared at module scope so the four export handlers that share them can
 * live in separate modules.
 */
export function cellFill(cell: Cell, argb: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}
/** Apply thin borders to all four sides of a cell */
export function cellBorder(cell: Cell) {
  const s: Partial<Border> = { style: "thin", color: { argb: "FFD1D5DB" } };
  cell.border = { top: s, left: s, bottom: s, right: s };
}
/** Style a section-header row (dark navy bg, white bold) */
export function sectionHeader(ws: Worksheet, rowNum: number, value: string, cols: number) {
  const row = ws.getRow(rowNum);
  const cell = row.getCell(1);
  cell.value = value;
  cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  cellFill(cell, "FF1E3A5F");
  ws.mergeCells(rowNum, 1, rowNum, cols);
  row.height = 20;
}
/** Style a column-header row (light blue bg, dark blue bold) */
export function colHeaders(ws: Worksheet, rowNum: number, headers: string[]) {
  const row = ws.getRow(rowNum);
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FF1E40AF" }, size: 10 };
    cellFill(cell, "FFDBEAFE");
    cellBorder(cell);
    cell.alignment = { horizontal: i > 1 ? "right" : "left", vertical: "middle" };
  });
  row.height = 16;
}
/** Style a data cell */
export function dataCell(
  cell: Cell,
  value: CellValue,
  opts: { bold?: boolean; color?: string; align?: Alignment["horizontal"]; fill?: string } = {}
) {
  cell.value = value;
  cell.font = { bold: opts.bold ?? false, color: { argb: opts.color ?? "FF111827" }, size: 10 };
  cell.alignment = { horizontal: opts.align ?? "left", vertical: "middle" };
  if (opts.fill) cellFill(cell, opts.fill);
  cellBorder(cell);
}
