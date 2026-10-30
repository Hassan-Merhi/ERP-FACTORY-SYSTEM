/**
 * The per-location WhatsApp stock report schedule, checked every minute. Each
 * schedule is evaluated in its own timezone, sends once per local day at or
 * after its time (catching up after a restart), honours selected weekdays,
 * claims the day before sending, re-checks that the schedule's author may
 * still send the report, and releases claims orphaned before delivery began.
 */
const deps = vi.hoisted(() => ({
  query: vi.fn(),
  deliver: vi.fn(),
  failure: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  pool: { query: (...args: unknown[]) => deps.query(...args) },
}));
vi.mock("../server/services/locationStockWhatsAppDelivery", () => ({
  deliverLocationStockWhatsApp: deps.deliver,
  recordLocationStockDeliveryFailure: deps.failure,
  recoverStaleLocationStockDeliveries: deps.recover,
}));

import { logger } from "../server/lib/logger";
import { checkAndRunLocationStockReports as check } from "../server/services/scheduler/location-stock-report";

type Row = Record<string, unknown>;
let schedules: Row[] = [];
let roles: Row[] = [];
let permissions: Row[] = [];
let claimWins = true;
let orphans = 0;
const updates: unknown[][] = [];

function schedule(overrides: Row = {}): Row {
  return {
    location_id: 10,
    company_id: 4,
    enabled: true,
    frequency: "daily",
    days_of_week: null,
    send_time: "18:00:00",
    timezone: "America/New_York",
    include_cost: false,
    include_zero_stock: false,
    include_negative_stock: true,
    stock_group_id: null,
    category_id: 3,
    last_scheduled_for: null,
    updated_by_user_id: "7",
    ...overrides,
  };
}

beforeEach(() => {
  schedules = [schedule()];
  roles = [{ active: true, company_id: 4, role: "Owner" }];
  permissions = [];
  claimWins = true;
  orphans = 0;
  updates.length = 0;
  deps.deliver.mockReset().mockResolvedValue({ status: "sent", error: null });
  deps.failure.mockReset();
  deps.recover.mockReset();
  deps.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("WITH orphaned")) return { rows: [], rowCount: orphans };
    if (sql.includes("SET last_scheduled_for = $2::date"))
      return { rows: claimWins ? [{ location_id: params[0] }] : [] };
    if (sql.includes("FROM location_whatsapp_stock_schedules s")) return { rows: schedules };
    if (sql.includes("FROM users u")) return { rows: roles };
    if (sql.includes("FROM role_feature_permissions")) return { rows: permissions };
    if (sql.includes("SET last_status = $2")) {
      updates.push(params);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
});

// 18:30 in New York on Wednesday 21 October 2026 (EDT).
const AT_1830 = new Date("2026-10-21T22:30:00Z");

describe("location stock report schedule", () => {
  it("claims the local day and sends the report with the schedule's options", async () => {
    await check(AT_1830);

    expect(deps.query).toHaveBeenCalledWith(expect.stringContaining("SET last_scheduled_for = $2::date"), [
      10,
      "2026-10-21",
    ]);
    expect(deps.deliver).toHaveBeenCalledWith({
      companyId: 4,
      locationId: 10,
      includeCost: false,
      includeZeroStock: false,
      includeNegativeStock: true,
      stockGroupId: undefined,
      categoryId: 3,
      source: "scheduled",
      initiatedByUserId: "7",
      scheduledFor: "2026-10-21",
      idempotencyKey: "scheduled:4:10:2026-10-21",
      reportDate: "2026-10-21",
    });
    expect(updates).toEqual([[10, "sent", null, true]]);
  });

  it("waits for the local send time, then catches up later the same day", async () => {
    await check(new Date("2026-10-21T21:59:00Z"));
    expect(deps.deliver).not.toHaveBeenCalled();

    await check(new Date("2026-10-22T02:00:00Z")); // 22:00 the same New York day
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("evaluates each schedule in its own timezone", async () => {
    schedules = [schedule({ timezone: "Asia/Tokyo", send_time: "07:00" })];

    await check(AT_1830); // 07:30 on 22 October in Tokyo

    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ scheduledFor: "2026-10-22" }));
  });

  it.each([
    ["already sent today (as a date)", { last_scheduled_for: new Date("2026-10-21T00:00:00Z") }],
    ["already sent today (as text)", { last_scheduled_for: "2026-10-21" }],
    ["not one of its weekdays", { frequency: "selected_days", days_of_week: [1, 5] }],
    ["in an invalid timezone", { timezone: "Mars/Olympus" }],
  ])("skips a schedule %s", async (_label, overrides) => {
    schedules = [schedule(overrides)];

    await check(AT_1830);

    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("sends on a selected weekday, with an unset send time defaulting to 18:00", async () => {
    schedules = [schedule({ frequency: "selected_days", days_of_week: ["3"], send_time: null })];

    await check(AT_1830);

    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when another process already claimed the day", async () => {
    claimWins = false;

    await check(AT_1830);

    expect(deps.deliver).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it.each([
    ["no author", { updated_by_user_id: null }, [{ active: true, company_id: 4, role: "Owner" }]],
    ["an inactive author", {}, [{ active: false, company_id: 4, role: "Owner" }]],
    ["a View Only author", {}, [{ active: true, company_id: 4, role: "View Only" }]],
    ["an author without a role in the company", {}, [{ active: true, company_id: 9, role: "Owner" }]],
  ])("records a failure instead of sending for %s", async (_label, overrides, authorRoles) => {
    schedules = [schedule(overrides)];
    roles = authorRoles;

    await check(AT_1830);

    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.failure).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "scheduled:4:10:2026-10-21" }),
      "Schedule owner no longer has permission to send this report"
    );
    expect(updates).toEqual([[10, "failed", "Schedule owner no longer has permission to send this report", false]]);
  });

  it("checks cost permissions for a report that includes costs", async () => {
    schedules = [schedule({ include_cost: true })];
    roles = [{ active: true, company_id: 4, role: "Normal User" }];
    permissions = [
      { feature_key: "exp_whatsapp_send", enabled: true },
      { feature_key: "fld_cost_price", enabled: true },
    ];

    await check(AT_1830);
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.query).toHaveBeenCalledWith(expect.stringContaining("FROM role_feature_permissions"), [
      4,
      "Normal User",
      ["exp_whatsapp_send", "fld_cost_price", "fld_total_value"],
    ]);

    permissions.push({ feature_key: "fld_total_value", enabled: true });
    await check(AT_1830);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("lets Owners send unless a permission is explicitly turned off, and Admins always", async () => {
    permissions = [{ feature_key: "exp_whatsapp_send", enabled: false }];
    await check(AT_1830);
    expect(deps.deliver).not.toHaveBeenCalled();

    roles = [{ active: true, company_id: 4, role: "Admin" }];
    deps.query.mockClear();
    await check(AT_1830);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    // Admins bypass the per-role permission table entirely.
    expect(deps.query.mock.calls.some(([sql]) => String(sql).includes("role_feature_permissions"))).toBe(false);
  });

  it("records a delivery that did not go out, and a crashed one", async () => {
    deps.deliver.mockResolvedValueOnce({ status: "failed", error: "x".repeat(1200) });
    await check(AT_1830);
    expect(updates[0]).toEqual([10, "failed", "x".repeat(1000), false]);

    deps.deliver.mockRejectedValueOnce(new Error("WhatsApp unreachable"));
    await check(AT_1830);
    expect(updates[1]).toEqual([10, "failed", "WhatsApp unreachable", false]);
    expect(logger.error).toHaveBeenCalledWith("[LocationStockSchedule] run failed", expect.anything());
  });

  it("recovers stale deliveries and orphaned claims before checking", async () => {
    orphans = 2;

    await check(AT_1830);

    expect(deps.recover).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("[LocationStockSchedule] recovered orphaned schedule claims", {
      count: 2,
    });
  });

  it("stays quiet while the schedule table does not exist yet, and logs other failures", async () => {
    deps.recover.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "42P01" }));
    await check(AT_1830);
    expect(logger.error).not.toHaveBeenCalled();

    deps.recover.mockRejectedValueOnce(new Error("db down"));
    await check(AT_1830);
    expect(logger.error).toHaveBeenCalledWith("[LocationStockSchedule] scheduler check failed", expect.anything());
  });
});
