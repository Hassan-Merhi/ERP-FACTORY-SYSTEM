import { describe, expect, it } from "vitest";
import {
  guardCompanySelectionWrites,
  keepNewerCompanySelection,
} from "../server/services/security/sessionCompanyWriteGuard";

const switched = {
  userId: "user-1",
  currentCompanyId: 31,
  currentCompanyName: "Factory",
  currentRole: "Admin",
  factoryCompanyId: 31,
  companyRevision: "rev-2",
  companySelectedAt: 2_000,
  lastSeenAt: 100,
};

/** What a request that loaded the session before the switch would save. */
function staleWrite(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    currentCompanyId: 30,
    currentCompanyName: "ERP",
    currentRole: "POS",
    companyRevision: "rev-1",
    lastSeenAt: 999,
    ...overrides,
  } as Record<string, unknown>;
}

describe("session company write guard", () => {
  it("keeps the newer company selection and the write's other fields", () => {
    const incoming = staleWrite();
    expect(keepNewerCompanySelection(incoming, switched)).toBe(true);
    expect(incoming).toMatchObject({
      currentCompanyId: 31,
      currentCompanyName: "Factory",
      currentRole: "Admin",
      factoryCompanyId: 31,
      companyRevision: "rev-2",
      companySelectedAt: 2_000,
      lastSeenAt: 999,
    });
  });

  it("drops selection fields the newer selection does not have", () => {
    const incoming = staleWrite({ factoryCompanyId: 30 });
    const { factoryCompanyId: _removed, ...erpSelection } = switched;
    keepNewerCompanySelection(incoming, erpSelection);
    expect("factoryCompanyId" in incoming).toBe(false);
  });

  it("lets the switch itself and later writes through unchanged", () => {
    const theSwitch = { ...switched, currentCompanyId: 32, companySelectedAt: 3_000 };
    expect(keepNewerCompanySelection(theSwitch, switched)).toBe(false);
    expect(theSwitch.currentCompanyId).toBe(32);

    const later = { ...switched, lastSeenAt: 5_000 };
    expect(keepNewerCompanySelection(later, switched)).toBe(false);
    expect(keepNewerCompanySelection(staleWrite(), null)).toBe(false);
    expect(keepNewerCompanySelection(staleWrite(), staleWrite())).toBe(false);
  });

  it("never moves a selection between users", () => {
    const incoming = staleWrite({ userId: "user-2" });
    expect(keepNewerCompanySelection(incoming, switched)).toBe(false);
    expect(incoming.currentCompanyId).toBe(30);
  });

  it("guards every store write and still saves when the read fails", () => {
    const saved: Record<string, unknown>[] = [];
    let stored: Record<string, unknown> | null = switched;
    let readError: unknown = null;
    const store = {
      get: (_sid: string, callback: (error: unknown, session?: unknown) => void) => callback(readError, stored),
      set: (_sid: string, session: never, callback?: (error?: unknown) => void) => {
        saved.push(session as Record<string, unknown>);
        callback?.();
      },
    };
    guardCompanySelectionWrites(store);

    store.set("sid", staleWrite() as never);
    expect(saved[0].currentCompanyId).toBe(31);

    readError = new Error("database unavailable");
    stored = null;
    store.set("sid", staleWrite() as never);
    expect(saved[1].currentCompanyId).toBe(30);
  });
});
