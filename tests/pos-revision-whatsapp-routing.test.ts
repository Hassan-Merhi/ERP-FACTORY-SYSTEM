import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("POS revision WhatsApp routing", () => {
  it("routes revision images to the Settings → Stock Transfers group of the POS source location", () => {
    const helper = readModuleFamily("server/helpers/sendRevisedTransferWhatsApp.ts");
    const routes = readModuleFamily("server/routes/vouchers/immutableStockTransferRevisionRoutes.ts");
    const lifecycle = readModuleFamily("server/services/immutableStockTransferRevisionLifecycle.ts");

    // The route passes the source location from the revision items, and the
    // lifecycle enforces that a POS user can only submit their assigned source.
    expect(routes).toContain("queueRevisedTransferWhatsApp(result)");
    expect(routes).toContain("sourceLocationId,");
    expect(lifecycle).toContain("sourceLocationIdLimit");
    expect(lifecycle).toContain("item.sourceLocationId !== input.sourceLocationIdLimit");

    // Recipient selection must use the transfer WhatsApp group configured in
    // Settings → Stock Transfers for the POS source (assigned) location, with
    // the company-level transfer group as fallback — same as transfer creation.
    expect(helper).toContain("transferWaGroupChatId: locations.transferWaGroupChatId");
    expect(helper).toContain(".where(eq(locations.id, sourceLocationId))");
    expect(helper).toContain("companies.transferWaGroupChatId");
    expect(helper).toContain("skipping without fallback");

    // Regression guard: never route revisions by the POS chat assignment or the
    // transfer destination. Those settings can point at another group.
    expect(helper).not.toContain("whatsappGroupChatId: locations.whatsappGroupChatId");
    expect(helper).not.toContain(".where(eq(locations.id, destinationId))");
    expect(helper).not.toContain(".where(eq(locations.id, destinationLocationId))");
  });
});
