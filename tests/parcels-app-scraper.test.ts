import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (response: FakeResponse) => Promise<void>;
type FakeResponse = { url: () => string; json: () => Promise<unknown> };

const h = vi.hoisted(() => {
  const state = {
    installed: new Set(["puppeteer-extra", "puppeteer-extra-plugin-stealth", "puppeteer"]),
    executablePath: "/opt/chrome" as unknown,
    existing: new Set(["/opt/chrome", "/usr/bin/chromium"]),
    which: {} as Record<string, string>,
    execCalls: [] as string[],
    installThrows: false,
    afterInstall: null as (() => void) | null,
    launches: [] as Array<Record<string, unknown>>,
    browsers: [] as unknown[],
    pageScript: null as unknown,
    released: 0,
    acquireError: null as Error | null,
    stealthUses: 0,
  };
  return state;
});

function makePage() {
  const handlers: Handler[] = [];
  const page = {
    closed: false,
    gotoUrl: "",
    rejectGoto: null as ((error: Error) => void) | null,
    on: (_event: string, handler: Handler) => handlers.push(handler),
    setViewport: vi.fn(async () => undefined),
    setUserAgent: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      page.closed = true;
      page.rejectGoto?.(new Error("Target closed"));
    }),
    goto: vi.fn(async (url: string) => {
      page.gotoUrl = url;
      const script = h.pageScript as
        ((emit: (r: FakeResponse) => Promise<void>, page: unknown) => Promise<void>) | null;
      await script?.(async (response) => {
        for (const handler of handlers) await handler(response);
      }, page);
    }),
  };
  return page;
}

function makeBrowser() {
  const listeners: Record<string, () => void> = {};
  const browser = {
    alive: true,
    pagesMade: [] as ReturnType<typeof makePage>[],
    pages: vi.fn(async () => {
      if (!browser.alive) throw new Error("disconnected");
      return [];
    }),
    newPage: vi.fn(async () => {
      const page = makePage();
      browser.pagesMade.push(page);
      return page;
    }),
    on: (event: string, listener: () => void) => {
      listeners[event] = listener;
    },
    emit: (event: string) => listeners[event]?.(),
    close: vi.fn(async () => undefined),
  };
  return browser;
}

vi.mock("module", async (importOriginal) => {
  const original = await importOriginal<typeof import("module")>();
  const fakeRequire = Object.assign(
    (name: string) => {
      if (!h.installed.has(name)) throw new Error(`Cannot find module '${name}'`);
      if (name === "puppeteer") return { executablePath: () => h.executablePath };
      if (name === "puppeteer-extra-plugin-stealth") return () => ({ name: "stealth" });
      return {
        use: () => {
          h.stealthUses += 1;
        },
        launch: async (options: Record<string, unknown>) => {
          h.launches.push(options);
          const browser = makeBrowser();
          h.browsers.push(browser);
          return browser;
        },
      };
    },
    {
      resolve: (name: string) => {
        if (!h.installed.has(name)) throw new Error(`Cannot find module '${name}'`);
        return `/node_modules/${name}`;
      },
    }
  );
  return { ...original, default: { ...original, createRequire: () => fakeRequire }, createRequire: () => fakeRequire };
});
vi.mock("child_process", () => ({
  execSync: (command: string) => {
    h.execCalls.push(command);
    const which = /^which (\S+)/.exec(command);
    if (which) {
      if (h.which[which[1]]) return `${h.which[which[1]]}\n`;
      throw new Error("not found");
    }
    if (h.installThrows) throw new Error("download failed");
    h.afterInstall?.();
    return "";
  },
}));
vi.mock("../server/lib/puppeteerPath", () => ({
  existingStringPath: (value: unknown) => (typeof value === "string" && h.existing.has(value) ? value : null),
}));
vi.mock("../server/lib/puppeteerSemaphore", () => ({
  acquirePuppeteerSlot: async () => {
    if (h.acquireError) throw h.acquireError;
    return () => {
      h.released += 1;
    };
  },
}));

const json = (url: string, body: unknown): FakeResponse => ({ url: () => url, json: async () => body });
const API = "https://parcelsapp.com/api/v3/shipments/tracking";

let scraper: typeof import("../server/lib/parcelsAppScraper");
let logger: typeof import("../server/lib/logger").logger;
const env = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  Object.assign(h, {
    installed: new Set(["puppeteer-extra", "puppeteer-extra-plugin-stealth", "puppeteer"]),
    executablePath: "/opt/chrome",
    existing: new Set(["/opt/chrome", "/usr/bin/chromium"]),
    which: {},
    execCalls: [],
    installThrows: false,
    afterInstall: null,
    launches: [],
    browsers: [],
    pageScript: null,
    released: 0,
    acquireError: null,
    stealthUses: 0,
  });
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.PUPPETEER_BROWSER_IDLE_MS;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  scraper = await import("../server/lib/parcelsAppScraper");
  logger = (await import("../server/lib/logger")).logger;
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...env };
});

async function scrape(container = "MSKU1234567") {
  const pending = scraper.scrapeTracking(container);
  await vi.advanceTimersByTimeAsync(30_000);
  return pending;
}

describe("scraper availability", () => {
  it("needs the packages and a Chrome binary, preferring the env override, then PATH, then puppeteer", () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/usr/bin/chromium";
    expect(scraper.isScraperAvailable()).toBe(true);
    expect(h.execCalls).toEqual([]);

    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    h.which = { "chromium-browser": "/usr/bin/chromium" };
    expect(scraper.isScraperAvailable()).toBe(true);
    expect(h.execCalls).toEqual(["which chromium 2>/dev/null", "which chromium-browser 2>/dev/null"]);

    h.which = {};
    expect(scraper.isScraperAvailable()).toBe(true);
    h.executablePath = Promise.resolve("/opt/chrome");
    expect(scraper.isScraperAvailable()).toBe(false);
    h.installed.delete("puppeteer");
    h.installed.add("puppeteer-extra");
    expect(scraper.isScraperAvailable()).toBe(false);
  });

  it("downloads Chrome only outside production", async () => {
    await scraper.ensureChromiumInstalled();
    expect(h.execCalls.some((c) => c.includes("browsers install"))).toBe(false);

    h.existing.delete("/opt/chrome");
    process.env.NODE_ENV = "production";
    await scraper.ensureChromiumInstalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Production environment — skipping Chrome download.")
    );

    process.env.NODE_ENV = "test";
    h.afterInstall = () => h.existing.add("/opt/chrome");
    await scraper.ensureChromiumAvailable();
    expect(h.execCalls).toContain("npx puppeteer browsers install chrome");
    expect(logger.info).toHaveBeenCalledWith("[Puppeteer] Chrome download complete — scraper ready.");
  });

  it("reports a download that did not produce Chrome or failed", async () => {
    h.existing.delete("/opt/chrome");
    await scraper.ensureChromiumInstalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Puppeteer] Chrome still not found after download — scraper unavailable."
    );

    h.installThrows = true;
    await scraper.ensureChromiumInstalled();
    expect(logger.warn).toHaveBeenCalledWith("[Puppeteer] Chrome setup error:", { error: "download failed" });
  });

  it("skips the download without puppeteer, or when its own Chrome path resolves later", async () => {
    h.installed.delete("puppeteer");
    await scraper.ensureChromiumInstalled();
    expect(logger.info).toHaveBeenCalledWith("[Puppeteer] puppeteer package not found — skipping Chrome download.");

    h.installed.add("puppeteer");
    h.executablePath = Promise.resolve("/opt/chrome");
    await scraper.ensureChromiumInstalled();
    expect(h.execCalls.some((c) => c.includes("browsers install"))).toBe(false);
  });
});

describe("scrapeTracking", () => {
  it("refuses when puppeteer is missing or the queue is full", async () => {
    h.installed.delete("puppeteer-extra");
    await expect(scraper.scrapeTracking("C1")).resolves.toEqual({
      success: false,
      shipment: null,
      blocked: false,
      error: "Puppeteer not installed",
    });

    h.installed.add("puppeteer-extra");
    h.acquireError = new Error("PUPPETEER_QUEUE_FULL");
    await expect(scraper.scrapeTracking("C1")).resolves.toMatchObject({ error: "PUPPETEER_QUEUE_FULL" });
    h.acquireError = new Error("semaphore broken");
    await expect(scraper.scrapeTracking("C1")).rejects.toThrow("semaphore broken");
  });

  it("captures the page's own tracking response and picks the matching shipment", async () => {
    const mine = { trackingId: "MSKU1234567", done: true };
    h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) => {
      await emit({ url: () => API, json: async () => Promise.reject(new Error("not json")) });
      await emit(json(API, { shipments: [{ trackingId: "OTHER" }, mine] }));
      // Later responses from other hosts, other paths or with no shipments are ignored.
      await emit(json("https://evil.example/api/v3/shipments", { shipments: [{ trackingId: "X" }] }));
      await emit(json("https://parcelsapp.com.evil.example/api/v3/shipments", { shipments: [{ trackingId: "X" }] }));
      await emit(json("https://parcelsapp.com/static/app.js", { shipments: [{ trackingId: "Y" }] }));
      await emit(json(API, { shipments: [] }));
    };
    const result = await scrape("MSKU1234567");
    expect(result).toEqual({
      success: true,
      shipment: mine,
      blocked: false,
      rawResponse: { shipments: [{ trackingId: "OTHER" }, mine] },
      error: undefined,
    });
    const [browser] = h.browsers as ReturnType<typeof makeBrowser>[];
    const [page] = browser.pagesMade;
    expect(page.gotoUrl).toBe("https://parcelsapp.com/en/tracking/MSKU1234567");
    expect(page.setViewport).toHaveBeenCalledWith({ width: 1280, height: 800 });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(h.released).toBe(1);
    expect(h.launches[0]).toMatchObject({ headless: true, executablePath: "/opt/chrome" });
    expect((h.launches[0].args as string[]).includes("--no-sandbox")).toBe(true);
    expect(h.stealthUses).toBe(1);
  });

  it("matches a v2 parcel by id or falls back to the first one", async () => {
    h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) => {
      await emit(
        json("https://parcelsapp.com/api/v2/parcels", {
          parcels: [{ trackingId: "a" }, { id: "C 9", trackingId: "b" }],
        })
      );
    };
    await expect(scrape("C 9")).resolves.toMatchObject({ success: true, shipment: { trackingId: "b" } });
    expect((h.browsers[0] as ReturnType<typeof makeBrowser>).pagesMade[0].gotoUrl).toBe(
      "https://parcelsapp.com/en/tracking/C%209"
    );
    await expect(scrape("ZZZ")).resolves.toMatchObject({ shipment: { trackingId: "a" } });
  });

  it("detects bot blocking in its several forms", async () => {
    for (const body of [
      { error: "NO_TRACKER" },
      { blocked: true },
      { status: "blocked" },
      { error: "reCAPTCHA failed" },
    ]) {
      h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) =>
        emit(json("https://parcelsapp.com/api/v3/track", body));
      await expect(scrape()).resolves.toEqual({
        success: false,
        shipment: null,
        blocked: true,
        error: "reCaptcha detected automation — stealth plugin bypassed",
      });
    }
    h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) =>
      emit(json("https://parcelsapp.com/api/v3/parcel/1", { error: "rate limited" }));
    await expect(scrape()).resolves.toMatchObject({
      blocked: false,
      error: "No tracking data received from ParcelsApp page",
    });
  });

  it("waits for data that arrives after navigation", async () => {
    let emitLater: ((r: FakeResponse) => Promise<void>) | null = null;
    h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) => {
      emitLater = emit;
    };
    const pending = scraper.scrapeTracking("MSKU1234567");
    await vi.advanceTimersByTimeAsync(3_000);
    await emitLater!(json("https://parcelsapp.com/api/v2/shipment", { shipments: [{ trackingId: "MSKU1234567" }] }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it("closes the page and reports navigation errors", async () => {
    h.pageScript = async () => {
      throw new Error("net::ERR_TIMED_OUT");
    };
    await expect(scrape()).resolves.toEqual({
      success: false,
      shipment: null,
      blocked: false,
      error: "Scraper error: net::ERR_TIMED_OUT",
    });
    const page = (h.browsers[0] as ReturnType<typeof makeBrowser>).pagesMade[0];
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(h.released).toBe(1);
  });

  it("closes a page that hangs past the hard timeout", async () => {
    h.pageScript = (_emit: unknown, page: { rejectGoto: ((e: Error) => void) | null }) =>
      new Promise<void>((_resolve, reject) => {
        page.rejectGoto = reject;
      });
    const pending = scraper.scrapeTracking("MSKU1234567");
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(pending).resolves.toMatchObject({ error: "Scraper error: Target closed" });
    expect(logger.warn).toHaveBeenCalledWith("[ParcelsAppScraper] MSKU1234567: hard timeout — closing page");
  });

  it("reuses one browser, relaunches a dead one and retires it when idle", async () => {
    process.env.PUPPETEER_BROWSER_IDLE_MS = "120000";
    h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) =>
      emit(json(API, { shipments: [{ trackingId: "C" }] }));
    await scrape("C");
    await scrape("C");
    expect(h.launches).toHaveLength(1);
    expect(h.stealthUses).toBe(1);

    const first = h.browsers[0] as ReturnType<typeof makeBrowser>;
    first.alive = false;
    await scrape("C");
    expect(h.launches).toHaveLength(2);
    expect(h.stealthUses).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("[ParcelsAppScraper] Shared browser disconnected — relaunching");

    // A stale browser's disconnect does not clear the replacement.
    first.emit("disconnected");
    await scrape("C");
    expect(h.launches).toHaveLength(2);

    const second = h.browsers[1] as ReturnType<typeof makeBrowser>;
    second.close.mockRejectedValueOnce(new Error("already gone"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("[ParcelsAppScraper] Idle browser shutdown failed", {
      error: "already gone",
    });
    await scrape("C");
    expect(h.launches).toHaveLength(3);

    // The current browser crashing clears it so the next call relaunches.
    (h.browsers[2] as ReturnType<typeof makeBrowser>).emit("disconnected");
    await scrape("C");
    expect(h.launches).toHaveLength(4);
  });

  it("uses the default idle window for an invalid setting", async () => {
    process.env.PUPPETEER_BROWSER_IDLE_MS = "5";
    h.pageScript = async (emit: (r: FakeResponse) => Promise<void>) =>
      emit(json(API, { shipments: [{ trackingId: "C" }] }));
    await scrape("C");
    const browser = h.browsers[0] as ReturnType<typeof makeBrowser>;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
