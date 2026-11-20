import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Company } from "../../client/src/contexts/CompanyContext";
import { ensureCompanyForNavigation } from "../../client/src/lib/ensureCompanyForNavigation";

function company(id: number, active = true): Company {
  return {
    id,
    code: `C${id}`,
    name: `Company ${id}`,
    companyType: "erp",
    active,
  };
}

describe("company-owned navigation", () => {
  const assigned = [company(1), company(2), company(3, false)];

  it("leaves the current authorized company alone without posting a new switch", async () => {
    const select = vi.fn(async () => true);
    expect(await ensureCompanyForNavigation(1, assigned[0], assigned, select)).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it("allows only assigned, active, positive target company IDs", async () => {
    const select = vi.fn(async () => true);
    for (const id of [null, undefined, 0, -2, 1.5, 9, 3]) {
      expect(await ensureCompanyForNavigation(id, assigned[0], assigned, select)).toBe(false);
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("waits for the central switch to resolve before permitting navigation", async () => {
    let resolveSwitch!: (accepted: boolean) => void;
    const select = vi.fn(() => new Promise<boolean>((resolve) => { resolveSwitch = resolve; }));
    const pending = ensureCompanyForNavigation(2, assigned[0], assigned, select);
    let finished = false;
    void pending.then(() => { finished = true; });

    await Promise.resolve();
    expect(finished).toBe(false);
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(assigned[1]);

    resolveSwitch(true);
    await expect(pending).resolves.toBe(true);
    expect(finished).toBe(true);
  });

  it("never navigates on server refusal or a thrown switch error", async () => {
    const rejected = vi.fn(async () => false);
    expect(await ensureCompanyForNavigation(2, assigned[0], assigned, rejected)).toBe(false);

    const throws = vi.fn(async (): Promise<boolean> => { throw new TypeError("network down"); });
    expect(await ensureCompanyForNavigation(2, assigned[0], assigned, throws)).toBe(false);
  });

  it("requires supplier and All Daybook links to await the same queue, with no independent POST", () => {
    const suppliers = readFileSync("client/src/pages/useSuppliersState.tsx", "utf8");
    const journal = readFileSync("client/src/pages/transactionjournal/useTransactionJournalModel.ts", "utf8");

    for (const src of [suppliers, journal]) {
      expect(src).toContain("ensureCompanyForNavigation");
      expect(src).not.toContain('"/api/auth/set-company"');
      expect(src).not.toContain("setTimeout(r, 300)");
    }
    expect(suppliers).toContain("const ready = await ensureCompanyForNavigation");
    expect(suppliers).toContain("if (!ready)");
    expect(suppliers).toContain("navigate(partyPath(companyId, path))");
    expect(journal).toContain("const ready = await ensureCompanyForNavigation");
    expect(journal).toContain("if (!ready) throw new Error");
    expect(journal).toContain("tab.location.replace(path)");
    expect(journal).toContain('storageKey: `erp-transaction-journal-filters-v3:${selectedCompany?.id ?? "pending"}`');
  });
});
