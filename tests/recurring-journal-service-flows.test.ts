/**
 * Recurring journals beyond the posting happy path: date and timezone
 * validation, turning a journal into a template (and every refusal), the
 * settings update, lookups and history, the run's early exits and failure
 * handling, and the scheduler pass. The database is a queue of results and
 * the posting engine, scope and audit log are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { op: string; method: string; args: unknown[] };
const h = vi.hoisted(() => ({
  results: [] as unknown[],
  calls: [] as Call[],
  closedThrough: vi.fn(),
  inClosed: vi.fn(),
  post: vi.fn(),
  build: vi.fn(),
  employee: vi.fn(),
  audit: vi.fn(),
  closedError: vi.fn(),
}));

vi.mock("../server/db", () => {
  const chain = (op: string) => {
    const target: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(target, {
      get(_t, method: string) {
        if (method === "catch") {
          const value = h.results.shift();
          return (onRejected: (e: unknown) => unknown) =>
            Promise.resolve(value instanceof Error ? onRejected(value) : value);
        }
        if (method === "then") {
          const value = h.results.shift();
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            value instanceof Error ? reject(value) : resolve(value);
        }
        return (...args: unknown[]) => {
          h.calls.push({ op, method, args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db = {
    select: (...args: unknown[]) => (h.calls.push({ op: "select", method: "select", args }), chain("select")),
    update: () => chain("update"),
    insert: () => chain("insert"),
    transaction: async (work: (tx: unknown) => unknown) => work(db),
  };
  return { db };
});
vi.mock("../server/services/accounting/scheduledPostingScope", () => ({
  runInCompanyPostingScope: (_companyId: number, work: () => unknown) => work(),
  companyClosedThrough: (...a: unknown[]) => h.closedThrough(...a),
  isDateInClosedPeriod: (...a: unknown[]) => h.inClosed(...a),
}));
vi.mock("../server/services/accounting/centralPostingEngine", () => ({
  postBalancedVoucherTx: (...a: unknown[]) => h.post(...a),
}));
vi.mock("../server/services/accounting/manualJournalPosting", () => ({
  buildManualJournalPostingRequest: (...a: unknown[]) => h.build(...a),
}));
vi.mock("../server/services/accounting/employeeBalancePosting", () => ({
  applyEmployeeBalanceDeltasTx: (...a: unknown[]) => h.employee(...a),
}));
vi.mock("../server/services/accounting/databasePostingDependencies", () => ({
  createDatabasePostingDependencies: () => ({}),
}));
vi.mock("../server/services/audit", () => ({ writeAuditEvent: (...a: unknown[]) => h.audit(...a) }));
vi.mock("../server/lib/closedPeriodError", () => ({ isClosedPeriodError: (e: unknown) => h.closedError(e) }));

import {
  getRecurringJournalForSource,
  getRecurringJournalHistory,
  isValidRecurringTimeZone,
  listRecurringJournals,
  localIsoDate,
  monthEndIso,
  RecurringJournalError,
  renderRecurringDescription,
  deriveRecurringDescriptionTemplate,
  runDueRecurringJournals,
  runRecurringJournal,
  updateRecurringJournal,
  upsertRecurringJournalFromVoucher,
  upsertRecurringJournalFromVoucherNumber,
} from "../server/services/accounting/recurringJournalService";

type Row = Record<string, unknown>;
const sets = (op = "update") => h.calls.filter((c) => c.op === op && c.method === "set").map((c) => c.args[0] as Row);
const values = () => h.calls.filter((c) => c.op === "insert" && c.method === "values").map((c) => c.args[0] as Row);

const voucher = (over: Row = {}): Row => ({
  id: 40,
  companyId: 3,
  voucherNumber: "JV-40",
  voucherType: "Journal",
  voucherDate: "2026-09-30",
  description: "Rent September 2026",
  currency: "EUR",
  exchangeRate: "0.9",
  optional: false,
  deletedAt: null,
  ...over,
});
const entry = (over: Row = {}): Row => ({
  id: 1,
  ledgerAccountId: null,
  bankAccountId: null,
  supplierId: null,
  factorySupplierId: null,
  employeeId: null,
  fixedAssetId: null,
  customerId: null,
  transactionDebitAmount: null,
  transactionCreditAmount: null,
  baseDebitAmount: null,
  baseCreditAmount: null,
  debitAmount: "0",
  creditAmount: "0",
  narration: null,
  ...over,
});
const balanced = () => [
  entry({ id: 1, ledgerAccountId: 7, transactionDebitAmount: "100", narration: "Rent" }),
  entry({ id: 2, bankAccountId: 8, creditAmount: "100" }),
];

async function recurringError(work: Promise<unknown>) {
  const error = await work.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RecurringJournalError);
  const e = error as RecurringJournalError;
  return [e.code, e.message, e.status];
}

beforeEach(() => {
  h.results = [];
  h.calls = [];
  h.closedThrough.mockReset().mockResolvedValue(null);
  h.inClosed.mockReset().mockReturnValue(false);
  h.post.mockReset();
  h.build.mockReset().mockReturnValue({ request: {} });
  h.employee.mockReset();
  h.audit.mockReset();
  h.closedError.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("date helpers", () => {
  it("validates timezones and formats local dates and month ends", () => {
    expect(isValidRecurringTimeZone("Africa/Lusaka")).toBe(true);
    expect(isValidRecurringTimeZone("Mars/Base")).toBe(false);
    expect(localIsoDate("Asia/Beirut", new Date("2026-10-30T22:30:00Z"))).toBe("2026-10-31");
    expect(monthEndIso(2028, 2)).toBe("2028-02-29");
  });

  it("templates short month names, falls back for empty text and renders every placeholder", () => {
    expect(deriveRecurringDescriptionTemplate("Rent sep 2026", "2026-09-30")).toBe("Rent {{month_short}} {{year}}");
    expect(deriveRecurringDescriptionTemplate("Rent for the office", "2026-09-30")).toBe("Rent for the office");
    expect(deriveRecurringDescriptionTemplate("  ", "2026-09-30")).toBe("Recurring journal — {{month}} {{year}}");
    expect(deriveRecurringDescriptionTemplate(null, "2026-09-30")).toBe("Recurring journal — {{month}} {{year}}");
    expect(renderRecurringDescription("{{month_short}} {{yyyy_mm}} {{date}} {{month}}", "2027-02-28")).toBe(
      "Feb 2027-02 2027-02-28 February"
    );
    expect(renderRecurringDescription(null, "2027-02-28")).toBe("Recurring journal — February 2027");
  });

  it("rejects malformed and impossible dates", () => {
    for (const date of ["2026-9-30", "2026-02-30", "not a date"]) {
      expect(() => renderRecurringDescription("x", date)).toThrow(`Invalid date: ${date}`);
    }
  });
});

describe("upsertRecurringJournalFromVoucher", () => {
  const upsert = (over: Row = {}) =>
    upsertRecurringJournalFromVoucher({ companyId: 3, sourceVoucherId: 40, userId: "u1", ...over } as never);

  it("creates a monthly month-end template from a posted balanced journal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    h.results = [[voucher()], balanced(), [], [{ id: 90 }]];
    expect(await upsert({ timezone: " Africa/Lusaka ", endDate: "2027-12-31" })).toEqual({ id: 90 });
    expect(values()).toEqual([
      {
        companyId: 3,
        sourceVoucherId: 40,
        name: "Rent September 2026",
        descriptionTemplate: "Rent {{month}} {{year}}",
        frequency: "monthly",
        scheduleRule: "month_end",
        timezone: "Africa/Lusaka",
        currency: "EUR",
        exchangeRate: "0.9",
        entryTemplate: [
          { type: "DR", accountType: "ledger", accountId: 7, amount: "100", narration: "Rent" },
          { type: "CR", accountType: "bank", accountId: 8, amount: "100", narration: null },
        ],
        active: true,
        startDate: "2026-09-30",
        endDate: "2027-12-31",
        nextRunDate: "2026-10-31",
        createdByUserId: "u1",
      },
    ]);
  });

  it("updates an existing template and honours an explicit description", async () => {
    h.results = [
      [voucher({ description: null, currency: null })],
      balanced(),
      [{ id: 90 }],
      [{ id: 90, updated: true }],
    ];
    expect(await upsert({ descriptionTemplate: "  ", endDate: "" })).toEqual({ id: 90, updated: true });
    expect(sets()[0]).toMatchObject({
      name: "Recurring JV-40",
      descriptionTemplate: null,
      timezone: "UTC",
      currency: "USD",
      endDate: null,
    });
    expect(values()).toEqual([]);
  });

  it("refuses an end date before the first run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    h.results = [[voucher()], balanced(), []];
    expect(await recurringError(upsert({ endDate: "2026-10-30" }))).toEqual([
      "RECURRING_END_BEFORE_NEXT_RUN",
      "End date must be on or after the next run date (2026-10-31)",
      400,
    ]);
  });

  it("validates settings before reading the voucher", async () => {
    expect(await recurringError(upsert({ timezone: "Nowhere/Zone" }))).toEqual([
      "RECURRING_TIMEZONE_INVALID",
      "Invalid timezone: Nowhere/Zone",
      400,
    ]);
    expect((await recurringError(upsert({ endDate: "2026-13-01" })))[0]).toBe("RECURRING_DATE_INVALID");
    expect(h.calls).toEqual([]);
  });

  it("only accepts live posted journals", async () => {
    const cases: Array<[Row[], string, number]> = [
      [[], "RECURRING_SOURCE_NOT_FOUND", 404],
      [[voucher({ deletedAt: new Date() })], "RECURRING_SOURCE_NOT_FOUND", 404],
      [[voucher({ voucherType: "Payment" })], "RECURRING_SOURCE_NOT_JOURNAL", 400],
      [[voucher({ optional: true })], "RECURRING_SOURCE_DRAFT", 400],
    ];
    for (const [rows, code, status] of cases) {
      h.results = [rows];
      const [actual, , actualStatus] = await recurringError(upsert());
      expect([actual, actualStatus]).toEqual([code, status]);
    }
  });

  it("refuses entries that cannot become a balanced template", async () => {
    const cases: Array<[Row[], string, string]> = [
      [[entry({ ledgerAccountId: 7, debitAmount: "5" })], "RECURRING_SOURCE_ENTRIES_INVALID", ""],
      [
        [entry({ ledgerAccountId: 7, bankAccountId: 8, debitAmount: "5" }), entry({ id: 2 })],
        "RECURRING_ENTRY_TARGET_UNSUPPORTED",
        "Voucher entry 1 must reference exactly one accounting target to become recurring",
      ],
      [[entry({ debitAmount: "5" }), entry({ id: 2 })], "RECURRING_ENTRY_TARGET_UNSUPPORTED", ""],
      [
        [entry({ customerId: 4, debitAmount: "5", creditAmount: "5" }), entry({ id: 2, employeeId: 6 })],
        "RECURRING_ENTRY_SIDE_INVALID",
        "Voucher entry 1 must contain exactly one debit or credit amount",
      ],
      [
        [entry({ supplierId: 4 }), entry({ id: 2, employeeId: 6, creditAmount: "5" })],
        "RECURRING_ENTRY_SIDE_INVALID",
        "",
      ],
      [
        [entry({ factorySupplierId: 4, debitAmount: "5" }), entry({ id: 2, fixedAssetId: 6, creditAmount: "6" })],
        "RECURRING_SOURCE_UNBALANCED",
        "Source journal must be balanced before it can recur",
      ],
    ];
    for (const [entries, code, message] of cases) {
      h.results = [[voucher()], entries];
      const [actual, actualMessage] = await recurringError(upsert());
      expect(actual).toBe(code);
      if (message) expect(actualMessage).toBe(message);
    }
  });

  it("reads each side from the first persisted amount that is set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    h.results = [
      [voucher()],
      [
        entry({ ledgerAccountId: 7, baseDebitAmount: "25", debitAmount: "24" }),
        entry({ id: 2, customerId: 9, creditAmount: "25" }),
      ],
      [],
      [{ id: 91 }],
    ];
    await upsert();
    expect((values()[0].entryTemplate as Row[]).map((e) => [e.type, e.accountType, e.amount])).toEqual([
      ["DR", "ledger", "25"],
      ["CR", "customer", "25"],
    ]);
  });
});

describe("upsertRecurringJournalFromVoucherNumber", () => {
  it("requires a number that exists in the company, then upserts that voucher", async () => {
    expect(
      await recurringError(upsertRecurringJournalFromVoucherNumber({ companyId: 3, userId: null, voucherNumber: " " }))
    ).toEqual(["RECURRING_SOURCE_NUMBER_REQUIRED", "Journal voucher number is required", 400]);
    h.results = [[]];
    expect(
      await recurringError(
        upsertRecurringJournalFromVoucherNumber({ companyId: 3, userId: null, voucherNumber: "JV-9" })
      )
    ).toEqual(["RECURRING_SOURCE_NOT_FOUND", "Journal voucher JV-9 was not found in the selected company", 404]);

    h.results = [[{ id: 40 }], [voucher()], balanced(), [{ id: 90 }], [{ id: 90 }]];
    expect(
      await upsertRecurringJournalFromVoucherNumber({
        companyId: 3,
        userId: null,
        voucherNumber: " JV-40 ",
        descriptionTemplate: "Rent {{month}}",
      })
    ).toEqual({ id: 90 });
    expect(sets()[0]).toMatchObject({ descriptionTemplate: "Rent {{month}}" });
  });
});

describe("updateRecurringJournal", () => {
  const existing = (over: Row = {}): Row => ({
    id: 90,
    companyId: 3,
    active: true,
    timezone: "UTC",
    endDate: null,
    descriptionTemplate: "Rent {{month}}",
    nextRunDate: "2026-10-31",
    lastRunDate: null,
    startDate: "2026-09-30",
    lastError: "previous failure",
    ...over,
  });

  it("refuses an unknown recurrence", async () => {
    h.results = [[]];
    expect(await recurringError(updateRecurringJournal(3, 90, {}))).toEqual([
      "RECURRING_NOT_FOUND",
      "Recurring journal not found",
      404,
    ]);
  });

  it("keeps unchanged settings and clears the error while active", async () => {
    h.results = [[existing({ nextRunDate: "2027-01-31" })], [{ id: 90 }]];
    expect(await updateRecurringJournal(3, 90, {})).toEqual({ id: 90 });
    expect(sets()[0]).toMatchObject({
      active: true,
      timezone: "UTC",
      endDate: null,
      descriptionTemplate: "Rent {{month}}",
      // An active recurrence keeps its stored schedule.
      nextRunDate: "2027-01-31",
      lastError: null,
    });
  });

  it("pauses without touching the schedule and keeps the last error", async () => {
    h.results = [[existing()], [{ id: 90 }]];
    await updateRecurringJournal(3, 90, { active: false, endDate: "2026-01-31", descriptionTemplate: " New " });
    expect(sets()[0]).toMatchObject({
      active: false,
      endDate: "2026-01-31",
      descriptionTemplate: "New",
      nextRunDate: "2026-10-31",
      lastError: "previous failure",
    });
  });

  it("resumes from the last run and checks the end date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-10T12:00:00Z"));
    h.results = [[existing({ active: false, lastRunDate: "2026-11-30" })], [{ id: 90 }]];
    await updateRecurringJournal(3, 90, { active: true, timezone: "Asia/Beirut", descriptionTemplate: null });
    expect(sets()[0]).toMatchObject({
      active: true,
      timezone: "Asia/Beirut",
      nextRunDate: "2027-03-31",
      descriptionTemplate: null,
    });

    h.calls = [];
    h.results = [[existing({ active: false })]];
    expect(await recurringError(updateRecurringJournal(3, 90, { active: true, endDate: "2027-03-30" }))).toEqual([
      "RECURRING_END_BEFORE_NEXT_RUN",
      "End date must be on or after the next run date (2027-03-31)",
      400,
    ]);
    h.results = [[existing()]];
    expect(await recurringError(updateRecurringJournal(3, 90, { timezone: "Bad/Zone" }))).toEqual([
      "RECURRING_TIMEZONE_INVALID",
      "Invalid timezone: Bad/Zone",
      400,
    ]);
  });
});

describe("lookups", () => {
  it("returns a source's recurrence with its own history only", async () => {
    h.results = [[]];
    expect(await getRecurringJournalForSource(3, 40)).toEqual({ recurring: null, history: [] });

    const rows = [
      { sourceId: "90:2026-10-31", id: 1, voucherNumber: "JV-1" },
      { sourceId: "901:2026-10-31", id: 2, voucherNumber: "JV-2" },
      { sourceId: "90:2026-11-30", id: 3, voucherNumber: "JV-3" },
    ];
    h.results = [[{ id: 90 }], rows];
    expect(await getRecurringJournalForSource(3, 40)).toEqual({
      recurring: { id: 90 },
      history: [
        { id: 1, voucherNumber: "JV-1" },
        { id: 3, voucherNumber: "JV-3" },
      ],
    });
    h.results = [rows];
    expect((await getRecurringJournalHistory(3, 901)).map((r) => r.id)).toEqual([2]);
    h.results = [[{ id: 90 }]];
    expect(await listRecurringJournals(3)).toEqual([{ id: 90 }]);
  });
});

describe("runRecurringJournal early exits and failures", () => {
  const recurring = (over: Row = {}) =>
    ({
      id: 90,
      companyId: 3,
      active: true,
      timezone: "UTC",
      nextRunDate: "2026-10-31",
      endDate: null,
      ...over,
    }) as never;
  const idle = { posted: false, replayed: false, voucherId: null, scheduledFor: "2026-10-31" };

  it("does nothing for a missing, paused, rescheduled or future recurrence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    for (const locked of [[], [recurring({ active: false })], [recurring({ nextRunDate: "2026-11-30" })]]) {
      h.results = [locked];
      expect(await runRecurringJournal(recurring())).toEqual(idle);
    }
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    h.results = [[recurring()]];
    expect(await runRecurringJournal(recurring())).toEqual(idle);
    expect(h.post).not.toHaveBeenCalled();
    expect(sets()).toEqual([]);
  });

  it("deactivates a recurrence past its end date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    h.results = [[recurring({ endDate: "2026-10-30" })], undefined];
    expect(await runRecurringJournal(recurring())).toEqual(idle);
    expect(sets()).toEqual([{ active: false, updatedAt: expect.any(Date) }]);
  });

  it("records a closed-period skip from the database guard and rethrows other failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    h.results = [[recurring()], undefined, undefined];
    h.post.mockRejectedValueOnce(new Error("period 2026-10 is closed"));
    h.closedError.mockReturnValueOnce(true);
    expect(await runRecurringJournal(recurring())).toEqual({
      ...idle,
      skipped: {
        companyId: 3,
        reference: "recurring-journal:90",
        date: "2026-10-31",
        reason: "PERIOD_CLOSED",
        closedThrough: null,
      },
    });
    expect(sets().at(-1)).toMatchObject({ lastError: "PERIOD_CLOSED: period 2026-10 is closed" });

    h.calls = [];
    h.results = [[recurring()], undefined, new Error("cannot record")];
    h.post.mockRejectedValueOnce(new Error("x".repeat(2500)));
    await expect(runRecurringJournal(recurring())).rejects.toThrow("x".repeat(2500));
    expect((sets().at(-1)?.lastError as string).length).toBe(2000);
  });
});

describe("runDueRecurringJournals", () => {
  it("counts posted, skipped and failed recurrences", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const due = (id: number) => ({
      id,
      companyId: 3,
      active: true,
      timezone: "UTC",
      nextRunDate: "2026-10-31",
      endDate: null,
    });
    h.results = [
      [due(1), due(2), due(3)],
      // 1: missing when locked, so not posted.
      [],
      // 2: closed period, recorded as a skip.
      [due(2)],
      undefined,
      // 3: fails to post and to record the failure.
      [due(3)],
      undefined,
      undefined,
    ];
    h.closedThrough.mockResolvedValueOnce("2026-10-31");
    h.inClosed.mockReturnValueOnce(true);
    h.post.mockRejectedValueOnce(new Error("engine down"));
    const out = await runDueRecurringJournals();
    expect(out).toMatchObject({ candidates: 3, posted: 0, failed: 1 });
    expect(out.skipped).toEqual([
      {
        companyId: 3,
        reference: "recurring-journal:2",
        date: "2026-10-31",
        reason: "PERIOD_CLOSED",
        closedThrough: "2026-10-31",
      },
    ]);
    expect(sets()[0].lastError).toBe(
      "PERIOD_CLOSED: the books are closed through 2026-10-31; the run of 2026-10-31 was skipped"
    );

    h.results = [[]];
    expect(await runDueRecurringJournals()).toEqual({ candidates: 0, posted: 0, failed: 0, skipped: [] });
  });
});
