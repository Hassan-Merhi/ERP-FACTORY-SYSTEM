import { describe, expect, it } from "vitest";

import { hasAwaitedAuditWrite, moduleSource } from "./auditCoverageSource";

/**
 * Phase 8C aimed to put every domain mutation behind the shared audit path.
 * It did not finish, and because this file was never picked up by any vitest
 * config the shortfall stayed invisible for as long as it existed.
 *
 * So the lists below are a ratchet rather than an aspiration: AUDITED must keep
 * its wiring, and UNAUDITED is the outstanding work, asserted exactly so that
 * wiring one up fails this test and forces the file to move lists. Neither set
 * may grow silently.
 */
const AUDITED = [
  "server/routes/stock/transfer-adj",
  "server/routes/containers/containerCrudRoutes.ts",
  "server/routes/containers/containerFreightWriteRoutes.ts",
];

const UNAUDITED = [
  // No reference to logAudit at all.
  "server/routes/inventoryRoutes.ts",
  // Imports logAudit but never calls it - the import is the only trace of the
  // intent, so it is asserted here to stop the module drifting further away.
  "server/routes/containers/offload",
];

describe("Phase 8C domain audit coverage", () => {
  it.each(AUDITED)("keeps %s connected to the shared audit path", (modulePath) => {
    expect(hasAwaitedAuditWrite(modulePath)).toBe(true);
  });

  it.each(UNAUDITED)("records %s as a known gap in domain audit coverage", (modulePath) => {
    expect(
      hasAwaitedAuditWrite(modulePath),
      `${modulePath} now has awaited audit writes. Move it from UNAUDITED to AUDITED ` + "so the gain is locked in."
    ).toBe(false);
  });

  it("keeps the compatibility adapter connected to the hardened audit framework", () => {
    const contents = moduleSource("server/routes/helpers/auditWriteAdapter.ts");

    expect(contents).toContain('from "../../services/audit"');
    // Wave 12: the adapter forwards the caller's transaction, if any, as the executor.
    expect(contents).toContain("await writeAuditEvent(params, executor)");
  });
});
