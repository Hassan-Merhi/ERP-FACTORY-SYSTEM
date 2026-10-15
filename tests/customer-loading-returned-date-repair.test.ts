import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runApprovedReturnedLoadingDateRepair } from "../server/startup/runApprovedReturnedLoadingDateRepair";

const FLAG = "FACTORY_CUSTOMER_RETURNED_LOADING_DATE_REPAIR_20261015";
const previous = process.env[FLAG];

afterEach(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

describe("returned loading date historical repair", () => {
  it("never connects to production without an explicit company-12 approval", async () => {
    delete process.env[FLAG];
    const connect = vi.fn();
    await runApprovedReturnedLoadingDateRepair({ connect } as never);
    expect(connect).not.toHaveBeenCalled();
  });

  it("uses the original dated submission and persists a reversible null before-image", () => {
    const source = readFileSync("server/startup/runApprovedReturnedLoadingDateRepair.ts", "utf8");
    expect(source).toContain("fde.id=30945");
    expect(source).toContain("fde.tx_date=DATE '2026-10-13'");
    expect(source).toContain("earlier.created_at,earlier.id");
    expect(source).toContain("old_loading_finalized_at TIMESTAMP WITHOUT TIME ZONE,");
    expect(source).toContain("AND o.loading_finalized_at IS NULL");
    expect(source).toContain("ROLLBACK");
    expect(source).not.toContain("SET verified_at=");
    expect(source).not.toContain("SET finalized_at=");
  });
});
