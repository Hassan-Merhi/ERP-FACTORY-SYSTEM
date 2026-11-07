/**
 * Phase 9 cloud apply handler for `pos.sale.v1` (offline POS cash sales).
 *
 * The sale is replayed through the normal sale service (createPosSale) so
 * the cloud voucher, stock issue, COGS journal and audit are exactly what an
 * online sale produces. createPosSale owns its own transaction; exactly-once
 * is guaranteed by the sale's clientSaleId (= the LAN operation id), which the
 * service locks and de-duplicates: an apply interrupted after the sale
 * committed returns the stored sale as "already-present" on retry.
 *
 * Owner policy: the sale keeps the price and the exchange rate it was sold
 * at (cash, bank or credit); a sale that would take cloud stock below zero,
 * or whose POS till cash account mapping changed, is held for an
 * Admin/Developer approve/reject decision. A missing payment account or
 * customer, a company that no longer allows offline sales, revoked access or
 * any other refusal by the sale service can only be rejected.
 */
import type { PoolClient } from "pg";
import { toMoney } from "../lib/money";
import { createPosSale } from "../services/pos/createSaleService";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import { PHASE9_POS_CASH_ACCOUNT_CONFLICT, PHASE9_POS_NEGATIVE_CONFLICT } from "./phase9PosSaleEnvelope.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9PosSaleEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: {
    requestId: string;
    companyId: number;
    actorUserId: string;
    actorUsername: string;
    localVoucherId: number;
    lanInvoiceNumber: string;
    locationId: number;
    paymentAccountType: "cash" | "bank" | "credit";
    paymentAccountId: number;
    currency: string;
    exchangeRate: string | null;
    voucherDate: string;
    notes: string | null;
    items: Array<{ stockItemId: number; quantity: string; rate: string; originalCurrencyRate: string | null }>;
  };
  payloadSha256: string;
}

export interface Phase9PosSaleApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "Create Only", "ERP Tester"]);

function saleTotal(p: Phase9PosSaleEvent["payload"]) {
  return p.items.reduce(
    (sum, line) => sum.plus(toMoney(line.quantity).times(toMoney(line.rate)).toDecimalPlaces(2)),
    toMoney(0)
  );
}

/** The sale service's refusal text, kept with the conflict for the reviewer. */
function refusalMessage(body: unknown): string | undefined {
  const value = (body as { message?: unknown } | null)?.message;
  return value === undefined ? undefined : String(value);
}

async function authorize(client: Queryable, event: Phase9PosSaleEvent): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role, r.pos_view_only
       FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  if (row.pos_view_only === true || READ_ONLY_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

async function existingSale(client: Queryable, event: Phase9PosSaleEvent) {
  const prior = await client.query(
    `SELECT id, voucher_date::text AS voucher_date, total_amount::text AS total_amount, location_id
       FROM vouchers WHERE company_id = $1 AND client_sale_id = $2 LIMIT 1`,
    [event.companyId, event.operationId]
  );
  return prior.rows[0] ?? null;
}

async function apply(
  client: Queryable,
  event: Phase9PosSaleEvent,
  context: { readonly overrideConflicts: readonly string[] } = { overrideConflicts: [] }
): Promise<Phase9PosSaleApplyResult> {
  const p = event.payload;
  const prior = await existingSale(client, event);
  if (prior) {
    const same = Number(prior.location_id) === p.locationId && toMoney(prior.total_amount).equals(saleTotal(p));
    if (!same) throw new Phase9EventConflict("PHASE9_POS_REQUEST_ID_DIVERGED", { cloudVoucherId: Number(prior.id) });
    return { outcome: "already-present", cloudRef: Number(prior.id), businessDate: String(prior.voucher_date) };
  }

  const company = await client.query("SELECT company_type FROM companies WHERE id = $1", [event.companyId]);
  const companyType = String(company.rows[0]?.company_type ?? "");
  if (!company.rows.length || companyType === "supplier_partner" || companyType === "retail") {
    throw new Phase9EventConflict("PHASE9_POS_COMPANY_UNSUPPORTED", { companyType });
  }

  // The payment account must still exist in the cloud: a Cash ledger (cash),
  // a bank account (bank) or a customer receivable ledger (credit).
  const accountId = p.paymentAccountId;
  const account =
    p.paymentAccountType === "bank"
      ? await client.query("SELECT active FROM bank_accounts WHERE id = $1 AND company_id = $2", [
          accountId,
          event.companyId,
        ])
      : await client.query(
          "SELECT active FROM ledger_accounts WHERE id = $1 AND company_id = $2 AND account_type = $3",
          [accountId, event.companyId, p.paymentAccountType === "credit" ? "Asset" : "Cash"]
        );
  if (!account.rows.length || account.rows[0].active === false) {
    throw new Phase9EventConflict("PHASE9_POS_PAYMENT_ACCOUNT_MISSING", {
      paymentAccountType: p.paymentAccountType,
      paymentAccountId: accountId,
    });
  }
  // A POS user's till account is assigned per location; if it was changed or
  // closed in the cloud during the outage, an Admin/Developer decides.
  const role = await client.query("SELECT role FROM user_company_roles WHERE user_id = $1 AND company_id = $2", [
    event.actorUserId,
    event.companyId,
  ]);
  if (
    p.paymentAccountType === "cash" &&
    String(role.rows[0]?.role) === "POS" &&
    !context.overrideConflicts.includes(PHASE9_POS_CASH_ACCOUNT_CONFLICT)
  ) {
    const mapping = await client.query(
      `SELECT cash_account_id FROM user_location_cash_accounts
        WHERE user_id = $1 AND company_id = $2 AND location_id = $3`,
      [event.actorUserId, event.companyId, p.locationId]
    );
    if (mapping.rows.length && Number(mapping.rows[0].cash_account_id) !== accountId) {
      throw new Phase9EventConflict(PHASE9_POS_CASH_ACCOUNT_CONFLICT, {
        lanCashAccountId: accountId,
        cloudCashAccountId: Number(mapping.rows[0].cash_account_id),
      });
    }
  }

  const flags = await client.query(
    "SELECT can_sell_negative_stock FROM user_company_roles WHERE user_id = $1 AND company_id = $2",
    [event.actorUserId, event.companyId]
  );
  const allowNegative =
    flags.rows[0]?.can_sell_negative_stock === true || context.overrideConflicts.includes(PHASE9_POS_NEGATIVE_CONFLICT);
  if (!allowNegative) {
    const needed = new Map<number, ReturnType<typeof toMoney>>();
    for (const line of p.items) {
      needed.set(line.stockItemId, (needed.get(line.stockItemId) ?? toMoney(0)).plus(toMoney(line.quantity)));
    }
    for (const [stockItemId, quantity] of needed) {
      const balance = await client.query(
        "SELECT quantity::text AS quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
        [event.companyId, p.locationId, stockItemId]
      );
      const available = toMoney(balance.rows[0]?.quantity ?? "0");
      if (available.minus(quantity).isNegative()) {
        throw new Phase9EventConflict(PHASE9_POS_NEGATIVE_CONFLICT, {
          stockItemId,
          available: available.toFixed(),
          requested: quantity.toFixed(),
        });
      }
    }
  }

  const marker = `Offline sale ${p.lanInvoiceNumber} (offline price)`;
  const result = await createPosSale(
    {
      currentCompanyId: event.companyId,
      userId: event.actorUserId,
      username: p.actorUsername,
      // The LAN already resolved the till's cash account; replay it explicitly.
      userRole: undefined,
      canSellNegativeStock: allowNegative,
      sessionCashAccountId: null,
      voucherDateFallback: p.voucherDate,
      body: {
        locationId: p.locationId,
        ...(p.paymentAccountType === "cash" ? { cashAccountId: accountId } : { paymentAccountId: accountId }),
        items: p.items.map((line) => ({
          stockItemId: line.stockItemId,
          quantity: line.quantity,
          rate: line.rate,
          ...(line.originalCurrencyRate === null ? {} : { originalCurrencyRate: line.originalCurrencyRate }),
        })),
        notes: p.notes ? `${p.notes} · ${marker}` : marker,
        isCreditSale: p.paymentAccountType === "credit",
        voucherDate: p.voucherDate,
        clientSaleId: event.operationId,
        currency: p.currency,
        exchangeRate: p.exchangeRate,
      },
      // The rate the cashier entered on the factory server, never re-derived.
      lockedCurrency: { currency: p.currency, exchangeRate: p.exchangeRate },
    },
    { isSpCompany: false }
  );
  if (result.status !== 200 || !("voucher" in result.body) || !result.body.voucher) {
    throw new Phase9EventConflict("PHASE9_POS_SALE_REFUSED", {
      status: result.status,
      message: refusalMessage(result.body),
    });
  }
  const voucher = result.body.voucher as { id: number; voucherDate: string | Date };
  return {
    outcome: "_idempotent" in result.body && result.body._idempotent ? "already-present" : "cloud-applied",
    cloudRef: Number(voucher.id),
    businessDate: String(voucher.voucherDate).slice(0, 10),
  };
}

async function verify(
  client: Queryable,
  event: Phase9PosSaleEvent,
  result: Phase9PosSaleApplyResult
): Promise<boolean> {
  const check = await client.query(
    `SELECT total_amount::text AS total_amount FROM vouchers
      WHERE id = $1 AND company_id = $2 AND client_sale_id = $3 AND voucher_type = 'Sales'
        AND location_id = $4 AND voucher_date = $5::date`,
    [result.cloudRef, event.companyId, event.operationId, event.payload.locationId, result.businessDate]
  );
  return check.rows.length === 1 && toMoney(check.rows[0].total_amount).equals(saleTotal(event.payload));
}

export const phase9PosSaleApplyHandler = Object.freeze({ authorize, apply, verify });
