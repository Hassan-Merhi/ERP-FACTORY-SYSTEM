import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbTransaction } from "../server/db";

const env = vi.hoisted(() => ({ mode: "lan", primary: true, siteId: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f" }));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", () => ({
  readFactoryEdgeConfiguration: () => env,
}));

import { capturePhase9PressingTx, ensurePhase9PressingOutboxSchema } from "../server/edge/phase9PressingOutbox";
import { Phase9PressingRefusal } from "../server/edge/phase9PressingEnvelope.mjs";

const evidence = {
  companyId: 5,
  actorUserId: "worker-1",
  localConfirmationId: 13,
  requestId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  baleId: 100,
  machineId: 4,
  assignmentId: 3,
  referenceNumber: "BALE-100",
  confirmedAt: "2026-10-30T06:45:10.000Z",
  deviceCapturedAt: null,
  productionDate: "2026-10-30",
  timezoneName: "Asia/Beirut",
};

afterEach(() => {
  env.mode = "lan";
  env.primary = true;
});

function transaction() {
  const execute = vi.fn(async () => undefined);
  return { execute, tx: { execute } as unknown as DbTransaction };
}

describe("Phase 9 physical scan capture (not LAN write approval)", () => {
  it("cannot mutate a cloud DB or a read-only LAN", async () => {
    for (const mode of ["cloud", "lan"]) {
      env.mode = mode;
      env.primary = false;
      const { tx, execute } = transaction();
      await capturePhase9PressingTx(tx, evidence);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed evidence without touching any local table", async () => {
    const { tx, execute } = transaction();
    await expect(capturePhase9PressingTx(tx, { ...evidence, companyId: 0 })).rejects.toBeInstanceOf(
      Phase9PressingRefusal
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires all evidence to share the caller's business transaction", async () => {
    const { tx, execute } = transaction();
    await capturePhase9PressingTx(tx, evidence);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every((args) => args.length === 1)).toBe(true);
  });

  it("creates a separate immutable sequence and append-only receipt stream only on LAN", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (queryText: string) => {
      statements.push(queryText);
      return { rows: [] };
    });
    await ensurePhase9PressingOutboxSchema({ query } as never);
    expect(statements.join("\n")).toContain("factory_edge_pressing_counter");
    expect(statements.join("\n")).toContain("factory_edge_pressing_outbox");
    expect(statements.join("\n")).toContain("BEFORE UPDATE OR DELETE");
    expect(statements.join("\n")).toContain("FOREIGN KEY (company_id, local_confirmation_id)");
    expect(statements.join("\n")).toContain("ON DELETE RESTRICT");
    expect(statements.join("\n")).not.toContain("factory_edge_outbox_counter");
    statements.length = 0;
    env.mode = "cloud";
    await ensurePhase9PressingOutboxSchema({ query } as never);
    expect(statements).toHaveLength(0);
  });

  it("retains atomic scan rollback semantics when evidence insertion fails", async () => {
    const tx = { execute: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("DB_DISK_FULL")) };
    await expect(capturePhase9PressingTx(tx as unknown as DbTransaction, evidence)).rejects.toThrow("DB_DISK_FULL");
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
});
