/**
 * Shared Charge Editor grants: role refusal, input validation, relationship
 * membership, invoice-scope checks (missing, unknown, unconfirmed, unrelated),
 * successful relationship and invoice grants, and revocation guards.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  grantSharedChargeEditor,
  revokeSharedChargeEditor,
  type SharedEditorGrantInput,
} from "../server/services/intercompany/sharedChargePermissions";

const failure = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    const e = error as { code?: string; status?: number; message: string };
    return { code: e.code, status: e.status, message: e.message };
  }
  throw new Error("expected a refusal");
};

const inWorld = (work: (world: IntercompanyTradeWorld) => Promise<void>) =>
  withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));

async function sharedInvoice(world: IntercompanyTradeWorld, key: string, confirmed: boolean, tradeId?: number) {
  const invoiceId = await world.one(
    `INSERT INTO intercompany_shared_charge_invoices (source_company_id, external_invoice_key, charge_type, face_amount,
       currency, evidence_reference, state, created_by)
     VALUES ($1, $2, 'freight', '50.00', 'USD', 'evidence', 'draft', $3) RETURNING id`,
    [world.sourceCompanyId, key, world.userId]
  );
  if (tradeId) {
    await world.q(
      `INSERT INTO intercompany_shared_charge_allocations (invoice_id, trade_id, amount) VALUES ($1, $2, '50')`,
      [invoiceId, tradeId]
    );
  }
  if (confirmed) {
    await world.q(
      `UPDATE intercompany_shared_charge_invoices SET state = 'confirmed', confirmed_at = now() WHERE id = $1`,
      [invoiceId]
    );
  }
  return invoiceId;
}

describe("grantSharedChargeEditor", () => {
  it("refuses non-owner roles and malformed input before touching the database", async () => {
    await inWorld(async (world) => {
      const input: SharedEditorGrantInput = {
        userId: world.userId,
        relationshipId: world.relationshipId,
        scope: "relationship",
      };
      expect(
        await failure(() => grantSharedChargeEditor(input, world.identity(world.sourceCompanyId, "Admin")))
      ).toMatchObject({
        code: "IC_PERMISSION_FORBIDDEN",
        status: 403,
      });
      for (const patch of [
        { userId: "  " },
        { userId: "u".repeat(129) },
        { relationshipId: 0 },
        { relationshipId: 1.5 },
        { scope: "company" as never },
      ]) {
        expect(await failure(() => grantSharedChargeEditor({ ...input, ...patch }, world.identity()))).toMatchObject({
          code: "IC_PERMISSION_INPUT",
          status: 422,
        });
      }
    });
  });

  it("refuses unknown relationships and companies outside the relationship", async () => {
    await inWorld(async (world) => {
      const input: SharedEditorGrantInput = {
        userId: world.userId,
        relationshipId: 2_000_000_000,
        scope: "relationship",
      };
      expect(await failure(() => grantSharedChargeEditor(input, world.identity()))).toMatchObject({
        code: "IC_PERMISSION_FORBIDDEN",
      });
      const stranger = await world.company("X", "erp");
      const owner = await world.otherUser([[stranger, "Owner"]]);
      expect(
        await failure(() =>
          grantSharedChargeEditor(
            { ...input, relationshipId: world.relationshipId },
            world.identity(stranger, "Owner", owner)
          )
        )
      ).toMatchObject({ code: "IC_PERMISSION_FORBIDDEN", status: 403 });
    });
  });

  it("requires a bounded invoice reference for invoice-scoped grants", async () => {
    await inWorld(async (world) => {
      const input: SharedEditorGrantInput = {
        userId: world.userId,
        relationshipId: world.relationshipId,
        scope: "invoice",
      };
      expect(await failure(() => grantSharedChargeEditor(input, world.identity()))).toMatchObject({
        code: "IC_PERMISSION_INVOICE",
        status: 422,
      });
      expect(
        await failure(() => grantSharedChargeEditor({ ...input, invoiceKey: "k".repeat(121) }, world.identity()))
      ).toMatchObject({ code: "IC_PERMISSION_INVOICE" });
    });
  });

  it("refuses grantees who are not members of the granting company", async () => {
    await inWorld(async (world) => {
      const outsider = await world.otherUser([[world.destinationCompanyId, "Viewer"]]);
      const result = await failure(() =>
        grantSharedChargeEditor(
          { userId: outsider, relationshipId: world.relationshipId, scope: "relationship" },
          world.identity()
        )
      );
      expect(result).toMatchObject({ code: "IC_PERMISSION_USER", status: 422 });
      const rows = await world.q(`SELECT id FROM intercompany_permission_grants WHERE relationship_id = $1`, [
        world.relationshipId,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it("refuses unknown, unconfirmed and unrelated invoices", async () => {
    await inWorld(async (world) => {
      const grantee = await world.otherUser([[world.sourceCompanyId, "Accountant"]]);
      const grant = (invoiceKey: string) =>
        failure(() =>
          grantSharedChargeEditor(
            { userId: grantee, relationshipId: world.relationshipId, scope: "invoice", invoiceKey },
            world.identity()
          )
        );
      expect(await grant("NOPE-INVOICE")).toMatchObject({ code: "IC_PERMISSION_INVOICE", status: 422 });
      await sharedInvoice(world, `${world.tag}-DRAFT`, false);
      expect(await grant(`${world.tag}-DRAFT`)).toMatchObject({
        message: "Confirmed shared invoice does not exist",
      });
      await sharedInvoice(world, `${world.tag}-ORPHAN`, true);
      expect(await grant(`${world.tag}-ORPHAN`)).toMatchObject({
        message: "Invoice is not associated with the granting company's relationship",
      });
    });
  });

  it("grants relationship and invoice scopes and revokes them once", async () => {
    await inWorld(async (world) => {
      const grantee = await world.otherUser([[world.destinationCompanyId, "Accountant"]]);
      const trade = await world.trade("G");
      await sharedInvoice(world, `${world.tag}-OK`, true, trade.tradeId);
      const invoiceGrant = await grantSharedChargeEditor(
        { userId: grantee, relationshipId: world.relationshipId, scope: "invoice", invoiceKey: ` ${world.tag}-OK ` },
        world.identity(world.destinationCompanyId, "Developer")
      );
      // The invoice is owned by the source company; the destination grants against the same relationship.
      expect(invoiceGrant).toMatchObject({ scope: "invoice", invoiceKey: `${world.tag}-OK`, userId: grantee });

      const relationGrant = await grantSharedChargeEditor(
        { userId: world.userId, relationshipId: world.relationshipId, scope: "relationship", invoiceKey: "ignored" },
        world.identity()
      );
      expect(relationGrant).toMatchObject({ scope: "relationship", invoiceKey: null });

      expect(
        await failure(() =>
          revokeSharedChargeEditor(relationGrant.grantId, world.identity(world.sourceCompanyId, "Admin"))
        )
      ).toMatchObject({
        code: "IC_PERMISSION_FORBIDDEN",
      });
      // Another company cannot revoke this company's grant.
      expect(
        await failure(() => revokeSharedChargeEditor(relationGrant.grantId, world.identity(world.destinationCompanyId)))
      ).toMatchObject({ code: "IC_PERMISSION_NOT_FOUND", status: 404 });

      await expect(revokeSharedChargeEditor(relationGrant.grantId, world.identity())).resolves.toEqual({
        grantId: relationGrant.grantId,
        revoked: true,
      });
      expect(await failure(() => revokeSharedChargeEditor(relationGrant.grantId, world.identity()))).toMatchObject({
        code: "IC_PERMISSION_NOT_FOUND",
      });
      const [row] = await world.q(`SELECT revoked_by FROM intercompany_permission_grants WHERE id = $1`, [
        relationGrant.grantId,
      ]);
      expect(row.revoked_by).toBe(world.userId);
    });
  });
});
