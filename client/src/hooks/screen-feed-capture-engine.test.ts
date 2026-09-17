import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html2canvas = vi.fn();
vi.mock("html2canvas", () => ({ default: (...args: unknown[]) => html2canvas(...args) }));

const sendScreenFeedBinaryFrame = vi.fn();
vi.mock("@/lib/screen-feed-binary-transport", () => ({
  sendScreenFeedBinaryFrame: (...args: unknown[]) => sendScreenFeedBinaryFrame(...args),
}));

import { captureAndUploadScreenFrame } from "./screen-feed-capture-engine";

/**
 * jsdom ships no 2D canvas implementation, so the engine is exercised against a
 * stub that reproduces the one browser behaviour this suite is about: a canvas
 * that consumed tainted pixels refuses to be exported. The engine encodes with
 * toBlob and ships the result over the binary transport, so both are stubbed
 * here rather than the HTTP frame upload the viewer used before Phase 13-14.
 */
const taintedCanvases = new WeakSet<HTMLCanvasElement>();

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

/** Bytes every stubbed encode produces unless a test overrides toBlob itself. */
const ENCODED_BYTES = 1024;

function jpegBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

function installCanvasStubs(): void {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return stubContext(this);
  } as unknown as HTMLCanvasElement["getContext"];

  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
    if (taintedCanvases.has(this)) throw securityError();
    callback(jpegBlob(ENCODED_BYTES));
  } as unknown as HTMLCanvasElement["toBlob"];
}

function makeCanvas(width: number, height: number, tainted: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  if (tainted) taintedCanvases.add(canvas);
  return canvas;
}

function captureOnce(fast = false) {
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
    const header = sendScreenFeedBinaryFrame.mock.calls[0]?.[0] as
      { metadata?: { capture?: Record<string, unknown> } } | undefined;
    return { result, capture: header?.metadata?.capture ?? {} };
  });
}

describe("screen feed capture engine", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installCanvasStubs();
    (globalThis as { CanvasRenderingContext2D?: unknown }).CanvasRenderingContext2D = class {
      createPattern() {
        return null;
      }
    };
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    html2canvas.mockReset();
    sendScreenFeedBinaryFrame.mockReset();
    sendScreenFeedBinaryFrame.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never renders through foreignObject, whose output cannot be encoded", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    await captureOnce();

    const options = html2canvas.mock.calls[0]?.[1] as { foreignObjectRendering?: boolean };
    expect(options.foreignObjectRendering).toBe(false);
  });

  it("uploads a normal capture as a dom frame", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    const { result, capture } = await captureOnce();

    expect(result.uploaded).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.failureStage).toBeUndefined();
    expect(result.failureReason).toBeUndefined();
    expect(capture.source).toBe("dom");
    expect(capture.failureReason).toBeUndefined();
    // The JPEG travels as the packet payload, never inline in the header.
    expect((sendScreenFeedBinaryFrame.mock.calls[0]?.[1] as Blob).type).toBe("image/jpeg");
  });

  it("still delivers a frame, with the reason, when the rendered canvas cannot be encoded", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, true));
    const { result, capture } = await captureOnce();

    // The watcher must never be left on an empty viewer with no explanation
    // while the watched browser silently re-renders the page forever.
    expect(result.uploaded).toBe(true);
    expect(result.failed).toBe(false);
    expect(capture.source).toBe("fallback");
    expect(String(capture.failureReason)).toContain("Tainted");
  });

  it("returns an encode failure when even the fallback canvas cannot be exported", async () => {
    HTMLCanvasElement.prototype.toBlob = function () {
      throw securityError();
    } as unknown as HTMLCanvasElement["toBlob"];
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));

    const { result } = await captureOnce();

    expect(result.uploaded).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failureStage).toBe("encode");
    expect(result.failureReason).toContain("Tainted");
  });

  it("never uploads a fast frame above the fast transport encoding cap", async () => {
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
      callback(jpegBlob(600_000));
    } as unknown as HTMLCanvasElement["toBlob"];
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));

    const { result } = await captureOnce(true);

    expect(result.uploaded).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failureStage).toBe("encode");
    expect(sendScreenFeedBinaryFrame).not.toHaveBeenCalled();
  });

  it("returns the upload status when the transport cannot ship the frame", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    sendScreenFeedBinaryFrame.mockResolvedValue(false);

    const { result } = await captureOnce();

    expect(result.uploaded).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failureStage).toBe("upload");
    expect(result.failureReason).toBe("Screen-feed WebSocket transport is not ready.");
  });

  it("reports how long the capture cost so the caller can pace itself", async () => {
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));
    const { result } = await captureOnce();

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });

  it("encodes a successful frame in a single toBlob pass", async () => {
    let encodeCalls = 0;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
      encodeCalls += 1;
      callback(jpegBlob(ENCODED_BYTES));
    } as unknown as HTMLCanvasElement["toBlob"];
    html2canvas.mockResolvedValue(makeCanvas(1200, 800, false));

    await captureOnce();

    expect(encodeCalls).toBe(1);
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

    await captureOnce();
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

    await captureOnce();
    expect(strippedSrc).toBeNull();
  });
});
