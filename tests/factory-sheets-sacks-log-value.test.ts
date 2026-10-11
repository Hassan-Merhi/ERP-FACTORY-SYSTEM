/**
 * The Sheets & Sacks log stores total_value = pieces x unit price in a
 * NUMERIC(…,2) column. As a float product 3 x 0.155 is 0.46499999999999997,
 * which the column rounded to 0.46; the exact value 0.465 rounds to 0.47.
 */
import { describe, expect, it, vi } from "vitest";

import { insertLog } from "../server/routes/factory/factorySheetsAndSacksRoutes";

function fakeClient() {
  const query = vi.fn(async () => ({ rows: [] }));
  return { client: { query } as unknown as import("pg").PoolClient, query };
}

describe("Sheets & Sacks log value", () => {
  it("logs pieces x unit price as an exact decimal string", async () => {
    const { client, query } = fakeClient();
    await insertLog(client, 1, 2, "Sack", "SACK", "IN", 3, null, "0.155", null);
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params[7]).toBe("0.155");
    expect(params[8]).toBe("0.465");
  });

  it("treats a missing unit price as zero", async () => {
    const { client, query } = fakeClient();
    await insertLog(client, 1, 2, "Sack", "SACK", "OUT", 4, 1, null, "note");
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params[7]).toBe("0");
    expect(params[8]).toBe("0");
  });
});
