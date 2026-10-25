import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html2canvas = vi.fn();
vi.mock("html2canvas", () => ({ default: (...args: unknown[]) => html2canvas(...args) }));

import { captureAndUploadScreenFrame } from "./screen-feed-capture-engine";

const taintedCanvases = new WeakSet<HTMLCanvasElement>();
let encodedBlobSize = 4;

function securityError(): DOMException {
  return new DOMException("Tainted canvases may not be exported.", "SecurityError");
}

function stubContext(owner: HTMLCanvasElement): CanvasRenderingContext2D {
  return {
    canvas: owner,
    fillStyle: "",
    font: "",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    clearRect: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    drawImage: (source: unknown) => {
      if (source instanceof HTMLCanvasElement && taintedCanvases.has(source)) taintedCanvases.add(owner);
    },
    getImageData: () => {
      if (taintedCanvases.has(owner)) throw securityError();
      return { data: new Uint8ClampedArray(32 * 18 * 4) };
    },
  } as unknown as CanvasRenderingContext2D;
}

function installCanvasStubs(): void {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return stubContext(this);
  } as unknown as HTMLCanvasElement["getContext"];

  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback, type) {
    if (taintedCanvases.has(this)) throw securityError();
    callback(new Blob([new Uint8Array(encodedBlobSize)], { type: type || "image/jpeg" }));
  };

  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement) {
    if (taintedCanvases.has(this)) throw securityError();
    return "data:image/jpeg;base64,AAAA";
  };
}

function makeCanvas(width: number, height: number, tainted: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  if (tainted) taintedCanvases.add(canvas);
  return canvas;
}

function captureOnce(fetchMock: ReturnType<typeof vi.fn>, fast = false) {
  return captureAndUploadScreenFrame({
    fast,
    lastSignature: null,
    lastUploadedClickTs: 0,
    cursor: null,
    expectedPath: window.location.href,
    clicks: [],
    scrollElements: [],
    shouldContinue: () => true,
  }).then((result) => {
    const upload = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/screen-feed" && (call[1] as { method?: string } | undefined)?.method === "POST"
    );
    const body = JSON.parse((upload?.[1] as { body?: string } | undefined)?.body ?? "{}");
    return { result, body, upload };
  });
}

describe("screen feed capture engine", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    encodedBlobSize = 4;
    installCanvasStubs();
    (globalThis as { CanvasRenderingContext2D?: unknown }).CanvasRenderingContext2D = class {
      createPattern() {
        return null;
      }
    };
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    html2canvas.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never renders through foreignObject, whose output cannot be encoded", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    await captureOnce(fetchMock);

    const options = html2canvas.mock.calls[0]?.[1] as { foreignObjectRendering?: boolean };
    expect(options.foreignObjectRendering).toBe(false);
  });

  it("uses the HTTP recovery upload when binary transport is unavailable", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    const { result, body, upload } = await captureOnce(fetchMock);

    expect(result.uploaded).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.failureStage).toBeUndefined();
    expect(upload).toBeTruthy();
    expect(body.tabId).toBeTruthy();
    expect(body.capture.source).toBe("dom");
    expect(String(body.dataUrl)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("still delivers a fallback frame with the reason when the rendered canvas cannot be encoded", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, true));
    const { result, body } = await captureOnce(fetchMock);

    expect(result.uploaded).toBe(true);
    expect(result.failed).toBe(false);
    expect(body.capture.source).toBe("fallback");
    expect(String(body.capture.failureReason)).toContain("Tainted");
    expect(String(body.dataUrl)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("returns an encode failure when even the fallback canvas cannot be exported", async () => {
    HTMLCanvasElement.prototype.toBlob = function () {
      throw securityError();
    };
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));

    const { result } = await captureOnce(fetchMock);

    expect(result.uploaded).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failureStage).toBe("encode");
    expect(result.failureReason).toContain("Tainted");
  });

  it("never uploads a fast frame above the fast transport encoding cap", async () => {
    encodedBlobSize = 600_000;
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));

    const { result, upload } = await captureOnce(fetchMock, true);

    expect(result.uploaded).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failureStage).toBe("encode");
    expect(upload).toBeUndefined();
  });

  it("returns the upload status when the HTTP recovery endpoint rejects a frame", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    fetchMock.mockResolvedValue({ ok: false, status: 413 });

    const { result } = await captureOnce(fetchMock);

    expect(result.uploaded).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failureStage).toBe("upload");
    expect(result.failureReason).toBe("Screen-feed WebSocket transport is not ready.");
  });

  it("reports how long the capture cost so the caller can pace itself", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    const { result } = await captureOnce(fetchMock);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });

  it("encodes a successful frame once and reuses that JPEG for HTTP recovery", async () => {
    let blobEncodeCalls = 0;
    let dataUrlEncodeCalls = 0;
    HTMLCanvasElement.prototype.toBlob = function (_callback, type) {
      blobEncodeCalls += 1;
      _callback(new Blob([new Uint8Array(encodedBlobSize)], { type: type || "image/jpeg" }));
    };
    HTMLCanvasElement.prototype.toDataURL = function () {
      dataUrlEncodeCalls += 1;
      return "data:image/jpeg;base64,AAAA";
    };
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));

    await captureOnce(fetchMock);

    expect(blobEncodeCalls).toBe(1);
    expect(dataUrlEncodeCalls).toBe(0);
  });

  it("sanitizes the clone without a per-element computed-style walk", async () => {
    let computedCalls = -1;
    let selectors: string[] = [];
    html2canvas.mockImplementation(async (_element, options: { onclone?: (doc: Document) => void }) => {
      const computed = vi.spyOn(window, "getComputedStyle");
      const originalDocument = Document.prototype.querySelectorAll;
      const originalElement = Element.prototype.querySelectorAll;
      selectors = [];
      const track = function (this: Document | Element, selector: string) {
        selectors.push(String(selector));
        const original = this instanceof Element ? originalElement : originalDocument;
        return original.call(this, selector);
      };
      Document.prototype.querySelectorAll = track as Document["querySelectorAll"];
      Element.prototype.querySelectorAll = track as Element["querySelectorAll"];

      try {
        options.onclone?.(document);
        computedCalls = computed.mock.calls.length;
      } finally {
        Document.prototype.querySelectorAll = originalDocument;
        Element.prototype.querySelectorAll = originalElement;
        computed.mockRestore();
      }
      return makeCanvas(1200, 800, false);
    });

    await captureOnce(fetchMock);
    expect(computedCalls).toBe(0);
    expect(selectors).not.toContain("*");
    expect(selectors.some((selector) => selector.includes("svg *"))).toBe(false);
  });

  it("still strips unsafe images from the cloned document", async () => {
    let strippedSrc: string | null = "not-run";
    html2canvas.mockImplementation(async (_element, options: { onclone?: (doc: Document) => void }) => {
      const img = document.createElement("img");
      img.setAttribute("src", "https://evil.example.com/x.png");
      document.body.appendChild(img);
      options.onclone?.(document);
      strippedSrc = img.getAttribute("src");
      img.remove();
      return makeCanvas(1200, 800, false);
    });

    await captureOnce(fetchMock);
    expect(strippedSrc).toBeNull();
  });
  describe("cancellation, change detection and retries", () => {
    const base = () => ({
      fast: false,
      lastSignature: null as string | null,
      lastUploadedClickTs: 0,
      cursor: null,
      expectedPath: window.location.href,
      clicks: [] as Array<{ x: number; y: number; label: string; ts: number }>,
      scrollElements: [] as HTMLElement[],
      shouldContinue: () => true,
    });
    const uploads = () =>
      fetchMock.mock.calls.filter((call) => call[0] === "/api/screen-feed" && call[1]?.method === "POST");

    it("cancels before rendering when capture should stop", async () => {
      const result = await captureAndUploadScreenFrame({ ...base(), shouldContinue: () => false });

      expect(result).toMatchObject({ cancelled: true, uploaded: false, failed: false });
      expect(html2canvas).not.toHaveBeenCalled();
    });

    it("discards a frame when the page navigated while it rendered", async () => {
      const start = window.location.href;
      html2canvas.mockImplementation(async () => {
        window.history.replaceState({}, "", "/elsewhere");
        return makeCanvas(1200, 800, false);
      });

      const result = await captureAndUploadScreenFrame({ ...base(), expectedPath: start });
      window.history.replaceState({}, "", start);

      expect(result.cancelled).toBe(true);
      expect(uploads()).toHaveLength(0);
    });

    it("skips an unchanged frame unless a newer click must be shown", async () => {
      html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
      const first = await captureAndUploadScreenFrame(base());
      expect(first.signature).toBeTruthy();

      const same = await captureAndUploadScreenFrame({ ...base(), lastSignature: first.signature });
      expect(same).toMatchObject({ unchanged: true, uploaded: false, signature: first.signature });
      expect(uploads()).toHaveLength(1);

      const click = { x: 0.5, y: 0.5, label: "Save", ts: Date.now() };
      const clicked = await captureAndUploadScreenFrame({
        ...base(),
        lastSignature: first.signature,
        clicks: [click, { ...click, ts: 1 }],
      });
      expect(clicked).toMatchObject({ uploaded: true, latestClickTs: click.ts });
      expect(JSON.parse(uploads()[1][1].body).clicks).toHaveLength(1);
    });

    it("retries a failed render at lower cost, then falls back with both reasons", async () => {
      html2canvas.mockRejectedValueOnce(new Error("bad css")).mockResolvedValueOnce(makeCanvas(600, 400, false));
      const { body } = await captureOnce(fetchMock);
      expect(body.capture).toMatchObject({ source: "retry", failureReason: "bad css" });
      const retryOptions = html2canvas.mock.calls[1][1] as { scale: number; foreignObjectRendering: boolean };
      expect(retryOptions.scale).toBeLessThanOrEqual(0.5);
      expect(retryOptions.foreignObjectRendering).toBe(false);

      fetchMock.mockClear();
      html2canvas.mockReset().mockRejectedValueOnce(new Error("bad css")).mockRejectedValueOnce("still bad");
      const fallback = await captureOnce(fetchMock);
      expect(fallback.body.capture).toMatchObject({ source: "fallback", failureReason: "bad css; retry: still bad" });
    });

    it("does not retry a render that timed out", async () => {
      html2canvas.mockRejectedValue(new Error("timeout-render"));

      const { body } = await captureOnce(fetchMock);

      expect(html2canvas).toHaveBeenCalledTimes(1);
      expect(body.capture).toMatchObject({ source: "fallback", failureReason: "timeout-render" });
    });

    it("copies live form values and scroll positions into the rendered clone", async () => {
      document.body.innerHTML = `
        <input id="name" /><input id="flag" type="checkbox" checked />
        <textarea id="note"></textarea>
        <select id="pick"><option value="a">A</option><option value="b">B</option></select>
        <div contenteditable="true" id="rich"></div>
        <div id="list" style="overflow:auto"></div>`;
      (document.getElementById("name") as HTMLInputElement).value = "Typed";
      (document.getElementById("flag") as HTMLInputElement).checked = false;
      (document.getElementById("note") as HTMLTextAreaElement).value = "Line";
      (document.getElementById("pick") as HTMLSelectElement).value = "b";
      document.getElementById("rich")!.innerHTML = "<b>Bold</b>";
      const list = document.getElementById("list")!;
      list.scrollTop = 120;
      let clone: Document | null = null;
      html2canvas.mockImplementation(async (_element, options: { onclone?: (doc: Document) => void }) => {
        clone = document.implementation.createHTMLDocument("clone");
        clone.body.innerHTML = document.body.innerHTML;
        options.onclone?.(clone);
        return makeCanvas(1200, 800, false);
      });

      await captureAndUploadScreenFrame({ ...base(), scrollElements: [list] });

      const copy = clone!;
      expect((copy.getElementById("name") as HTMLInputElement).value).toBe("Typed");
      expect(copy.getElementById("flag")!.hasAttribute("checked")).toBe(false);
      expect(copy.getElementById("note")!.textContent).toBe("Line");
      expect((copy.getElementById("pick") as HTMLSelectElement).value).toBe("b");
      expect(copy.getElementById("rich")!.innerHTML).toBe("<b>Bold</b>");
      expect(copy.getElementById("list")!.scrollTop).toBe(120);
      // The original page keeps no capture bookkeeping.
      expect(list.getAttributeNames().some((name) => name.startsWith("data-") && name !== "contenteditable")).toBe(
        false
      );
      document.body.innerHTML = "";
    });
  });
});
