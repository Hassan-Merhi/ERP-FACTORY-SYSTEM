/**
 * The shared logger: level and format configuration from the environment,
 * value sanitising and redaction, event naming, level demotion for noise,
 * and the human-readable rewrites of legacy messages. The module is reloaded
 * per environment so its import-time configuration is exercised.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const env = { ...process.env };

async function load(over: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of ["NODE_ENV", "RENDER", "RENDER_SERVICE_ID", "LOG_LEVEL", "LOG_FORMAT", "LOG_REDACT_SENSITIVE"]) {
    delete process.env[key];
  }
  Object.assign(process.env, over);
  return import("../server/lib/logger");
}

function capture() {
  const out = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.log.push(line));
  vi.spyOn(console, "warn").mockImplementation((line: string) => void out.warn.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void out.error.push(line));
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...env };
});

describe("logger configuration", () => {
  it("defaults to debug and pretty output outside production", async () => {
    const { getLoggerConfiguration } = await load({ NODE_ENV: "test" });
    expect(getLoggerConfiguration()).toEqual({
      level: "debug",
      format: "pretty",
      redactionEnabled: true,
      renderDetected: false,
    });
  });

  it("defaults to info and JSON in production, pretty on Render", async () => {
    expect((await load({ NODE_ENV: "production" })).getLoggerConfiguration()).toEqual({
      level: "info",
      format: "json",
      redactionEnabled: true,
      renderDetected: false,
    });
    expect((await load({ NODE_ENV: "production", RENDER: "true" })).getLoggerConfiguration()).toMatchObject({
      format: "pretty",
      renderDetected: true,
    });
    expect((await load({ NODE_ENV: "production", RENDER_SERVICE_ID: "srv-1" })).getLoggerConfiguration()).toMatchObject(
      {
        renderDetected: true,
      }
    );
  });

  it("honours explicit level, format and redaction settings", async () => {
    expect(
      (
        await load({ NODE_ENV: "test", LOG_LEVEL: "WARN", LOG_FORMAT: "JSON", LOG_REDACT_SENSITIVE: "false" })
      ).getLoggerConfiguration()
    ).toEqual({ level: "warn", format: "json", redactionEnabled: false, renderDetected: false });
    expect(
      (await load({ NODE_ENV: "production", LOG_LEVEL: "loud", LOG_FORMAT: "xml" })).getLoggerConfiguration()
    ).toMatchObject({
      level: "info",
      format: "json",
    });
    expect(
      (
        await load({ NODE_ENV: "production", LOG_FORMAT: "pretty", LOG_REDACT_SENSITIVE: "false" })
      ).getLoggerConfiguration()
    ).toMatchObject({
      format: "pretty",
      redactionEnabled: true,
    });
  });
});

describe("JSON output", () => {
  it("writes each level to its console stream with a sanitised context", async () => {
    const { logger } = await load({ NODE_ENV: "production", LOG_LEVEL: "debug" });
    const out = capture();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 5; i++) deep = { deep };
    logger.debug("debugging", {
      big: 10n,
      fn: () => 1,
      sym: Symbol("s"),
      when: new Date("2026-10-20T00:00:00Z"),
      buf: Buffer.from("abc"),
      list: [1, "two", null],
      circular,
      deep,
      apiKey: "abc123",
      nested: { password: "p", plain: "x".repeat(2_100) },
      skipped: undefined,
      err: new Error("inner"),
    });
    const entry = JSON.parse(out.log[0]);
    expect(entry).toMatchObject({
      level: "DEBUG",
      message: "debugging.",
      big: "10",
      sym: "Symbol(s)",
      when: "2026-10-20T00:00:00.000Z",
      buf: "[Buffer 3 bytes]",
      list: [1, "two", null],
      circular: { name: "loop", self: "[Circular]" },
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
      err: { message: "inner" },
    });
    expect(entry.fn).toContain("=>");
    expect(entry.deep.deep.deep.deep.deep).toBe("[MaxDepth]");
    expect(entry.nested.plain).toHaveLength(2_001);
    expect(entry).not.toHaveProperty("skipped");
    expect(entry.err).not.toHaveProperty("stack");

    logger.warn("careful", { error: "plain string failure" });
    expect(JSON.parse(out.warn[0])).toMatchObject({ level: "WARN", error: { message: "plain string failure" } });
    const failure = Object.assign(new Error("outer"), { code: "E1", detail: "detail text", cause: new Error("root") });
    logger.error("broken", { error: failure });
    expect(JSON.parse(out.error[0]).error).toEqual({
      message: "outer",
      code: "E1",
      detail: "detail text",
      cause: { message: "root" },
    });
    logger.info("no context");
    expect(JSON.parse(out.log[1]).message).toBe("no context.");
  });

  it("drops messages below the configured level", async () => {
    const { logger } = await load({ NODE_ENV: "production", LOG_LEVEL: "warn" });
    const out = capture();
    logger.info("hidden");
    logger.debug("hidden");
    logger.warn("shown");
    expect([out.log, out.warn.length]).toEqual([[], 1]);
  });

  it("leaves values unredacted when redaction is off", async () => {
    const { __loggerTesting } = await load({ NODE_ENV: "test", LOG_REDACT_SENSITIVE: "false" });
    expect(__loggerTesting.sanitiseContext({ note: "Bearer abc.def.ghi" })).toEqual({ note: "Bearer abc.def.ghi" });
    // Sensitive key names are always masked, at any depth.
    expect(__loggerTesting.sanitiseContext({ user: { password: "p", name: "n" }, token: "t" })).toEqual({
      user: { password: "[REDACTED]", name: "n" },
      token: "[REDACTED]",
    });
  });
});

describe("pretty output", () => {
  it("prints the level, message, known context keys and the error", async () => {
    const { logger } = await load({ NODE_ENV: "test" });
    const out = capture();
    logger.error("[Exports] job failed", {
      requestId: "r1",
      durationMs: 1500,
      responseBytes: 2048,
      status: "",
      companyId: 4,
      error: new Error("disk full"),
    });
    expect(out.error[0]).toBe(
      "[ERROR] Exports: job failed. requestId=r1 companyId=4 durationMs=1.50 seconds responseBytes=2.0 KB error=disk full"
    );
    logger.warn("Careful!", { voucherId: 9 });
    expect(out.warn[0]).toBe("[WARN] Careful! voucherId=9");
    logger.info("   ");
    expect(out.log[0]).toBe("[INFO] Application event recorded.");
  });
});

describe("message helpers", () => {
  it("formats byte counts and durations", async () => {
    const { __loggerTesting: t } = await load({ NODE_ENV: "test" });
    expect(["x", -1, 512, 2_048, 20_480, 2_097_152, 20_971_520, 3 * 1_073_741_824].map(t.formatBytes)).toEqual([
      "an unknown amount of data",
      "an unknown amount of data",
      "512 B",
      "2.0 KB",
      "20 KB",
      "2.00 MB",
      "20.0 MB",
      "3.00 GB",
    ]);
    expect(["x", -5, 250.4, 2_500, 12_000, 90_000].map(t.formatDuration)).toEqual([
      "an unknown time",
      "an unknown time",
      "250 ms",
      "2.50 seconds",
      "12.0 seconds",
      "1.5 minutes",
    ]);
  });

  it("names events from an explicit event, an operational code or module and action", async () => {
    const { __loggerTesting: t } = await load({ NODE_ENV: "test" });
    expect(t.resolveEvent({ event: "  Export Finished! " })).toBe("export_finished_");
    expect(t.resolveEvent({ module: "operational_events", code: "DB Slow" })).toBe("operational.db_slow");
    expect(t.resolveEvent({ module: "Exports", action: "Run Now", event: "  " })).toBe("exports.run_now");
    expect(t.resolveEvent({ module: " ", action: 3 as never })).toBeUndefined();
  });

  it("demotes routine noise to debug but never security events", async () => {
    const { __loggerTesting: t } = await load({ NODE_ENV: "test" });
    const level = (message: string, ctx = {}, base: "info" | "warn" = "info") =>
      t.resolveEffectiveLevel(base, message, ctx);
    expect(level("Sync starting")).toBe("debug");
    expect(level("Done", { action: "export.start" })).toBe("debug");
    expect(level("Server starting", { module: "startup" })).toBe("info");
    expect(level("[getLocationInventory] loaded")).toBe("debug");
    expect(level("[express] [SLOW API] GET /x")).toBe("debug");
    expect(level("heartbeat ok")).toBe("debug");
    expect(level("ok", { action: "session_check" })).toBe("debug");
    expect(level('{"event":"access_denied","reason":"SESSION_REQUIRED","path":"/api/auth/me"}')).toBe("debug");
    expect(level('{"event":"access_denied","reason":"SESSION_REQUIRED","path":"/api/x"}')).toBe("info");
    expect(level("{not json}")).toBe("info");
    expect(level("blocked /heartbeat", { event: "security.csp" })).toBe("info");
    expect(level("heartbeat", {}, "warn")).toBe("warn");
    expect(level("Export done")).toBe("info");
  });

  it("rewrites known legacy messages into sentences", async () => {
    const { __loggerTesting: t } = await load({ NODE_ENV: "test" });
    const h = (message: string, ctx = {}) => t.humanizeLegacyMessage(message, ctx);
    expect(h("[getLocationInventory] locationId=7 company=2 loaded 1 rows")).toBe(
      "Inventory loaded for location 7 with 1 item"
    );
    expect(h("[getLocationInventory] locationId=x 3 rows")).toBe("getLocationInventory: locationId=x 3 rows");
    expect(h("[WA invoice backend] voucherId=5 locationId=2 itemCount=3 pageCount=1 dryRun=true")).toBe(
      "Invoice preview 5 was generated for location 2 with 3 items across 1 page"
    );
    expect(h("[WA invoice backend] voucherId=5 locationId=2 itemCount=1 pageCount=2 dryRun=false")).toBe(
      "Invoice 5 was generated for location 2 with 1 item across 2 pages"
    );
    expect(h("[WA invoice backend] voucherId=5 locationId=2 itemCount=1 pageCount=2 dryRun=maybe")).toBe(
      "WA invoice backend: voucherId=5 locationId=2 itemCount=1 pageCount=2 dryRun=maybe"
    );
    expect(h("[WA upload] Green API response", { fileName: "a.pdf", size: 2048 })).toBe(
      "WhatsApp uploaded a.pdf successfully (2.0 KB)"
    );
    expect(h("[WA upload] Green API response")).toBe("WhatsApp uploaded the file successfully");
    expect(h("[WA upload] Green API error")).toBe("WhatsApp could not upload the file");
    expect(h("[WA upload] Green API error", { fileName: "b.pdf" })).toBe("WhatsApp could not upload b.pdf");
    for (const [message, withId, without] of [
      ["POS sale update started", "Updating POS sale 3", "Updating a POS sale"],
      ["POS sale update succeeded", "POS sale 3 was updated successfully", "The POS sale was updated successfully"],
      ["POS sale update failed", "POS sale 3 could not be updated", "The POS sale could not be updated"],
    ]) {
      expect([h(message, { voucherId: 3 }), h(message)]).toEqual([withId, without]);
    }
    for (const [message, withId, without] of [
      ["container tracking update started", "Updating tracking for container 8", "Updating container tracking"],
      [
        "container tracking update succeeded",
        "Tracking for container 8 was updated successfully",
        "Container tracking was updated successfully",
      ],
      [
        "container tracking update failed",
        "Tracking for container 8 could not be updated",
        "Container tracking could not be updated",
      ],
    ]) {
      expect([h(message, { containerId: 8 }), h(message)]).toEqual([withId, without]);
    }
    expect(
      h("Ranked endpoint performance and bandwidth snapshot", {
        apiEndpointCount: 2,
        totalApiResponseBytes: 4096,
        windowMs: 60_000,
        ranked: [{ method: "get", path: "/api/a", totalResponseBytes: 3072 }, {}, {}, {}],
      })
    ).toBe(
      "API responses transferred 4.0 KB across 2 endpoints during the last 1.0 minutes. Top endpoints: GET /api/a 3.0 KB; HTTP unknown endpoint an unknown amount of data; HTTP unknown endpoint an unknown amount of data"
    );
    expect(h("Ranked endpoint performance and bandwidth snapshot", { endpointCount: 1, ranked: "x" })).toBe(
      "API responses transferred an unknown amount of data across 1 endpoint during the last an unknown time"
    );
    expect(h("Ranked endpoint performance and bandwidth snapshot")).toContain("across 0 endpoints");
    expect(
      h("Large HTTP response detected", { method: "GET", path: "/api/big", responseBytes: 2048, budgetBytes: 1024 })
    ).toBe("GET /api/big returned a large 2.0 KB response, exceeding the 1.0 KB warning threshold");
    expect(h("Large HTTP response detected")).toBe("HTTP request returned a large an unknown amount of data response");
    expect(h("get /api/x 200", { durationMs: 12 })).toBe("GET /api/x completed with status 200 in 12 ms");
    expect(h("POST /api/x 404")).toBe("POST /api/x was rejected with status 404");
    expect(h("GET /api/x 500")).toBe("GET /api/x failed with status 500");
    expect(h("GET /api/x 400")).toBe("GET /api/x was rejected with status 400");
    expect(h("PUT /api/x 503", { durationMs: 2000, slow: true, thresholdMs: 1000 })).toBe(
      "PUT /api/x failed with status 503 in 2.00 seconds; warning threshold 1.00 seconds"
    );
    expect(h("PUT /api/x 503", { slow: true })).toBe("PUT /api/x failed with status 503");
    expect(h('{"event":"access_denied","reason":"SESSION_REQUIRED","path":"/api/me"}')).toBe(
      "Access to /api/me was denied because an active session was required"
    );
    expect(h('{"event":"access_denied","reason":"ROLE"}')).toBe(
      "Access to the requested page was denied because access was not permitted"
    );
    expect(h('{"event":"other"}')).toBe('{"event":"other"}');
    expect(h("[/stock-report] sent")).toBe("stock report: sent");
    expect(h("[Scheduler]")).toBe("[Scheduler] event recorded");
    expect(h("[] odd")).toBe("[] odd");
    expect(h("plain text")).toBe("plain text");
  });

  it("formats pretty context values by kind", async () => {
    const { __loggerTesting: t } = await load({ NODE_ENV: "test" });
    const unserialisable = {
      toJSON() {
        throw new Error("no");
      },
    };
    expect(t.formatPrettyContext({ issues: unserialisable })).toEqual(["issues=[object Object]"]);
    expect(
      t.formatPrettyContext({
        thresholdMs: 900,
        budgetBytes: 10,
        checked: { a: 1 },
        clean: false,
        failed: null,
        event: "x",
      })
    ).toEqual(["event=x", "thresholdMs=900 ms", "budgetBytes=10 B", 'checked={"a":1}', "clean=false"]);
  });
});
