import { describe, expect, it } from "vitest";
import routeAccessManifestJson from "../config/route-access-manifest.json";
import { RouteAccessResolver, type RouteAccessManifest } from "../server/security/access/routeAccessManifest";

const resolver = new RouteAccessResolver(routeAccessManifestJson as unknown as RouteAccessManifest);
const allowsReferenceRead = (method: string, path: string) =>
  resolver.resolve(method, path)?.crossCompany.has("reference-read") ?? false;

describe("Wave 1 cross-company reference policy", () => {
  it("allows only GET reference reads for locations and ledger accounts", () => {
    expect(allowsReferenceRead("GET", "/api/locations")).toBe(true);
    expect(allowsReferenceRead("GET", "/api/ledger-accounts")).toBe(true);

    expect(allowsReferenceRead("POST", "/api/locations")).toBe(false);
    expect(allowsReferenceRead("PUT", "/api/ledger-accounts")).toBe(false);
    expect(allowsReferenceRead("GET", "/api/vouchers")).toBe(false);
    expect(allowsReferenceRead("GET", "/api/payroll/bonus-locations")).toBe(false);
  });
});
