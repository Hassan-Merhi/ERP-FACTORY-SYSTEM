import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { companyQueryKey } from "../client/src/lib/companyQueryScope";

describe("Factory Phase 2 transporter company isolation", () => {
  const code = readFileSync(
    resolve(process.cwd(), "client/src/pages/factory/FactoryTransporters.tsx"), "utf8",
  );

  it("scopes transporter list and statements without changing the endpoint", () => {
    expect(code).toContain("companyQueryKey(API, selectedCompany?.id)");
    expect(code).toContain("companyQueryKey(API, selectedCompany?.id, transporterId)");
    expect(companyQueryKey("/api/factory/transporters", 100)[0]).toBe("/api/factory/transporters");
    expect(companyQueryKey("/api/factory/transporters", 100)).not.toEqual(
      companyQueryKey("/api/factory/transporters", 200),
    );
  });

  it("scopes the account picker in charge and payment dialogs", () => {
    expect(code.match(/companyQueryKey\("\/api\/factory\/transporter-accounts", selectedCompany\?\.id\)/g)?.length).toBe(2);
    expect(code).toContain("enabled: open && Boolean(selectedCompany?.id)");
  });

  it("clears the selected transporter after changing company", () => {
    expect(code).toContain("setSelectedId(null)");
    expect(code).toContain("}, [selectedCompany?.id]);");
  });
});
