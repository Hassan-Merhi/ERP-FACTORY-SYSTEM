/**
 * Synchronized linked-PO price edits against the real schema: identity and
 * scope refusals, every input/state refusal (with both POs unchanged), request
 * key replay, and a posted edit that mirrors both companies.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  assertTradeAccess,
  editLinkedTrade,
  getTradeDetail,
  withTradeScope,
  type LinkedLineEdit,
  type LinkedTradeEditInput,
} from "../server/services/intercompany/tradeSync";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { runWithCompanyRequestRuntimeContext } from "../server/services/security/companyRequestRuntimeContext";

type Trade = Awaited<ReturnType<IntercompanyTradeWorld["trade"]>>;
let keySeq = 0;

async function world<T>(work: (w: IntercompanyTradeWorld, t: Trade) => Promise<T>, status = "OTW", destRate?: string) {
  return withRolledBackPool(async (client) => {
    const w = await createIntercompanyTradeWorld(client);
    const t = await w.trade("A", status, destRate);
    await t.audit();
    return work(w, t);
  });
}

function edit(t: Trade, patch: Partial<LinkedTradeEditInput> = {}, line: Partial<LinkedLineEdit> = {}) {
  return {
    tradeId: t.tradeId,
    expectedVersion: 1,
    requestKey: `edit-key-${process.pid}-${++keySeq}`,
    postingDate: "2026-06-10",
    reason: "Supplier corrected the invoice",
    lines: [{ lineLinkId: t.lineLinkId, quantity: "1", rate: "120.00", itemName: "Bales", ...line }],
    ...patch,
  } satisfies LinkedTradeEditInput;
}

async function prices(w: IntercompanyTradeWorld, t: Trade) {
  return w.q<{ rate: string }>(`SELECT rate::text FROM po_line_items WHERE id IN ($1, $2) ORDER BY id`, [
    t.sourceLineId,
    t.destinationLineId,
  ]);
}

async function refusedEdit(w: IntercompanyTradeWorld, t: Trade, input: LinkedTradeEditInput, code: string) {
  await expect(editLinkedTrade(input, w.identity())).rejects.toMatchObject({ code });
  expect((await prices(w, t)).map((r) => Number(r.rate))).toEqual([100, Number((await prices(w, t))[1].rate)]);
  const [{ n }] = await w.q<{ n: number }>(
    `SELECT count(*)::int AS n FROM intercompany_trade_revisions WHERE trade_id = $1`,
    [t.tradeId]
  );
  expect(n).toBe(0);
}

describe("trade access and scope", () => {
  it("refuses bad roles, revoked membership, bad IDs and companies outside the pair", () =>
    world(async (w, t) => {
      await expect(assertTradeAccess(t.tradeId, w.identity(w.sourceCompanyId, "Viewer"))).rejects.toMatchObject({
        code: "IC_EDIT_FORBIDDEN",
        status: 403,
      });
      await expect(assertTradeAccess(t.tradeId, w.identity(0))).rejects.toMatchObject({ code: "IC_EDIT_FORBIDDEN" });
      const viewer = await w.otherUser([[w.sourceCompanyId, "Viewer"]]);
      await expect(assertTradeAccess(t.tradeId, w.identity(w.sourceCompanyId, "Admin", viewer))).rejects.toMatchObject({
        code: "IC_EDIT_FORBIDDEN",
      });
      await expect(assertTradeAccess(-5, w.identity())).rejects.toMatchObject({ code: "IC_EDIT_ID", status: 422 });
      const other = await w.company("O", "erp");
      const outsider = await w.otherUser([[other, "Owner"]]);
      await expect(assertTradeAccess(t.tradeId, w.identity(other, "Owner", outsider))).rejects.toMatchObject({
        code: "IC_EDIT_NOT_FOUND",
        status: 404,
      });
      // A Developer needs no membership row.
      const developer = await w.otherUser([]);
      expect((await assertTradeAccess(t.tradeId, w.identity(w.destinationCompanyId, "Developer", developer))).id).toBe(
        t.tradeId
      );
    }));

  it("refuses when the database scope or the request company disagrees with the session", () =>
    world(async (w) => {
      const work = async () => "ran";
      await expect(
        runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(w.destinationCompanyId), () =>
          withTradeScope(w.identity(), [], work)
        )
      ).rejects.toMatchObject({ code: "IC_EDIT_SCOPE" });
      const request = {
        userId: w.userId,
        role: "Owner",
        method: "POST",
        path: "/test",
        developerBypass: false,
      };
      await expect(
        runWithCompanyRequestRuntimeContext({ ...request, companyId: w.destinationCompanyId }, () =>
          withTradeScope(w.identity(), [], work)
        )
      ).rejects.toMatchObject({ code: "IC_EDIT_SCOPE" });
      expect(
        await runWithCompanyRequestRuntimeContext({ ...request, companyId: w.sourceCompanyId }, () =>
          withTradeScope(w.identity(), [w.destinationCompanyId], work)
        )
      ).toBe("ran");
    }));

  it("returns the mirrored line detail to either company", () =>
    world(async (w, t) => {
      const detail = await getTradeDetail(t.tradeId, w.identity(w.destinationCompanyId));
      expect(detail).toMatchObject({
        tradeId: t.tradeId,
        version: 1,
        destinationPoId: t.destinationPoId,
        landedCost: "100.00",
        destinationReceivedAt: null,
        lines: [{ lineLinkId: t.lineLinkId, sourceLineId: t.sourceLineId, destinationLineId: t.destinationLineId }],
      });
    }));
});

describe("editLinkedTrade refusals", () => {
  it("validates date, request key and input shape before touching the trade", () =>
    world(async (w, t) => {
      await refusedEdit(w, t, edit(t, { postingDate: "2026-13-45" }), "IC_EDIT_DATE");
      await refusedEdit(w, t, edit(t, { requestKey: "short" }), "IC_EDIT_KEY");
      await refusedEdit(w, t, edit(t, { expectedVersion: 0 }), "IC_EDIT_INPUT");
      await refusedEdit(w, t, edit(t, { reason: "  " }), "IC_EDIT_INPUT");
      await refusedEdit(w, t, edit(t, { lines: [] }), "IC_EDIT_INPUT");
    }));

  it("refuses a stale version and an incomplete or foreign line set", () =>
    world(async (w, t) => {
      await refusedEdit(w, t, edit(t, { expectedVersion: 3 }), "IC_EDIT_STALE_VERSION");
      const twice = edit(t);
      twice.lines.push({ ...twice.lines[0] });
      await refusedEdit(w, t, twice, "IC_EDIT_LINES");
      await refusedEdit(w, t, edit(t, {}, { lineLinkId: 999999999 }), "IC_EDIT_LINES");
    }));

  it("refuses invalid item names, quantities and unchanged edits", () =>
    world(async (w, t) => {
      await refusedEdit(w, t, edit(t, {}, { itemName: " " }), "IC_EDIT_INPUT");
      await refusedEdit(w, t, edit(t, {}, { quantity: "-1" }), "IC_EDIT_INPUT");
      await refusedEdit(w, t, edit(t, {}, { quantity: "1.000", rate: "100.00" }), "IC_EDIT_NO_CHANGE");
      await refusedEdit(w, t, edit(t, {}, { rate: "0" }), "IC_EDIT_UNSAFE");
    }));

  it("refuses a received or offloaded container", () =>
    world((w, t) => refusedEdit(w, t, edit(t), "IC_EDIT_INVENTORY_DEPENDENCY"), "Offloaded"));

  it("refuses when the source and destination lines disagree", () =>
    world((w, t) => refusedEdit(w, t, edit(t), "IC_EDIT_UNSAFE"), "OTW", "99.00"));

  it("refuses when a verified mapping is missing", () =>
    world(async (w, t) => {
      await w.q(
        `UPDATE intercompany_relationship_policies SET destination_git_account_id = NULL, trade_enabled = FALSE WHERE id = $1`,
        [w.relationshipId]
      );
      await refusedEdit(w, t, edit(t), "IC_EDIT_UNSAFE");
    }));

  it("refuses a request key already used by another trade", () =>
    world(async (w, t) => {
      const other = await w.trade("B");
      const input = edit(t);
      await w.q(
        `INSERT INTO intercompany_trade_revisions (trade_id, revision_number, kind, request_key, actor_user_id,
           initiating_company_id, amount_before, amount_after, posting_date, reason)
         VALUES ($1, 2, 'line_edit', $2, $3, $4, 100, 90, '2026-06-02', 'fixture')`,
        [other.tradeId, input.requestKey, w.userId, w.sourceCompanyId]
      );
      await expect(editLinkedTrade(input, w.identity())).rejects.toMatchObject({ code: "IC_EDIT_REPLAY" });
    }));
});

describe("editLinkedTrade posting", () => {
  // Current behaviour (see report): the unchanged-edit check compares the stored
  // quantity text ("1.000") with the submitted text ("1"), so re-submitting the
  // same values in a different spelling records a zero-money revision.
  it("records a zero-delta revision when only the quantity spelling differs", () =>
    world(async (w, t) => {
      const result = await editLinkedTrade(edit(t, {}, { quantity: "1", rate: "100.00" }), w.identity());
      expect(result).toMatchObject({ version: 2, landedCost: "100.00", replayed: false });
      expect((await prices(w, t)).map((r) => Number(r.rate))).toEqual([100, 100]);
    }));

  it("mirrors the new price into both POs, posts the adjustment journals and replays the same key", () =>
    world(async (w, t) => {
      const input = edit(t);
      const result = await editLinkedTrade(input, w.identity(w.destinationCompanyId));
      expect(result).toMatchObject({ tradeId: t.tradeId, version: 2, landedCost: "120.00", replayed: false });
      expect((await prices(w, t)).map((r) => Number(r.rate))).toEqual([120, 120]);
      const [row] = await w.q(
        `SELECT (SELECT items_total::text FROM purchase_orders WHERE id = $1) AS source_total,
                (SELECT items_total::text FROM purchase_orders WHERE id = $2) AS destination_total,
                (SELECT state FROM intercompany_trade_revisions WHERE id = $3) AS state,
                (SELECT count(*)::int FROM intercompany_audit_events WHERE event_key = 'ic-trade-revision:' || $3) AS audit`,
        [t.sourcePoId, t.destinationPoId, result.revisionId]
      );
      expect(row).toEqual({
        source_total: "120.00",
        destination_total: "120.00",
        state: "completed",
        audit: 1,
      });
      const replay = await editLinkedTrade(input, w.identity());
      expect(replay).toMatchObject({ revisionId: result.revisionId, replayed: true, landedCost: "120.00" });
    }));
});
