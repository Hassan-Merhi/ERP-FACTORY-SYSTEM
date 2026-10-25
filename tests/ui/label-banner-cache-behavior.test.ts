/**
 * Banner images on printed A4 labels. Without a design colour the banner
 * follows the article code's HMD range; with one it comes from the banner
 * cache: prefetched as a data URL before printing so the print window needs
 * no second request, cache-busted with the design's upload timestamp, and
 * left as the network URL when the prefetch fails.
 */
import {
  A4_DESIGN_OPTIONS,
  generateCombinedLabelsHtml,
  prefetchBannersForPrint,
  setBannerTimestamps,
  type LabelData,
} from "@/lib/labelHtml";
import { installFakeApi, respond, type FakeApi } from "./fakeApi";

const label = (overrides: Partial<LabelData> = {}): LabelData => ({
  referenceNumber: "REF-001",
  articleCode: "ART-100",
  pieces: 12,
  approxWeightKg: "45.5",
  productName: "Rice 5kg",
  ...overrides,
});

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  // Clear every cached banner between cases.
  setBannerTimestamps(Object.fromEntries(A4_DESIGN_OPTIONS.map((option) => [option.value, null])));
});

describe("label header images", () => {
  it.each([
    ["HMD11-01", "/labels/hmd-purple.jpg"],
    ["HMD12-01", "/labels/hmd-green.jpg"],
    ["HMD13-01", "/labels/hmd-gold.jpg"],
    ["HMD14-01", "/labels/hmd-white.jpg"],
  ])("%s prints the %s banner", (articleCode, banner) => {
    expect(generateCombinedLabelsHtml([label({ articleCode })])).toContain(banner);
  });

  it("prints the built-in logo for other or missing article codes", () => {
    for (const articleCode of ["ART-100", ""]) {
      const html = generateCombinedLabelsHtml([label({ articleCode })]);
      expect(html).toContain("data:image");
      expect(html).not.toContain("/labels/hmd-");
    }
  });
});

describe("design banner cache", () => {
  const design = A4_DESIGN_OPTIONS[0].value;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("uses the network URL, cache-busted by the upload timestamp, until prefetched", () => {
    expect(generateCombinedLabelsHtml([label()], design)).toContain(`/labels/hmd-${design}.jpg`);

    setBannerTimestamps({ [design]: 1700 });

    expect(generateCombinedLabelsHtml([label()], design)).toContain(`/labels/hmd-${design}.jpg?t=1700`);
  });

  it("prints the prefetched data URL, and drops it once the banner is replaced", async () => {
    api.get(/^\/labels\/hmd-.*\.jpg/, {});
    // The fake serialises bodies as JSON, and jsdom's FileReader reads only
    // jsdom blobs: hand the reader one of those for each banner it fetched.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      return { ok: response.ok, blob: async () => new Blob(["img"], { type: "image/jpeg" }) };
    }) as unknown as typeof fetch;

    prefetchBannersForPrint();
    await flush();
    globalThis.fetch = realFetch;

    expect(generateCombinedLabelsHtml([label({ designColor: design })])).toContain("data:image/jpeg;base64,");
    expect(api.callsTo("GET", /^\/labels\//).length).toBe(A4_DESIGN_OPTIONS.length);

    prefetchBannersForPrint();
    await flush();
    expect(api.callsTo("GET", /^\/labels\//).length).toBe(A4_DESIGN_OPTIONS.length);

    setBannerTimestamps({ [design]: 99 });
    expect(generateCombinedLabelsHtml([label()], design)).toContain(`/labels/hmd-${design}.jpg?t=99`);
  });

  it("keeps the network URL when a banner cannot be fetched", async () => {
    api.get(/^\/labels\//, respond(404, {}));

    prefetchBannersForPrint();
    await flush();

    expect(generateCombinedLabelsHtml([label()], design)).toContain(`/labels/hmd-${design}.jpg`);
  });
});
