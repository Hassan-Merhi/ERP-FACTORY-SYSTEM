/**
 * FX-agent historical cutoff regression contracts.
 * Authored for Claude to run on the existing branch; do not run CI/tests
 * during this handoff. SQL is compiled but never sent to a live database.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../server/db";
import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";
import {
  getFxAgentWalletSnapshot,
  loadFxAgentWalletState,
  loadFxAgentWallets,
  type FxAgentWalletRow,
} from "../server/services/factory/fxAgentWalletDb";
import { summarizeFxWalletHistoryGaps } from "../server/services/factory/netPositionFxWalletCoverage";

const date: FactoryNetPositionAsOf = {
  asOf: "2026-10-19",
  businessToday: "2026-10-23",
  timeZone: "Asia/Beirut",
  historyBasis: "known-at-cutoff",
  isHistorical: true,
};

const wallet: FxAgentWalletRow = {
  id: 77,
  companyId: 12,
  ledgerAccountId: 87,
  accountName: "Agent wallet",
  accountCode: "FXAGENT",
  openingUsd: "100",
  activatedOn: "2026-10-01",
};

function fakeRead(...batches: Array<Record<string, unknown>[]>) {
  const sqlStatements: string[] = [];
  const parameters: unknown[][] = [];
  const dialect = new PgDialect();
  const executor = {
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      sqlStatements.push(query.sql);
      parameters.push(query.params);
      return { rows: batches.shift() ?? [] };
    },
  } as unknown as DatabaseOrTransaction;
  return { executor, sqlStatements, parameters };
}

describe("FX-agent wallet known-at-cutoff Net Position reads", () => {
  it("requires creation-time AND activated-on cutoff for historical wallet selection", async () => {
    const mock = fakeRead();
    await loadFxAgentWallets(12, date.asOf, mock.executor, date);
    const sql = mock.sqlStatements[0];
    expect(sql).toContain("w.activated_on");
    expect(sql).toContain("w.created_at");
    expect(sql).toContain("a.created_at");
    expect(sql).toContain("a.deleted_at");
    expect(sql).toContain("AT TIME ZONE");
    expect(mock.parameters[0]).toContain("Asia/Beirut");
  });

  it("filters historical movements by effective_date AND timestamptz created_at", async () => {
    const mock = fakeRead();
    await loadFxAgentWalletState(wallet, date.asOf, mock.executor, date);
    expect(mock.sqlStatements[0]).toContain("effective_date");
    expect(mock.sqlStatements[0]).toContain("created_at");
    expect(mock.sqlStatements[0]).toContain("AT TIME ZONE");
    expect(mock.parameters[0]).toContain(date.asOf);
    expect(mock.parameters[0]).toContain(date.timeZone);
  });

  it("keeps today's FX wallet query unchanged without a history scope", async () => {
    const a = fakeRead();
    const b = fakeRead();
    await loadFxAgentWallets(12, date.asOf, a.executor);
    await loadFxAgentWalletState(wallet, date.asOf, b.executor);
    expect(a.sqlStatements[0]).not.toContain("w.created_at");
    expect(b.sqlStatements[0]).not.toContain("AND created_at");
  });

  it("uses the already dated Net Position ledger balance instead of asOf-only ledger read", async () => {
    const mock = fakeRead();
    const snapshot = await getFxAgentWalletSnapshot(wallet, date.asOf, mock.executor, "1.18", {
      scope: date,
      ledgerBookUsd: "100",
    });
    expect(snapshot.synchronized).toBe(true);
    expect(snapshot.ledgerBookUsd).toBe("100.000000");
    expect(mock.sqlStatements).toHaveLength(1);
    expect(mock.sqlStatements[0]).toContain("created_at");
    const different = fakeRead();
    const mismatch = await getFxAgentWalletSnapshot(wallet, date.asOf, different.executor, "1.18", {
      scope: date,
      ledgerBookUsd: "99",
    });
    expect(mismatch.synchronized).toBe(false);
  });

  it("rejects accidental mixing of a report date and a different history scope", async () => {
    const mock = fakeRead();
    await expect(loadFxAgentWalletState(wallet, "2026-10-20", mock.executor, date)).rejects.toThrow(
      "HISTORICAL_FX_WALLET_DATE_MISMATCH"
    );
    expect(mock.sqlStatements).toHaveLength(0);
  });

  it("flags future-recorded backdated operations and activations, never certifies them", () => {
    const gaps = summarizeFxWalletHistoryGaps({ lateActivations: "1", lateOperations: "3" });
    expect(gaps.map((g) => [g.code, g.records])).toEqual([
      ["HISTORICAL_FX_WALLET_BACKDATED_ACTIVATION", 1],
      ["HISTORICAL_FX_WALLET_BACKDATED_OPERATION", 3],
    ]);
    expect(summarizeFxWalletHistoryGaps({ lateActivations: "0", lateOperations: "0" })).toEqual([]);
    expect(() => summarizeFxWalletHistoryGaps({ lateActivations: null, lateOperations: "0" })).toThrow(
      "HISTORICAL_FX_WALLET_COVERAGE_INVALID"
    );
  });
});
