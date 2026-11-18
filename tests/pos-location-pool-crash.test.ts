import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { columnDefinition, indexDefinition } from "./helpers/schemaManifest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("POS location database-pool crash protection", () => {
  it("contains POS authorization database failures inside Express", () => {
    const auth = source("server/auth.ts");
    const middleware = auth.slice(
      auth.indexOf("export async function checkPOSLocation"),
      auth.indexOf("export async function requirePasswordConfirmation")
    );

    expect(middleware).toContain("try {");
    expect(middleware).toContain("eq(userLocations.locationId, locationId)");
    expect(middleware).toContain(".limit(1)");
    expect(middleware).toContain("return next(error)");
    expect(middleware).not.toContain("assignedLocations.map");
  });

  it("serializes cold-cache net-profit calculations", () => {
    const guard = source("server/runtimeMemoryGuard.mjs");

    expect(guard).toContain('{ test: (path) => path === "/api/stats/net-profit", max: 1, name: "stats-net-profit" }');
  });

  it("keeps schema and production SQL aligned", () => {
    const usersSchema = source("shared/schema/users.ts");

    expect(usersSchema).toContain("user_locations_user_company_location_idx");
    expect(indexDefinition("user_locations_user_company_location_idx")).toContain(
      "ON public.user_locations USING btree (user_id, company_id, location_id)"
    );
    expect(columnDefinition("voucher_entries", "base_debit_amount")?.type).toBe("numeric(20,6)");
    expect(columnDefinition("voucher_entries", "base_credit_amount")?.type).toBe("numeric(20,6)");
  });

  it("does not prefetch general ERP reference data for POS sessions", () => {
    const context = source("client/src/contexts/CompanyContext.tsx");

    // POS sessions must never prefetch heavy ERP reference data. The role is
    // threaded through every prefetch path so the `role === "POS"` early-return
    // guard always applies, including the initial company-restore path.
    expect(context).toContain('if (role === "POS") return;');
    expect(context).toContain("role: assignment.role");
    expect(context).toContain("prefetchReferenceData(company.id, company.role)");
    expect(context).toContain("adoptServerCompany(target)");
    expect(context).toContain("commitCompanySelection(company, { prefetch: true, serverSynced: true })");
  });

  it("does not mount the hidden ERP command palette for ordinary POS users", () => {
    const shell = source("client/src/app/PosShell.tsx");

    expect(shell).toContain(
      "<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isPOS={true} user={user} />"
    );
  });
});
