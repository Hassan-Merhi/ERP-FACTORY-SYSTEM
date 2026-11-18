/**
 * Full offline mode (Phase A): every table must say which company's PCs may
 * hold its rows, and no secret column may reach a PC.
 */
import { describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import {
  PC_SYNC_START,
  PcSyncCursorInvalid,
  decodePcSyncCursor,
  encodePcSyncCursor,
} from "../server/offline/pcSync/changeFeedReader";

const schemaOf = (tables: Record<string, string[]>) =>
  new Map(Object.entries(tables).map(([table, columns]) => [table, new Set(columns)]));

const basePolicy = {
  excluded: { session: "Login sessions." },
  excludedPrefixes: { factory_edge_: "Sync bookkeeping." },
  self: { companies: "id" },
  members: { users: { table: "user_company_roles", column: "user_id" } },
  companyColumns: {},
  parents: {},
  shared: {},
  redact: { users: ["password"] },
};

const baseSchema = {
  companies: ["id", "name"],
  users: ["id", "username", "password"],
  user_company_roles: ["id", "user_id", "company_id"],
  vouchers: ["id", "company_id"],
  factory_edge_outbox: ["id", "company_id", "token_hash"],
};

describe("PC sync table policy", () => {
  it("classifies company tables, membership, self and exclusions, and redacts the password", () => {
    const { rules, problems } = resolvePcSyncPolicy(basePolicy, schemaOf(baseSchema));
    expect(problems).toEqual([]);
    expect(rules.get("vouchers")).toMatchObject({ mode: "company" });
    expect(rules.get("companies")).toMatchObject({ mode: "self", column: "id" });
    expect(rules.get("users")).toMatchObject({ mode: "members", redact: ["password"] });
    expect(rules.get("factory_edge_outbox")).toMatchObject({ mode: "excluded" });
  });

  it("refuses an unclassified table, an unredacted secret and a stale rule", () => {
    const { problems } = resolvePcSyncPolicy(
      { ...basePolicy, redact: {}, parents: { gone_items: [{ column: "gone_id", table: "gone" }] } },
      schemaOf({ ...baseSchema, voucher_lines: ["id", "voucher_id"] })
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "users.password looks secret: redact it or exclude the table.",
        "voucher_lines has no company_id and no rule: add it to config/pc-sync-table-policy.json.",
        "parents.gone_items names a table that does not exist.",
      ])
    );
  });

  it("follows parent links to a company and refuses links that never reach one", () => {
    const ok = resolvePcSyncPolicy(
      {
        ...basePolicy,
        parents: {
          transfer_vouchers: [{ column: "voucher_id", table: "vouchers" }],
          transfer_items: [{ column: "transfer_id", table: "transfer_vouchers" }],
        },
      },
      schemaOf({ ...baseSchema, transfer_vouchers: ["id", "voucher_id"], transfer_items: ["id", "transfer_id"] })
    );
    expect(ok.problems).toEqual([]);

    const loop = resolvePcSyncPolicy(
      {
        ...basePolicy,
        parents: {
          a_rows: [{ column: "b_id", table: "b_rows" }],
          b_rows: [{ column: "a_id", table: "a_rows" }],
        },
      },
      schemaOf({ ...baseSchema, a_rows: ["id", "b_id"], b_rows: ["id", "a_id"] })
    );
    expect(loop.problems.some((problem: string) => problem.startsWith("Parent links loop"))).toBe(true);
    expect(loop.problems).toContain("a_rows does not resolve to a company through its parent links.");

    const toExcluded = resolvePcSyncPolicy(
      { ...basePolicy, parents: { notes: [{ column: "outbox_id", table: "factory_edge_outbox" }] } },
      schemaOf({ ...baseSchema, notes: ["id", "outbox_id"] })
    );
    expect(toExcluded.problems).toContain("notes -> factory_edge_outbox: the parent table is excluded.");
  });

  it("covers every table of the real schema, with every secret column redacted", async () => {
    const client = await pool.connect();
    try {
      const { problems } = resolvePcSyncPolicy(loadPcSyncPolicy(), await readPublicSchema(client));
      expect(problems).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe("PC sync cursor", () => {
  it("round-trips, starts from the beginning when absent, and refuses anything else", () => {
    const cursor = { from: "1200", to: "1250", afterTxid: "1210", afterSeq: 77 };
    expect(decodePcSyncCursor(encodePcSyncCursor(cursor))).toEqual(cursor);
    expect(decodePcSyncCursor(undefined)).toEqual(PC_SYNC_START);
    for (const bad of [
      "not-base64-json",
      Buffer.from(JSON.stringify(["1", null, "0"])).toString("base64url"),
      Buffer.from(JSON.stringify(["9", "3", "0", 0])).toString("base64url"),
      Buffer.from(JSON.stringify(["1; DROP", null, "0", 0])).toString("base64url"),
      Buffer.from(JSON.stringify(["1", null, "0", -1])).toString("base64url"),
      ["array"],
    ]) {
      expect(() => decodePcSyncCursor(bad)).toThrow(PcSyncCursorInvalid);
    }
  });
});
