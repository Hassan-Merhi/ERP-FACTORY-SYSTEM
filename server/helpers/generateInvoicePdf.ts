/**
 * Invoice PDF — branded POS Invoice.
 *
 * Full columns  : Description (34%) | Qty (7%) | Rate (10%) | Amt (11%) | Config (11%) | P/L Bale (13%) | Total P/L (14%)
 * Profit hidden : Description (42%) | Qty (8%)  | Rate (18%) | Amt (32%)
 *
 * compactMode/whatsappMode only control sizing (tighter margins/rows, single-
 * line description). Whether P/L columns show is controlled solely by
 * hideProfitCols (visibility settings) and by the auto-hide-when-no-
 * configured-price rule in buildPdf — a WhatsApp invoice for a location with
 * a selling price fix still gets the full 7-column layout above.
 *
 * Numbers : fmtPrint logic — strips trailing ".00", prefixes "$ " for currency
 * Colours : green (#059669) for profit, red (#c2272d) for loss
 */

import { pool } from "../db";
import { toMoney } from "../lib/money";
import { formatDbDate, type InvoiceItem, type InvoicePdfMeta, type InvoicePdfOpts } from "./generateInvoicePdfWrapText";
import { buildPdf } from "./generateInvoicePdfBuildPdf";
export type { InvoicePdfMeta, InvoicePdfOpts } from "./generateInvoicePdfWrapText";

// ── DB query ──────────────────────────────────────────────────────────────────

/**
 * Generate invoice PDF and return the raw Buffer.
 * Backward-compatible — existing callers are unaffected.
 */
export async function generateInvoicePdf(
  voucherId: number,
  companyId: number,
  callerUserName?: string,
  opts?: InvoicePdfOpts
): Promise<Buffer> {
  const { buffer } = await generateInvoicePdfMeta(voucherId, companyId, callerUserName, opts);
  return buffer;
}

/**
 * Generate invoice PDF and also return page count and item count.
 * Used by the WhatsApp backend route for validation and dry-run.
 */
export async function generateInvoicePdfMeta(
  voucherId: number,
  companyId: number,
  callerUserName?: string,
  opts?: InvoicePdfOpts
): Promise<InvoicePdfMeta> {
  const vRes = await pool.query<{
    voucher_date: string;
    description: string | null;
    exchange_rate: string | null;
    currency: string | null;
    is_credit_sale: boolean;
    shift_id: number | null;
    company_name: string;
  }>(
    `SELECT v.voucher_date, v.description, v.exchange_rate, v.currency, v.is_credit_sale, v.shift_id,
            c.name AS company_name
     FROM vouchers v
     JOIN companies c ON c.id = v.company_id
     WHERE v.id = $1 AND v.company_id = $2 LIMIT 1`,
    [voucherId, companyId]
  );
  if (!vRes.rows.length) throw new Error("Voucher not found");
  const v = vRes.rows[0];

  const itemsRes = await pool.query<{
    stock_item_name: string;
    quantity: string;
    selling_price: string;
    configured_price: string | null;
  }>(
    `SELECT s.name AS stock_item_name, si.quantity, si.selling_price, si.configured_price
     FROM sales_items si
     JOIN stock_items s ON s.id = si.stock_item_id
     WHERE si.voucher_id = $1 ORDER BY si.id`,
    [voucherId]
  );
  const items: InvoiceItem[] = itemsRes.rows.map((r) => ({
    stockItemName: r.stock_item_name,
    quantity: toMoney(r.quantity).toNumber(),
    rateUSD: toMoney(r.selling_price).toNumber(),
    configuredPrice: toMoney(r.configured_price).toNumber(),
  }));

  // The ZMW payment entry is the source of truth for what the cashier charged.
  // Do not revalue the USD voucher amount at any current or rounded rate.
  const nativeZmwTotal = v.currency === "ZMW"
    ? (await pool.query<{ native_amount: string | null }>(
        `SELECT MAX(transaction_debit_amount)::text AS native_amount
         FROM voucher_entries WHERE voucher_id = $1
         AND transaction_currency = 'ZMW' AND transaction_debit_amount > 0`,
        [voucherId]
      )).rows[0]?.native_amount ?? null
    : null;

  let customerName: string | null = null;
  if (v.is_credit_sale) {
    const cRes = await pool.query<{ customer_name: string }>(
      `SELECT la.name AS customer_name
       FROM voucher_entries ve
       JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE ve.voucher_id = $1 AND ve.debit_amount::numeric > 0 LIMIT 1`,
      [voucherId]
    );
    customerName = cRes.rows[0]?.customer_name || null;
  }

  let userName = callerUserName || "—";
  if (!callerUserName && v.shift_id) {
    const uRes = await pool.query<{ username: string }>(
      `SELECT u.username FROM pos_shifts ps
       JOIN users u ON u.id = ps.user_id
       WHERE ps.id = $1 LIMIT 1`,
      [v.shift_id]
    );
    userName = uRes.rows[0]?.username || "—";
  }

  // whatsappMode / compactMode both trigger the compact layout (tighter
  // margins/rows). This is purely a sizing choice — it must NOT force the
  // Config/P&L columns to hide. Whether those columns show is controlled
  // solely by opts.hideProfitCols (visibility settings) and by buildPdf's
  // own auto-hide-when-no-configured-price rule below, so a location with a
  // selling price fix still gets P/L per bale + Total P/L on the WhatsApp PDF.
  const compactMode = !!(opts?.compactMode || opts?.whatsappMode);
  const hideProfitCols = opts?.hideProfitCols ?? false;

  const { buffer, pageCount } = await buildPdf({
    voucherDate: formatDbDate(v.voucher_date),
    description: v.description,
    exchangeRate: v.exchange_rate ? toMoney(v.exchange_rate).toNumber() : null,
    currency: v.currency || "USD",
    isCreditSale: v.is_credit_sale,
    companyName: v.company_name,
    userName,
    customerName,
    items,
    nativeZmwTotal: nativeZmwTotal === null ? null : Number(nativeZmwTotal),
    hideProfitCols,
    compactMode,
  });

  return { buffer, pageCount, itemCount: items.length };
}
