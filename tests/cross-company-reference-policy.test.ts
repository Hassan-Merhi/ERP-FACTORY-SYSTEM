import { describe, expect, it } from "vitest";
import routeAccessManifestJson from "../config/route-access-manifest.json";
import { RouteAccessResolver, type RouteAccessManifest } from "../server/security/access/routeAccessManifest";

const manifest = routeAccessManifestJson as unknown as RouteAccessManifest;
const resolver = new RouteAccessResolver(manifest);
const crossCompany = (method: string, path: string) => [...(resolver.resolve(method, path)?.crossCompany ?? [])];

describe("Wave 1 cross-company reference policy", () => {
  it("binds location and ledger-account reference reads to the active company", () => {
    expect(crossCompany("GET", "/api/locations")).toEqual([]);
    expect(crossCompany("GET", "/api/ledger-accounts")).toEqual([]);
    expect(crossCompany("POST", "/api/locations")).toEqual([]);
    expect(crossCompany("GET", "/api/vouchers")).toEqual([]);
  });

  it("keeps the payroll bonus reads on the server-authorized company set", () => {
    expect(crossCompany("GET", "/api/payroll/bonus-locations")).toEqual(["authorized-companies"]);
  });
});
