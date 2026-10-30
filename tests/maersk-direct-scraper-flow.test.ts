import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeResponse = {
  url: () => string;
  status: () => number;
  headers: () => Record<string, string>;
  json: () => Promise<unknown>;
};
type Emit = (response: FakeResponse) => Promise<void>;
type Script = (url: string, emit: Emit, page: FakePage) => Promise<void>;
type FakePage = ReturnType<typeof makePage>;

const h = vi.hoisted(() => ({
  installed: new Set(["puppeteer-extra", "puppeteer-extra-plugin-stealth", "puppeteer"]),
  existing: new Set(["/opt/chrome"]),
  launches: [] as unknown[],
  browsers: [] as unknown[],
  script: null as unknown,
  nextData: null as unknown,
  bodyText: "" as unknown,
  newPageError: null as Error | null,
  released: 0,
  acquireError: null as Error | null,
  stealthUses: 0,
}));

function makePage() {
  const handlers: Array<(r: FakeResponse) => Promise<void>> = [];
  const page = {
    closed: false,
    visited: [] as string[],
    rejectGoto: null as ((e: Error) => void) | null,
    on: (_event: string, handler: (r: FakeResponse) => Promise<void>) => handlers.push(handler),
    setViewport: vi.fn(async () => undefined),
    setUserAgent: vi.fn(async () => undefined),
    url: () => page.visited.at(-1) ?? "about:blank",
    close: vi.fn(async () => {
      page.closed = true;
      page.rejectGoto?.(new Error("Target closed"));
    }),
    goto: vi.fn(async (url: string) => {
      if (page.closed) throw new Error("Target closed");
      page.visited.push(url);
      await (h.script as Script | null)?.(
        url,
        async (response) => {
          for (const handler of handlers) await handler(response);
        },
        page
      );
    }),
    evaluate: vi.fn(async (fn: () => unknown) => {
      const value = String(fn).includes("__NEXT_DATA__") ? h.nextData : h.bodyText;
      if (value instanceof Error) throw value;
      return value;
    }),
  };
  return page;
}

function makeBrowser() {
  const listeners: Record<string, () => void> = {};
  const browser = {
    alive: true,
    pagesMade: [] as FakePage[],
    pages: vi.fn(async () => {
      if (!browser.alive) throw new Error("gone");
      return [];
    }),
    newPage: vi.fn(async () => {
      if (h.newPageError) throw h.newPageError;
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
      if (name === "puppeteer") return { executablePath: () => "/opt/chrome" };
      if (name === "puppeteer-extra-plugin-stealth") return () => ({ name: "stealth" });
      return {
        use: () => {
          h.stealthUses += 1;
        },
        launch: async (options: unknown) => {
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
        return name;
      },
    }
  );
  return { ...original, default: { ...original, createRequire: () => fakeRequire }, createRequire: () => fakeRequire };
});
vi.mock("child_process", () => ({
  execSync: () => {
    throw new Error("not found");
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

const TRACK = "https://api.maersk.com/synergy/tracking/MSKU1234567";
const response = (url: string, body: unknown, contentType = "application/json"): FakeResponse => ({
  url: () => url,
  status: () => 200,
  headers: () => ({ "content-type": contentType }),
  json: async () => body,
});
const synergy = {
  containers: [
    {
      container_num: "OTHER0000001",
      locations: [{ city: "Nowhere", events: [{ activity: "Wrong box", event_time_type: "ACTUAL" }] }],
    },
    {
      container_num: "MSKU 1234567",
      eta_final_delivery: "2026-11-05T08:00:00-05:00",
      locations: [
        {
          terminal: "APM",
          city: "Durban",
          country: "ZA",
          events: [
            {
              activity: "Loaded",
              event_time: "2026-10-10T10:00:00Z",
              event_time_type: "ACTUAL",
              vessel_name: "MAERSK X",
              voyage_num: "123E",
            },
            { activity: "Vessel departure", event_time: "2026-10-12T10:00:00Z", event_time_type: "ACTUAL" },
          ],
        },
        {
          city: "Walvis Bay",
          events: [{ activity: "Arrival", event_time: "2026-11-01T10:00:00Z", event_time_type: "EXPECTED" }],
        },
      ],
    },
  ],
};

let scraper: typeof import("../server/lib/maerskDirectScraper");
let logger: typeof import("../server/lib/logger").logger;

beforeEach(async () => {
  vi.resetModules();
  Object.assign(h, {
    installed: new Set(["puppeteer-extra", "puppeteer-extra-plugin-stealth", "puppeteer"]),
    existing: new Set(["/opt/chrome"]),
    launches: [],
    browsers: [],
    script: null,
    nextData: null,
    bodyText: "",
    newPageError: null,
    released: 0,
    acquireError: null,
    stealthUses: 0,
  });
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.PUPPETEER_BROWSER_IDLE_MS;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  scraper = await import("../server/lib/maerskDirectScraper");
  logger = (await import("../server/lib/logger")).logger;
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function scrape(container = "MSKU1234567") {
  const pending = scraper.scrapeMaerskDirect(container);
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

const onTracking =
  (fn: (emit: Emit) => Promise<void>): Script =>
  async (url, emit) => {
    if (url.includes("/tracking/")) await fn(emit);
  };

describe("scrapeMaerskDirect", () => {
  it("returns an empty result when puppeteer is unavailable or the queue is full", async () => {
    h.installed.delete("puppeteer");
    await expect(scraper.scrapeMaerskDirect("C1")).resolves.toMatchObject({
      success: false,
      provider: "maersk_scraper",
      carrier: "MAERSK",
      containerNumber: "C1",
      error: "Puppeteer not available",
    });
    expect(scraper.isMaerskDirectScraperAvailable()).toBe(false);

    h.installed.add("puppeteer");
    h.acquireError = new Error("PUPPETEER_QUEUE_FULL");
    await expect(scraper.scrapeMaerskDirect("C1")).resolves.toMatchObject({ error: "PUPPETEER_QUEUE_FULL" });
    h.acquireError = new Error("broken");
    await expect(scraper.scrapeMaerskDirect("C1")).rejects.toThrow("broken");
  });

  it("warms up, captures Maersk JSON and keeps the most authoritative payload", async () => {
    h.script = onTracking(async (emit) => {
      await emit(response("https://evil.example/api", synergy));
      await emit(response("https://www.maersk.com/static/app.js", synergy));
      await emit(response("https://www.maersk.com/page", synergy, "text/html"));
      await emit({ ...response("https://api.maersk.com/x", null), json: async () => Promise.reject(new Error("bad")) });
      await emit(response("https://api.maersk.com/list", [{ eta: "2026-12-01" }]));
      await emit(
        response("https://api.maersk.com/generic", { events: [{ eventDate: "2026-10-01", status: "Gate in" }] })
      );
      await emit(response(TRACK, synergy));
      await emit(response("https://api.maersk.com/generic2", { eta: "2026-12-24", events: [] }));
    });
    const result = await scrape();
    expect(result).toMatchObject({
      success: true,
      provider: "maersk_scraper",
      carrier: "MAERSK",
      containerNumber: "MSKU1234567",
      latestStatus: "Vessel departure",
      eta: "2026-11-05",
      latestLocation: "APM, Durban, ZA",
      latestDescription: "Vessel departure",
      raw: synergy,
    });
    expect(result.events).toHaveLength(3);
    expect(result.events[0].status).toBe("Arrival");
    expect(result.latestEventDate).toEqual(new Date("2026-10-12T10:00:00Z"));
    expect(result.events.find((e) => e.status === "Loaded")?.description).toBe("Loaded via MAERSK X 123E");

    const page = (h.browsers[0] as ReturnType<typeof makeBrowser>).pagesMade[0];
    expect(page.visited).toEqual(["https://www.maersk.com", "https://www.maersk.com/tracking/MSKU1234567"]);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(h.released).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("keys=[[array]]"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("ETA_FOUND: path=eta val=2026-12-01"));
  });

  it("ignores responses from other hosts, static assets and non-JSON content", async () => {
    h.script = onTracking(async (emit) => {
      await emit(response("https://evil.example/api", synergy));
      await emit(response("https://maersk.com.evil.example/x.js", synergy));
      await emit(response("https://www.maersk.com/static/app.js?v=2", synergy));
      await emit(response("https://www.maersk.com/fonts/a.woff2", synergy));
      await emit(response("https://www.maersk.com/page", synergy, "text/html"));
      await emit(response("https://www.maersk.com/null", null));
      await emit(response("https://www.maersk.com/text", "just a string"));
    });
    await expect(scrape()).resolves.toMatchObject({ success: false, error: "no_tracking_data_found" });
  });

  it("prefers the synergy schema, then a payload with an ETA, then more events", async () => {
    const generic = (n: number, eta?: string) => ({
      ...(eta ? { eta } : {}),
      events: Array.from({ length: n }, (_, i) => ({ eventDate: `2026-10-0${i + 1}`, status: `E${i}` })),
    });
    h.script = onTracking(async (emit) => {
      await emit(response("https://api.maersk.com/a", generic(4)));
      await emit(response("https://api.maersk.com/b", generic(1, "2026-12-01")));
      await emit(response("https://api.maersk.com/c", generic(2, "2026-12-02")));
    });
    await expect(scrape()).resolves.toMatchObject({ eta: "2026-12-02", raw: generic(2, "2026-12-02") });

    h.script = onTracking(async (emit) => {
      await emit(response(TRACK, synergy));
      await emit(response("https://api.maersk.com/many", generic(9, "2026-12-09")));
    });
    await expect(scrape()).resolves.toMatchObject({ eta: "2026-11-05", raw: synergy });
  });

  it("lets the session settle after the homepage before tracking", async () => {
    const at: number[] = [];
    h.script = async () => {
      at.push(Date.now());
    };
    await scrape();
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(2_500);
  });

  it("uses a deep-scanned ETA when a payload has no events", async () => {
    h.script = onTracking((emit) => emit(response(TRACK, { journey: { legs: [{ plannedArrival: "2026-11-09" }] } })));
    const result = await scrape();
    expect(result).toMatchObject({
      success: true,
      eta: "2026-11-09",
      events: [],
      latestStatus: null,
      latestLocation: null,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("(deep-scan path=plannedArrival)"));
  });

  it("waits for tracking data that arrives after navigation", async () => {
    let later: Emit | null = null;
    h.script = onTracking(async (emit) => {
      later = emit;
    });
    const pending = scraper.scrapeMaerskDirect("MSKU1234567");
    await vi.advanceTimersByTimeAsync(8_000);
    await later!(response(TRACK, synergy));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ success: true, eta: "2026-11-05" });
  });

  it("falls back to __NEXT_DATA__ with or without a direct ETA", async () => {
    h.nextData = {
      shipment: {
        containers: [
          {
            containerNumber: "MSKU1234567",
            events: [{ eventDateTime: "2026-10-01T00:00:00Z", activityName: "Gate out" }],
          },
        ],
      },
    };
    let result = await scrape();
    expect(result).toMatchObject({
      success: true,
      eta: null,
      latestStatus: "Gate out",
      raw: { source: "__NEXT_DATA__" },
    });

    h.nextData = { tracking: { vesselArrival: "2026-11-15" } };
    result = await scrape();
    expect(result).toMatchObject({ success: true, eta: "2026-11-15", events: [], latestStatus: null });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("__NEXT_DATA__ hit — events=0 eta=2026-11-15 (deep-scan path=vesselArrival)")
    );
  });

  it("reads the rendered page when nothing structured was captured", async () => {
    h.nextData = { props: {} };
    h.bodyText = "Container MSKU1234567\nStatus: In Transit\nEstimated Time of Arrival: Nov 3, 2026";
    let result = await scrape();
    expect(result).toMatchObject({
      success: true,
      latestStatus: "In Transit",
      latestDescription: "In Transit",
      eta: "2026-11-03",
      raw: { source: "dom_text" },
    });
    expect(result.events).toEqual([
      { date: new Date("2026-11-03"), status: "In Transit", location: null, description: null },
    ]);
    expect(logger.info).toHaveBeenCalledWith("[MaerskDirect] MSKU1234567: __NEXT_DATA__ present but no useful data");

    h.nextData = new Error("evaluate failed");
    h.bodyText = "ETA: 2026-11-20";
    result = await scrape();
    expect(result).toMatchObject({ success: true, latestStatus: null, eta: "2026-11-20", events: [] });
    expect(logger.info).toHaveBeenCalledWith("[MaerskDirect] MSKU1234567: no __NEXT_DATA__ found");

    h.nextData = null;
    h.bodyText = "Delivered";
    result = await scrape();
    expect(result).toMatchObject({ success: true, latestStatus: "Delivered", eta: null });
    expect(result.events[0].date).toBeNull();
  });

  it("recognises blocked and error pages, and reports when there is nothing at all", async () => {
    h.bodyText = "Access Denied — reference #18";
    await expect(scrape()).resolves.toMatchObject({ success: false, blocked: true, error: "bot_challenge" });
    h.bodyText = "Something went wrong. We're working to fix it.";
    await expect(scrape()).resolves.toMatchObject({ success: false, error: "maersk_error_page" });
    h.bodyText = "Track your shipment";
    await expect(scrape()).resolves.toMatchObject({ success: false, error: "no_tracking_data_found" });
    h.bodyText = new Error("page gone");
    await expect(scrape()).resolves.toMatchObject({ error: "no_tracking_data_found" });
  });

  it("continues past navigation timeouts", async () => {
    h.script = async (url: string) => {
      throw new Error(`timeout ${url}`);
    };
    h.bodyText = "Gate Out";
    await expect(scrape()).resolves.toMatchObject({ success: true, latestStatus: "Gate Out" });
    expect(logger.info).toHaveBeenCalledWith("[MaerskDirect] MSKU1234567: homepage warmup timed out — continuing");
    expect(logger.info).toHaveBeenCalledWith("[MaerskDirect] MSKU1234567: domcontentloaded timed out — continuing");
  });

  it("closes a page that hangs past the hard timeout", async () => {
    h.script = (_url: string, _emit: Emit, page: FakePage) =>
      new Promise<void>((_resolve, reject) => {
        page.rejectGoto = reject;
      });
    const pending = scraper.scrapeMaerskDirect("MSKU1234567");
    await vi.advanceTimersByTimeAsync(200_000);
    await expect(pending).resolves.toMatchObject({ error: "no_tracking_data_found" });
    expect(logger.warn).toHaveBeenCalledWith("[MaerskDirect] MSKU1234567: hard timeout — closing page");
  });

  it("drops a crashed browser after an unexpected error and relaunches", async () => {
    await scrape();
    h.newPageError = new Error("Protocol error: Target closed");
    await expect(scrape()).resolves.toMatchObject({
      success: false,
      error: "unexpected: Protocol error: Target closed",
    });
    expect(logger.error).toHaveBeenCalledWith("[MaerskDirect] MSKU1234567: unexpected error", {
      error: "Protocol error: Target closed",
    });
    h.newPageError = null;
    await scrape();
    expect(h.launches).toHaveLength(2);

    // Other errors keep the browser.
    h.newPageError = new Error("bad viewport");
    await scrape();
    h.newPageError = null;
    await scrape();
    expect(h.launches).toHaveLength(2);
    expect(h.stealthUses).toBe(1);
  });

  it("reuses one browser, relaunches a dead one and retires it when idle", async () => {
    process.env.PUPPETEER_BROWSER_IDLE_MS = "600000";
    await scrape();
    await scrape();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({ headless: true, executablePath: "/opt/chrome" });

    const first = h.browsers[0] as ReturnType<typeof makeBrowser>;
    first.alive = false;
    await scrape();
    expect(h.launches).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith("[MaerskDirect] Shared browser disconnected — relaunching");
    first.emit("disconnected");
    await scrape();
    expect(h.launches).toHaveLength(2);

    const second = h.browsers[1] as ReturnType<typeof makeBrowser>;
    second.close.mockRejectedValueOnce(new Error("already gone"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("[MaerskDirect] Idle browser shutdown failed", { error: "already gone" });

    await scrape();
    (h.browsers[2] as ReturnType<typeof makeBrowser>).emit("disconnected");
    await scrape();
    expect(h.launches).toHaveLength(4);
  });

  it("uses the default idle window for an invalid setting", async () => {
    process.env.PUPPETEER_BROWSER_IDLE_MS = "10";
    await scrape();
    const browser = h.browsers[0] as ReturnType<typeof makeBrowser>;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
