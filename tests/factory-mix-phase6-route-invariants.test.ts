import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Phase 6 mix quantity writer guards", () => {
  it("serializes mix creation and carry-forward code allocation", () => {
    const create = read("server/routes/factory/mix-batches/create.ts");
    const consume = read("server/routes/factory/mix-batches/consume.ts");
    const lock = "pg_advisory_xact_lock(hashtext('factory_mix_batch_sequence')";
    expect(create).toContain(lock);
    expect(consume).toContain(lock);
    expect(consume).toContain('status: "CARRY_FORWARD"');
    expect(consume).toContain('sourceType: "BATCH"');
    expect(consume).toContain("carryForwardFromId: batchId");
    expect(consume).toContain("leftoverCost.toDecimalPlaces(7).toFixed(7)");
  });

  it("prevents posted-perpetual consumption without a production/GL movement", () => {
    const source = read("server/routes/factory/mix-batches/consume.ts");
    expect(source).toContain("isPerpetualInventoryActive(tx, companyId, usedDate)");
    expect(source).toContain("validateMixLifecycleUsageRequest(req.body)");
    expect(source).toContain("requireMixLifecycleUsage(batch, kgUsed.toFixed(3))");
    expect(source).toContain('status: "CLOSED"');
  });

  it("requires reviewed waste kg under the row lock and audits it", () => {
    const source = read("server/routes/factory/mix-batches/finalize-delete.ts");
    expect(source).toContain("requireMixFinalizeDecision(batch, req.body)");
    expect(source).toContain('.for("update")');
    expect(source).toContain("confirmedWasteKg: { old: null, new: remainingKg.toFixed(3) }");
    expect(source).toContain("wasteReason: { old: null, new: wasteReason }");
  });

  it("rejects multi-row container reversal and never silently clamps raw used kg", () => {
    const source = read("server/routes/factory/mix-batches/finalize-delete.ts");
    expect(source).toMatch(/requireMixDeletionSafe\(\s*batch\s*,/);
    expect(source).toContain("rawRows.length !== 1");
    expect(source).toContain("currentUsed.lt(weight)");
    expect(source).not.toContain("GREATEST(");
  });

  it("ignores source rows of soft-deleted downstream mixes when checking live dependencies", () => {
    const liveOwnerOnly =
      /\.from\(factoryMixBatchSources\)\s*\.innerJoin\(factoryMixBatches, eq\(factoryMixBatches\.id, factoryMixBatchSources\.mixBatchId\)\)\s*\.where\(and\(eq\(factoryMixBatchSources\.sourceBatchId, (?:id|batch\.id)\), isNull\(factoryMixBatches\.deletedAt\)\)\)/;
    expect(read("server/routes/factory/mix-batches/finalize-delete.ts")).toMatch(liveOwnerOnly);
    expect(read("server/services/factory/mixBatchEditReview.ts")).toMatch(liveOwnerOnly);
  });

  it("requires unique original raw stock and exact capacity before deleted mix restore", () => {
    const source = read("server/routes/admin/deleted-items/restore.ts");
    expect(source).toContain("requireMixDeletionSafe({ ...mix, deletedAt: null }, false)");
    expect(source).toContain("rows.length !== 1");
    expect(source).toContain("requireMixLifecycleAvailable(parent)");
    expect(source).toContain("SUPPLIER_ADJUSTMENT_BACKED");
    expect(source).toContain("Restoring mix source consumption after perpetual inventory cutover");
  });

  it("has a read-only, tenant-scoped exception report and CSV in the existing mix endpoint", () => {
    const source = read("server/services/factory/mixPhase6LifecycleAudit.ts");
    const route = read("server/routes/factory/mix-batches/reads.ts");
    expect(source).toContain("REPEATABLE READ READ ONLY");
    expect(source).toContain("app.current_company_id");
    expect(source).toContain("CARRY_PARENT_DELETED");
    expect(route).toContain('profile === "lifecycle-audit"');
    expect(route).toContain("phase6MixLifecycleCsv");
  });
});
