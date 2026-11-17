/** Dedicated Shared Charge Editor grant management. Never inherited by Admin. */
import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  intercompanyPermissionGrants,
  intercompanyRelationshipPolicies,
  intercompanySharedChargeAllocations,
  intercompanySharedChargeInvoices,
  intercompanyTrades,
  userCompanyRoles,
} from "@shared/schema";
import { db } from "../../db";
import { type EditIdentity, rejectEdit, withTradeScope } from "./tradeSync";

export type SharedEditorGrantInput = {
  userId: string;
  relationshipId: number;
  scope: "invoice" | "relationship";
  invoiceKey?: string;
};
export async function grantSharedChargeEditor(input: SharedEditorGrantInput, identity: EditIdentity) {
  if (!["Owner", "Developer"].includes(identity.actorRole)) {
    rejectEdit("Only Owners or Developers can grant Shared Charge Editor access", "IC_PERMISSION_FORBIDDEN", 403);
  }
  if (
    !input.userId?.trim() ||
    input.userId.length > 128 ||
    !Number.isSafeInteger(input.relationshipId) ||
    input.relationshipId < 1 ||
    !["invoice", "relationship"].includes(input.scope)
  ) {
    rejectEdit("Invalid permission scope, user or company relationship", "IC_PERMISSION_INPUT", 422);
  }
  const [relation] = await db
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(eq(intercompanyRelationshipPolicies.id, input.relationshipId));
  if (!relation || ![relation.sourceCompanyId, relation.destinationCompanyId].includes(identity.initiatingCompanyId)) {
    rejectEdit("This company is not part of the requested relationship", "IC_PERMISSION_FORBIDDEN", 403);
  }
  const ref = input.scope === "invoice" ? input.invoiceKey?.trim() : null;
  if (input.scope === "invoice" && (!ref || ref.length > 120)) {
    rejectEdit("A confirmed invoice reference is required", "IC_PERMISSION_INVOICE", 422);
  }
  return withTradeScope(identity, [relation.sourceCompanyId, relation.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      const [grantee] = await tx
        .select()
        .from(userCompanyRoles)
        .where(
          and(eq(userCompanyRoles.userId, input.userId), eq(userCompanyRoles.companyId, identity.initiatingCompanyId))
        );
      if (!grantee) rejectEdit("The user must belong to the granting company", "IC_PERMISSION_USER", 422);
      if (ref) {
        const [invoice] = await tx
          .select()
          .from(intercompanySharedChargeInvoices)
          .where(
            and(
              eq(intercompanySharedChargeInvoices.sourceCompanyId, relation.sourceCompanyId),
              eq(intercompanySharedChargeInvoices.externalInvoiceKey, ref),
              eq(intercompanySharedChargeInvoices.state, "confirmed")
            )
          );
        if (!invoice) rejectEdit("Confirmed shared invoice does not exist", "IC_PERMISSION_INVOICE", 422);
        const allocations = await tx
          .select()
          .from(intercompanySharedChargeAllocations)
          .where(eq(intercompanySharedChargeAllocations.invoiceId, invoice.id));
        const trades = await tx
          .select()
          .from(intercompanyTrades)
          .where(
            inArray(
              intercompanyTrades.id,
              allocations.map((a) => a.tradeId)
            )
          );
        if (!trades.some((t) => t.relationshipId === relation.id)) {
          rejectEdit(
            "Invoice is not associated with the granting company's relationship",
            "IC_PERMISSION_INVOICE",
            422
          );
        }
      }
      const [grant] = await tx
        .insert(intercompanyPermissionGrants)
        .values({
          userId: input.userId,
          grantingCompanyId: identity.initiatingCompanyId,
          relationshipId: relation.id,
          permission: "shared_charge_editor",
          scope: input.scope,
          invoiceKey: ref ?? null,
          grantedBy: identity.actorUserId,
        })
        .returning();
      return {
        grantId: grant.id,
        userId: grant.userId,
        relationshipId: grant.relationshipId,
        scope: grant.scope,
        invoiceKey: grant.invoiceKey,
      };
    })
  );
}
export async function revokeSharedChargeEditor(grantId: number, identity: EditIdentity) {
  if (!["Owner", "Developer"].includes(identity.actorRole)) {
    rejectEdit("Only Owners or Developers can revoke Shared Charge Editor access", "IC_PERMISSION_FORBIDDEN", 403);
  }
  const [grant] = await db
    .select()
    .from(intercompanyPermissionGrants)
    .where(
      and(
        eq(intercompanyPermissionGrants.id, grantId),
        eq(intercompanyPermissionGrants.grantingCompanyId, identity.initiatingCompanyId),
        isNull(intercompanyPermissionGrants.revokedAt)
      )
    );
  if (!grant) rejectEdit("Active grant not found in this company", "IC_PERMISSION_NOT_FOUND", 404);
  const [relationship] = await db
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(eq(intercompanyRelationshipPolicies.id, grant.relationshipId));
  if (!relationship) rejectEdit("Original relationship not found");
  return withTradeScope(identity, [relationship.sourceCompanyId, relationship.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      const [updated] = await tx
        .update(intercompanyPermissionGrants)
        .set({ revokedAt: new Date(), revokedBy: identity.actorUserId })
        .where(and(eq(intercompanyPermissionGrants.id, grantId), isNull(intercompanyPermissionGrants.revokedAt)))
        .returning();
      if (!updated) rejectEdit("Permission already revoked");
      return { grantId: updated.id, revoked: true };
    })
  );
}
