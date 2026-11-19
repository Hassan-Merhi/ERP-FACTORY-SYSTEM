/**
 * Full offline mode: the live sale-edit rules, re-checked in the cloud for a
 * POS sale edit a PC delivers.
 *
 * On the factory LAN server, PUT/PATCH /api/vouchers/:id/sales enforce
 * requirePosSaleEditWindow before the edit is recorded, so the cloud can trust
 * the record. A PC builds its record itself, so the same rules are checked
 * here against the actor's CURRENT cloud access and the cloud's sale:
 *
 * - POS: not view-only; the sale's location is the cashier's; the sale is
 *   still inside the daybook edit window (company business date, today); the
 *   date, payment and location are unchanged.
 * - Manager / Owner / ERP Tester: the sale date is today, or within their
 *   daybook edit days (canModifyDate). Admin and Developer: no date limit.
 *
 * The window is measured when the edit reaches the cloud, so an edit made
 * offline near the end of the window may be held. A refused edit is a
 * conflict that cannot be force-applied: the person re-enters it online.
 */
import type { PoolClient } from "pg";
import { posDaybookEditEligibility } from "@shared/posDaybookEditPolicy";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import type { BrowserActor } from "../browserSync/browserOperationKinds";

export const PC_POS_EDIT_NOT_ALLOWED = "PHASE9_POS_EDIT_NOT_ALLOWED";

type Queryable = Pick<PoolClient, "query">;
type Refusal = { code: string; detail: Record<string, unknown> } | null;

interface EditPayload {
  voucherRef?: { clientSaleId?: string | null; voucherId?: number };
  edit?: {
    voucherDate?: string | null;
    isCreditSale?: boolean;
    locationId?: number | null;
    paymentAccountType?: string | null;
    paymentAccountId?: number | null;
  };
}

function refuse(reason: string, extra: Record<string, unknown> = {}): Refusal {
  return { code: PC_POS_EDIT_NOT_ALLOWED, detail: { reason, ...extra } };
}

function daysBetween(from: string, to: string): number {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

/** null when the live routes would have allowed this edit now; otherwise the refusal. */
export async function pcPosSaleEditRefusal(
  client: Queryable,
  actor: BrowserActor,
  payload: EditPayload
): Promise<Refusal> {
  const ref = payload.voucherRef ?? {};
  const edit = payload.edit ?? {};
  const sale = ref.clientSaleId
    ? await client.query(
        `SELECT id, location_id, voucher_date::text AS voucher_date, is_credit_sale
           FROM vouchers
          WHERE company_id = $1 AND client_sale_id = $2 AND voucher_type = 'Sales' AND deleted_at IS NULL`,
        [actor.companyId, ref.clientSaleId]
      )
    : await client.query(
        `SELECT id, location_id, voucher_date::text AS voucher_date, is_credit_sale
           FROM vouchers
          WHERE company_id = $1 AND id = $2 AND voucher_type = 'Sales' AND deleted_at IS NULL`,
        [actor.companyId, Number(ref.voucherId)]
      );
  // A sale the cloud does not have is the handler's own conflict (PHASE9_POS_SALE_MISSING).
  if (!sale.rows.length) return null;
  const row = sale.rows[0];
  const saleDate = String(row.voucher_date).slice(0, 10);

  const access = await client.query(
    `SELECT role, pos_view_only, daybook_edit_days, assigned_location_id
       FROM user_company_roles WHERE user_id = $1 AND company_id = $2`,
    [actor.userId, actor.companyId]
  );
  const who = access.rows[0];
  // No role here is the handler's own conflict (PHASE9_ACTOR_ACCESS_REVOKED).
  if (!who) return null;
  const role = String(who.role);
  const editDays = Number(who.daybook_edit_days ?? 0);
  const businessDate = await companyBusinessDate(actor.companyId);
  const newDate = edit.voucherDate ? String(edit.voucherDate).slice(0, 10) : saleDate;

  if (role !== "POS") {
    if (role === "Admin" || role === "Developer") return null;
    const age = daysBetween(newDate, businessDate);
    if (newDate === businessDate || (editDays > 0 && age >= 0 && age <= editDays)) return null;
    return refuse("date", { role, saleDate: newDate, businessDate, editDays });
  }

  if (who.pos_view_only === true) return refuse("view-only");
  const locationId = Number(row.location_id);
  const locationAccess = await client.query(
    "SELECT 1 FROM user_locations WHERE user_id = $1 AND company_id = $2 AND location_id = $3 LIMIT 1",
    [actor.userId, actor.companyId, locationId]
  );
  if (!row.location_id || (!locationAccess.rows.length && Number(who.assigned_location_id) !== locationId)) {
    return refuse("location");
  }
  const eligibility = posDaybookEditEligibility({
    originalDate: saleDate,
    businessDate,
    editDays,
    viewOnly: false,
  });
  if (!eligibility.allowed) return refuse(eligibility.reason, { saleDate, businessDate, editDays });
  if (newDate !== saleDate) return refuse("date-locked");
  if (
    edit.isCreditSale !== Boolean(row.is_credit_sale) ||
    edit.paymentAccountType != null ||
    edit.paymentAccountId != null
  ) {
    return refuse("payment-locked");
  }
  if (edit.locationId != null && Number(edit.locationId) !== locationId) return refuse("location-locked");
  return null;
}
