import { describe, expect, it } from "vitest";
import { securityRuntimeConfig } from "../server/securityRuntimeConfig.mjs";

describe("runtime Permissions-Policy for mobile barcode scanning", () => {
  it("allows camera use on the same HTTPS origin without granting microphone or location", () => {
    // The global runtime guard attaches these headers to every page, including
    // Factory > Stock Entry > Pressing Machines. camera=() prevents Android
    // Chrome from ever opening the scanner, even after the user grants access.
    expect(securityRuntimeConfig.responseHeaders["Permissions-Policy"]).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
  });
});
