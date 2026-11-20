/**
 * Write-route input validation gate.
 *
 * scripts/audit-write-validation.mjs counts routes whose chain has
 * validateRequest. This suite checks what that count cannot see from the
 * manifest's function names alone, on the live Express stack:
 *   - a route with path parameters validates `params`,
 *   - a POST/PUT/PATCH validates `body`,
 *   - validateRequest runs after the authentication and permission guards, so
 *     an unauthenticated caller still gets 401/403 and never sees schema
 *     details.
 * It also pins the audit's counting rules on small synthetic manifests.
 */
import express from "express";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { isProtectedAccountingRequest } from "../client/src/lib/accountingRequestIdentity";
import { VALIDATED_LOCATIONS, VALIDATED_SCHEMAS, type RequestSchemas } from "../server/lib/validateRequest";
import { isPhase5OperationalVoucherRequest } from "../shared/voucherPathIdentityPolicy";
import { registerRoutes } from "../server/routes";
import { auditWriteValidation, parseManifestEntry } from "../scripts/audit-write-validation.mjs";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const WRITE_METHODS = new Set([...BODY_METHODS, "DELETE"]);

interface Handler {
  name?: string;
  method?: string;
  handle?: { name?: string } & Record<PropertyKey, unknown>;
}
interface Layer {
  route?: { path?: unknown; methods?: Record<string, boolean>; stack?: Handler[] };
}

interface ValidatedRoute {
  key: string;
  path: string;
  method: string;
  chain: string[];
  locations: string[];
  schemas: RequestSchemas;
}

function nameOf(handler: Handler): string {
  const name = handler.name || handler.handle?.name || "<anonymous>";
  return name.startsWith("bound ") ? name.slice(6) : name;
}

async function liveValidatedRoutes(): Promise<ValidatedRoute[]> {
  const app = express();
  app.set("case sensitive routing", true);
  const server = await registerRoutes(app);
  server.close();
  const stack = ((app as unknown as { router?: { stack?: Layer[] } }).router?.stack ?? []) as Layer[];

  const out: ValidatedRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const paths = (Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]).filter(
      (path): path is string => typeof path === "string"
    );
    const methods = Object.keys(layer.route.methods ?? {}).map((method) => method.toUpperCase());
    for (const path of paths) {
      for (const method of methods) {
        if (!WRITE_METHODS.has(method)) continue;
        const handlers = (layer.route.stack ?? []).filter(
          (handler) => handler.method === undefined || handler.method.toUpperCase() === method
        );
        const validator = handlers.find((handler) => handler.handle?.[VALIDATED_LOCATIONS]);
        if (!validator) continue;
        out.push({
          key: `${method} ${path}`,
          path,
          method,
          chain: handlers.map(nameOf),
          locations: validator.handle?.[VALIDATED_LOCATIONS] as string[],
          schemas: validator.handle?.[VALIDATED_SCHEMAS] as RequestSchemas,
        });
      }
    }
  }
  return out;
}

/** An unknown-key refusal of clientRequestId at the body root, also inside a union branch. */
function refusesRetryIdentity(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some((issue) => {
    if (issue.code === "unrecognized_keys") return issue.path.length === 0 && issue.keys.includes("clientRequestId");
    if (issue.code === "invalid_union") return issue.errors.some((branch) => refusesRetryIdentity(branch));
    return false;
  });
}

describe("validated write routes on the live stack", () => {
  let routes: ValidatedRoute[];
  beforeAll(async () => {
    routes = await liveValidatedRoutes();
  }, 120_000);

  it("validate params on every route with path parameters", () => {
    const missing = routes.filter((route) => /[:*]/.test(route.path) && !route.locations.includes("params"));
    expect(missing.map((route) => route.key)).toEqual([]);
  });

  it("validate the body on every POST, PUT and PATCH", () => {
    const missing = routes.filter((route) => BODY_METHODS.has(route.method) && !route.locations.includes("body"));
    expect(missing.map((route) => route.key)).toEqual([]);
  });

  it("run validateRequest after every require* guard", () => {
    const misplaced = routes.filter((route) => {
      const at = route.chain.indexOf("validateRequest");
      return route.chain.slice(at + 1).some((name) => /^require[A-Z]/.test(name));
    });
    expect(misplaced.map((route) => `${route.key} [${route.chain.join(" > ")}]`)).toEqual([]);
  });

  // client/src/lib/accountingRequestFetchGuard.ts adds a clientRequestId to
  // every JSON write that these browser policies protect, so the server-side
  // retry identity survives a retransmit. A strict body schema without that
  // field would refuse every such request from the app.
  it("accept the clientRequestId the browser adds to protected accounting writes", () => {
    // Bodies that switch on the data-dependent policies (payment/receipt
    // vouchers, generic vouchers, payroll run payment).
    const probes: Record<string, unknown>[] = [{}, { voucherType: "Payment" }, { voucher: {} }, { action: "pay" }];
    const refused = routes.filter((route) => {
      const body = route.schemas.body as z.ZodType | undefined;
      if (!body) return false;
      const concretePath = route.path.replace(/:[A-Za-z0-9_]+/g, "1");
      const stamped =
        isPhase5OperationalVoucherRequest(route.method, concretePath) ||
        probes.some((probe) => isProtectedAccountingRequest(route.method, concretePath, probe));
      if (!stamped) return false;
      const result = body.safeParse({ clientRequestId: "retry-identity" });
      return !result.success && refusesRetryIdentity(result.error.issues);
    });
    expect(refused.map((route) => route.key)).toEqual([]);
  });

  it("never mount validateRequest as the terminal handler", () => {
    const terminal = routes.filter((route) => route.chain[route.chain.length - 1] === "validateRequest");
    expect(terminal.map((route) => route.key)).toEqual([]);
  });
});

describe("audit-write-validation counting rules", () => {
  const config = {
    tiers: [
      { name: "1-vouchers", prefixes: ["/api/vouchers"] },
      { name: "7-other", prefixes: ["/"] },
    ],
  };

  it("parses manifest entries, including hyphenated methods and empty chains", () => {
    expect(parseManifestEntry("POST /api/x/:id [requireAuth > validateRequest > <anonymous>]")).toEqual({
      method: "POST",
      path: "/api/x/:id",
      guards: ["requireAuth", "validateRequest", "<anonymous>"],
    });
    expect(parseManifestEntry("M-SEARCH /api/y []").method).toBe("M-SEARCH");
    expect(() => parseManifestEntry("nonsense")).toThrow(/Unrecognised/);
  });

  it("counts write routes once per method and path, ignoring reads", () => {
    const result = auditWriteValidation({
      config,
      manifest: {
        routes: [
          "GET /api/vouchers [requireAuth > <anonymous>]",
          "POST /api/vouchers [requireAuth > <anonymous>]",
          "POST /api/vouchers [requireAuth > <anonymous>]",
          "DELETE /api/vouchers/:id [requireAuth > validateRequest > <anonymous>]",
          "PATCH /api/things/:id [requireAuth > <anonymous>]",
        ],
      },
    });
    expect(result.totalWriteRoutes).toBe(3);
    expect(result.validated).toBe(1);
    expect(result.unvalidated).toBe(2);
    expect(result.tiers).toEqual([
      { name: "1-vouchers", total: 2, unvalidated: ["POST /api/vouchers"] },
      { name: "7-other", total: 1, unvalidated: ["PATCH /api/things/:id"] },
    ]);
  });

  it("treats a layered route as validated when any registration validates", () => {
    const result = auditWriteValidation({
      config,
      manifest: {
        routes: [
          "PATCH /api/vouchers/:id [requireAuth > permissionLayer]",
          "PATCH /api/vouchers/:id [requireAuth > validateRequest > <anonymous>]",
        ],
      },
    });
    expect(result.unvalidated).toBe(0);
  });

  it("does not count a handler that merely mentions validation in its name", () => {
    const result = auditWriteValidation({
      config,
      manifest: { routes: ["POST /api/vouchers [requireAuth > validateVoucherBody > <anonymous>]"] },
    });
    expect(result.unvalidated).toBe(1);
  });

  it("finds no unvalidated write route in the committed manifest", () => {
    const result = auditWriteValidation();
    expect(result.tiers.flatMap((tier) => tier.unvalidated)).toEqual([]);
    expect(result.validated).toBe(result.totalWriteRoutes);
  });
});
