/**
 * Explicit cross-company receipt authorization for the Properties container
 * detail screen. This does not impersonate the destination company or grant
 * access through a client-supplied ID. The initiating Properties user must be
 * an Owner/Developer AND independently authorized in the destination ERP.
 */
import { and, eq } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";
import { db } from "../../db";
import { IntercompanyEditError, type EditIdentity, withTradeScope } from "./tradeSync";

export type ReceivingTradePair = {
  sourceCompanyId: number;
  destinationCompanyId: number;
};

export function mayReceiveFromProperties(
  trade: ReceivingTradePair,
  identity: EditIdentity,
  sourceType: string | null,
  destinationType: string | null,
  destinationMembership: string | null
): boolean {
  return (
    identity.initiatingCompanyId === trade.sourceCompanyId &&
    ["Owner", "Developer"].includes(identity.actorRole) &&
    sourceType === "properties" &&
    destinationType === "erp" &&
    ["Owner", "Admin", "Developer"].includes(destinationMembership ?? "")
  );
}

export async function requireReceivingPairPermission(trade: ReceivingTradePair, identity: EditIdentity): Promise<void> {
  if (identity.initiatingCompanyId === trade.destinationCompanyId) {
    // The existing receiving ERP membership check remains inside withTradeScope.
    return;
  }
  if (identity.initiatingCompanyId !== trade.sourceCompanyId || !["Owner", "Developer"].includes(identity.actorRole)) {
    throw new IntercompanyEditError(
      "IC_RECEIPT_COMPANY",
      "Receive from Properties requires Owner/Developer access to Properties and verified ERP destination membership",
      403
    );
  }
  // Authorize the destination explicitly *before* opening the financial
  // transaction. Scope validates the initiating session, then permits reading
  // only the two companies involved in this specific verified trade.
  await withTradeScope(identity, [trade.destinationCompanyId], async () => {
    const [source, destination, membership] = await Promise.all([
      db
        .select({ id: companies.id, companyType: companies.companyType })
        .from(companies)
        .where(eq(companies.id, trade.sourceCompanyId))
        .limit(1),
      db
        .select({ id: companies.id, companyType: companies.companyType })
        .from(companies)
        .where(eq(companies.id, trade.destinationCompanyId))
        .limit(1),
      db
        .select({ role: userCompanyRoles.role })
        .from(userCompanyRoles)
        .where(
          and(
            eq(userCompanyRoles.userId, identity.actorUserId),
            eq(userCompanyRoles.companyId, trade.destinationCompanyId)
          )
        )
        .limit(1),
    ]);
    if (
      !mayReceiveFromProperties(
        trade,
        identity,
        source[0]?.companyType ?? null,
        destination[0]?.companyType ?? null,
        membership[0]?.role ?? null
      )
    ) {
      throw new IntercompanyEditError(
        "IC_RECEIPT_DESTINATION_ACCESS",
        "Destination ERP Owner/Admin/Developer access is required to receive from Properties",
        403
      );
    }
  });
}
