/**
 * The import-cycle diagnostics total their impacts exactly: two vouchers out
 * by 0.10 and 0.20 are out by 0.30 in all (the float sum was
 * 0.30000000000000004).
 */
import { describe, expect, it, vi } from "vitest";

const results: unknown[][] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => {
  const chain = (): Record<string, unknown> => {
    const value = results.shift() ?? [];
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "leftJoin", "innerJoin", "groupBy", "having", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => chain() } };
});

import { registerImportCycleDiagnosticRoutes } from "../server/routes/import-cycle/diagnostics";

describe("import-cycle diagnostics", () => {
  it("sums voucher imbalances exactly", async () => {
    results.push(
      [], // orphaned inventory
      [], // negative inventory
      [], // stale containers
      [
        { voucherId: 1, voucherNumber: "JV-1", voucherType: "Journal", totalDebits: "1.10", totalCredits: "1.00" },
        { voucherId: 2, voucherNumber: "JV-2", voucherType: "Journal", totalDebits: "0.20", totalCredits: "0.00" },
      ],
      [], // ledger accounts
      [], // employees
      [] // loans accounts
    );
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerImportCycleDiagnosticRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: { issues: Array<{ id: string; impact: number; description: string }>; summary: { totalImpact: number } } =
      { issues: [], summary: { totalImpact: 0 } };
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler({ session: { currentCompanyId: 7 } }, res);

    const unbalanced = body.issues.find((issue) => issue.id === "unbalanced-vouchers");
    expect(unbalanced?.impact).toBe(0.3);
    expect(unbalanced?.description).toContain("JV-1 (Journal): DR 1.10 - CR 1.00 = 0.10");
    expect(body.summary.totalImpact).toBe(0.3);
  });
});
