import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("SP offload concurrency and idempotency contracts", () => {
  const offload = source("server/routes/sp/spOffloadRoutes.ts");
  const containers = source("server/routes/sp/spContainerRoutes.ts");
  const lifecycle = source("server/routes/sp/spOffloadLifecycleRoutes.ts");
  const phase8 = source("server/routes/sp/spGoldenCoastPhase8ContainerOffloadRoutes.ts");

  it("locks and re-checks the legacy container before any offload posting", () => {
    const transactionStart = offload.indexOf("db.transaction");
    const containerLock = offload.indexOf('.for("update")', transactionStart);
    const statusCheck = offload.indexOf('container.status !== "open"', containerLock);
    const firstVoucher = offload.indexOf("tx.insert(vouchers)", statusCheck);

    expect(transactionStart).toBeGreaterThan(-1);
    expect(containerLock).toBeGreaterThan(transactionStart);
    expect(statusCheck).toBeGreaterThan(containerLock);
    expect(firstVoucher).toBeGreaterThan(statusCheck);
  });

  it("reads company-scoped posting inputs only after the lifecycle lock", () => {
    const containerLock = offload.indexOf('.for("update")');
    const lineRead = offload.indexOf(".from(spContainerLines)", containerLock);
    const lineCompanyScope = offload.indexOf("eq(spContainerLines.companyId, companyId)", lineRead);
    const discountRead = offload.indexOf("parseNum(container.discountPct)", lineRead);

    expect(lineRead).toBeGreaterThan(containerLock);
    expect(lineCompanyScope).toBeGreaterThan(lineRead);
    expect(discountRead).toBeGreaterThan(lineCompanyScope);
  });

  it("turns duplicate/replayed legacy offloads into a conflict instead of a second posting", () => {
    expect(offload).toContain('"SP_OFFLOAD_ALREADY_DONE"');
    expect(offload).toContain('eq(spContainers.status, "open")');
    expect(offload).toContain('"SP_OFFLOAD_STATE_CONFLICT"');
  });

  it("serializes container edits with offload and derives defaults from locked state", () => {
    const transactionStart = containers.indexOf("db.transaction");
    const lock = containers.indexOf('.for("update")', transactionStart);
    const statusCheck = containers.indexOf('lockedExisting.status === "offloaded"', lock);
    const update = containers.indexOf(".update(spContainers)", statusCheck);

    expect(lock).toBeGreaterThan(transactionStart);
    expect(statusCheck).toBeGreaterThan(lock);
    expect(update).toBeGreaterThan(statusCheck);
    expect(containers).toContain("invoiceTotalUsd ?? lockedExisting.invoiceTotalUsd");
    expect(containers).toContain('"SP_CONTAINER_STATE_CONFLICT"');
  });

  it("keeps reversal and Golden Coast paths serialized as well", () => {
    expect(lifecycle).toMatch(/FROM sp_offloads[\s\S]*FOR UPDATE/);
    expect(lifecycle).toMatch(/FROM sp_containers[\s\S]*FOR UPDATE/);
    expect(phase8).toContain('.for("update")');
    expect(phase8).toContain("pg_advisory_xact_lock");
  });
});
