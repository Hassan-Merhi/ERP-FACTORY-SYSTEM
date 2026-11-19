import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";
import { describe, expect, it } from "vitest";
import { mayReceiveFromProperties } from "../server/services/intercompany/phase5ReceivingAccess";

const pair = { sourceCompanyId: 10, destinationCompanyId: 20 };
const actor = (companyId: number, actorRole: string) => ({
  initiatingCompanyId: companyId,
  actorUserId: "test-user",
  actorRole,
});

describe("Phase 5 Properties container workflow", () => {
  it("allows Properties initiation only when the actor has source rights and destination ERP edit membership", () => {
    expect(mayReceiveFromProperties(pair, actor(10, "Owner"), "properties", "erp", "Owner")).toBe(true);
    expect(mayReceiveFromProperties(pair, actor(10, "Developer"), "properties", "erp", "Admin")).toBe(true);
    expect(mayReceiveFromProperties(pair, actor(10, "Owner"), "properties", "erp", "Developer")).toBe(true);
  });
  it.each(["View Only", "Tester", "Create Only", "Admin", "Worker"])(
    "denies Properties role %s without cross-company receipt approval",
    (role) => {
      expect(mayReceiveFromProperties(pair, actor(10, role), "properties", "erp", "Owner")).toBe(false);
    }
  );
  it("denies guessed destination IDs and absent or insufficient destination ERP membership", () => {
    expect(mayReceiveFromProperties(pair, actor(30, "Owner"), "properties", "erp", "Owner")).toBe(false);
    expect(mayReceiveFromProperties(pair, actor(10, "Owner"), "properties", "erp", null)).toBe(false);
    expect(mayReceiveFromProperties(pair, actor(10, "Owner"), "properties", "erp", "View Only")).toBe(false);
    expect(mayReceiveFromProperties(pair, actor(10, "Owner"), "properties", "erp", "Create Only")).toBe(false);
  });
  it("rejects source/destination company types that do not form a Properties-to-ERP pair", () => {
    expect(mayReceiveFromProperties(pair, actor(10, "Owner"), "erp", "erp", "Owner")).toBe(false);
    expect(mayReceiveFromProperties(pair, actor(10, "Developer"), "properties", "factory", "Owner")).toBe(false);
  });
  it("keeps the canonical container ID in both lifecycle and linked PO list responses", () => {
    const lifecycle = readModuleFamily("server/routes/import/intercompany-phase5.ts");
    const linked = readModuleFamily("server/routes/import/intercompany-phase3.ts");
    expect(lifecycle).toContain("physicalContainerId: trade.physicalContainerId");
    expect(linked).toContain("physicalContainerId: t.physicalContainerId");
    expect(linked).toContain("req.query.physicalContainerId");
    const editor = readModuleFamily("client/src/pages/intercompany/LinkedTradesEditor.tsx");
    expect(editor).toContain('"?physicalContainerId=" + physicalContainerId');
  });
  it("uses the existing protected receipt/cancel endpoints from the embedded lifecycle", () => {
    const lifecycle = readModuleFamily("client/src/pages/intercompany/IntercompanyLifecycle.tsx");
    const receipt = readModuleFamily("server/services/intercompany/phase5Receipt.ts");
    const permissions = readModuleFamily("server/services/intercompany/phase5ReceivingAccess.ts");
    expect(lifecycle).toContain("physicalContainerId?: number; embedded?: boolean");
    expect(lifecycle).toContain('"/receiving-options"');
    expect(lifecycle).toContain('"/receive"');
    expect(lifecycle).toContain('"/cancel"');
    expect(receipt).toContain("await requireReceivingPairPermission(trade, actor)");
    expect(permissions).toContain("eq(userCompanyRoles.companyId, trade.destinationCompanyId)");
    expect(permissions).toContain("!source[0]?.active || !destination[0]?.active");
    expect(receipt).toContain("receiveInventoryAtValue(tx");
  });
  it("automatically selects only a unique verified INVENTORY asset account in the correct ERP company", () => {
    const routes = readModuleFamily("server/routes/import/intercompany-phase5.ts");
    expect(routes).toContain("lifecycle/:tradeId/receiving-options");
    expect(routes).toContain("eq(ledgerAccounts.companyId, trade.destinationCompanyId)");
    expect(routes).toContain('eq(ledgerAccounts.code, "INVENTORY")');
    expect(routes).toContain("eligible.length === 1 ? eligible[0].id : null");
    expect(routes).toContain("await requireReceivingPairPermission(trade, identity)");
    const screen = readModuleFamily("client/src/pages/intercompany/IntercompanyLifecycle.tsx");
    expect(screen).toContain("receivingOptions.data?.inventoryAccountId");
    expect(screen).not.toContain("Choose verified inventory account</option>");
  });
  it("embeds both actions on Properties container details without exposing legacy PO edit/delete", () => {
    const details = readModuleFamily("client/src/pages/containerdetail/components/ContainerDetailErpView.tsx");
    const panel = readModuleFamily("client/src/pages/containerdetail/PropertiesIntercompanyContainerWorkflow.tsx");
    expect(details).toMatch(/PropertiesIntercompanyContainerWorkflow containerId=\{(?:v\.)?container\.id\}/);
    expect(details).toMatch(/!(?:m\.)?isPropertiesContainer && (?:m\.)?canChangeExistingRecords/);
    expect(panel).toContain("<LinkedTradesEditor physicalContainerId={containerId} embedded />");
    expect(panel).toContain("<IntercompanyLifecycle physicalContainerId={containerId} embedded />");
    expect(panel).toContain("candidate.physicalContainerId === containerId");
    expect(panel).toContain("candidate.sourceCompanyId");
  });
  it("keeps the original financial reversal and freight allocation services intact", () => {
    const cancel = readModuleFamily("server/services/intercompany/phase5Cancel.ts");
    const freight = readModuleFamily("client/src/pages/intercompany/LinkedTradesEditor.tsx");
    expect(cancel).toContain("confirmNoRealCashReversal");
    expect(cancel).toContain("requireUnreceived(data)");
    expect(freight).toContain('BASE + "/shared-charges/confirm"');
    expect(freight).toContain('BASE + "/shared-charges/" + invoice.data.invoiceId');
  });
});
