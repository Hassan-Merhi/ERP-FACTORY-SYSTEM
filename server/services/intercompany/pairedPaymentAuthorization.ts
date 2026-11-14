/**
 * A paired payment changes real bank/cash and subledger balances in TWO
 * companies. Access to just one of them must never authorize both movements.
 * This policy is independent of the UI and also governs read-only pair detail.
 */
import { and, eq, inArray } from "drizzle-orm";
import { userCompanyRoles } from "@shared/schema";
import { db } from "../../db";
import { type EditIdentity, rejectEdit, withTradeScope } from "./tradeSync";

export type PaymentPairIdentity = { sourceCompanyId: number; destinationCompanyId: number };
export type PaymentMemberRole = { companyId: number; role: string };

export function canAccessPairedCash(
  pair: PaymentPairIdentity,
  actor: EditIdentity,
  memberships: readonly PaymentMemberRole[]
): boolean {
  if (![pair.sourceCompanyId, pair.destinationCompanyId].includes(actor.initiatingCompanyId)) return false;
  const source = memberships.find((row) => row.companyId === pair.sourceCompanyId)?.role;
  const destination = memberships.find((row) => row.companyId === pair.destinationCompanyId)?.role;
  if (!["Owner", "Developer"].includes(source ?? "")) return false;
  if (!["Owner", "Admin", "Developer"].includes(destination ?? "")) return false;
  if (actor.initiatingCompanyId === pair.sourceCompanyId) {
    return ["Owner", "Developer"].includes(actor.actorRole);
  }
  return ["Owner", "Admin", "Developer"].includes(actor.actorRole);
}

export async function pairedCashMemberships(
  pair: PaymentPairIdentity,
  actor: EditIdentity
): Promise<PaymentMemberRole[]> {
  return withTradeScope(actor, [pair.sourceCompanyId, pair.destinationCompanyId], () =>
    db
      .select({ companyId: userCompanyRoles.companyId, role: userCompanyRoles.role })
      .from(userCompanyRoles)
      .where(
        and(
          eq(userCompanyRoles.userId, actor.actorUserId),
          inArray(userCompanyRoles.companyId, [pair.sourceCompanyId, pair.destinationCompanyId])
        )
      )
  );
}

export async function requirePairedCashAuthorization(pair: PaymentPairIdentity, actor: EditIdentity): Promise<void> {
  const memberships = await pairedCashMemberships(pair, actor);
  if (!canAccessPairedCash(pair, actor, memberships)) {
    rejectEdit(
      "Actual intercompany money transfers require verified finance permissions in both Properties and destination ERP",
      "IC_PAYMENT_PAIR_MEMBERSHIP",
      403
    );
  }
}
