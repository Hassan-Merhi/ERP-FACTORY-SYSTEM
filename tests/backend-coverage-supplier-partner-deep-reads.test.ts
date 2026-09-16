/**
 * Backend coverage — populated Supplier Partner read workflows.
 *
 * The broad company-mode sweep exercises the SP GET surface in an empty tenant.
 * This companion uses the canonical Golden Coast fixture so reports,
 * reconciliation, readiness, setup and migration readers execute against real
 * stock, role accounts, parent/intercompany links and ledger data. Every request
 * is read-only and a before/after financial fingerprint proves that remains true.
 */
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import {
  setupGoldenCoastPhase5Fixture,
  teardownGoldenCoastPhase5Fixture,
  type GoldenCoastPhase5Fixture,
} from "./helpers/goldenCoastPhase5Fixture";

type Manifest = { routes: string[] };
type Fingerprint = {
  voucherCount: string;
  entryCount: string;
  debitTotal: string;
  creditTotal: string;
  inventoryQty: string;
  inventoryValue: string;
  salesCount: string;
  movementCount: string;
};
type Failure = { route: string; status: number; detail: string };

const TEST_PREFIX = "covspdeep";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 30000;
const CONCURRENCY = 4;

const EXCLUDED: RegExp[] = [
  /(whatsapp|email|send-|tracking|carrier|openai|ai-)/i,
  /(export\.csv|export-v2|sales-form\/export)/i,
];

let fixture: GoldenCoastPhase5Fixture;
let routes: string[] = [];
let before: Fingerprint;

export function selectSupplierPartnerDeepReads(manifest: Manifest): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET" || !routePath?.startsWith("/api/sp/")) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED.some((pattern) => pattern.test(routePath))) continue;
    if (seen.has(routePath)) continue;
    seen.add(routePath);
    selected.push(routePath);
  }

  return selected;
}

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS "voucherCount",
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "entryCount",
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "debitTotal",
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "creditTotal",
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryQty",
       (SELECT COALESCE(SUM(total_value::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryValue",
       (SELECT COUNT(*)::text FROM sp_sales WHERE company_id = $1) AS "salesCount",
       (SELECT COUNT(*)::text FROM sp_stock_movements WHERE company_id = $1) AS "movementCount"`,
    [companyId]
  );
  return result.rows[0];
}

async function exercise(routePath: string): Promise<Failure | null> {
  try {
    const response = await fixture.agent
      .get(routePath)
      .set("x-client-date", "2026-09-05")
      .query({
        targetCompanyId: fixture.hadiCompanyId,
        companyId: fixture.ctx.companyId,
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        date: "2026-09-05",
        month: "2026-09",
      })
      .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });

    if (response.status >= 500 || response.status === 401) {
      const body = response.body as { message?: string; error?: string } | undefined;
      return {
        route: routePath,
        status: response.status,
        detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
      };
    }
    return null;
  } catch (error) {
    const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
    return {
      route: routePath,
      status: timedOut ? 598 : 599,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

beforeAll(async () => {
  fixture = await setupGoldenCoastPhase5Fixture(TEST_PREFIX);
  routes = selectSupplierPartnerDeepReads(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
  before = await fingerprint(fixture.ctx.companyId);
}, 120000);

afterAll(async () => {
  if (fixture) await teardownGoldenCoastPhase5Fixture(fixture);
}, 120000);

describe("populated Supplier Partner read coverage", () => {
  it("executes the real-data SP read surface without unhandled errors", async () => {
    expect(routes.length).toBeGreaterThan(25);
    const failures: Failure[] = [];

    for (let offset = 0; offset < routes.length; offset += CONCURRENCY) {
      const outcomes = await Promise.all(routes.slice(offset, offset + CONCURRENCY).map(exercise));
      failures.push(...outcomes.filter((outcome): outcome is Failure => outcome !== null));
    }

    const report = failures
      .map((failure) => `  ${failure.status} GET ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} Supplier Partner read(s) failed:\n${report}`).toEqual([]);
  }, 300000);

  it("keeps SP accounting, inventory and operational rows read-only", async () => {
    expect(await fingerprint(fixture.ctx.companyId)).toEqual(before);
  });
});
