import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const zxingBrowser = vi.hoisted(() => ({
  decodeFromCanvas: vi.fn(),
  constructed: vi.fn(),
}));
vi.mock("@zxing/browser", () => {
  class BrowserMultiFormatReader {
    constructor(hints?: Map<unknown, unknown>) {
      zxingBrowser.constructed(hints);
    }
    decodeFromCanvas(canvas: HTMLCanvasElement) {
      return zxingBrowser.decodeFromCanvas(canvas);
    }
  }
  return { BrowserMultiFormatReader };
});
vi.mock("@zxing/library", () => ({
  BarcodeFormat: { CODE_128: 4, CODE_39: 2, EAN_13: 7, EAN_8: 6, UPC_A: 14, UPC_E: 15, QR_CODE: 11 },
  DecodeHintType: { POSSIBLE_FORMATS: 2, TRY_HARDER: 3 },
}));

import {
  createBundledCameraDecoder,
  createCameraDecoder,
  createNativeCameraDecoder,
  hasCameraAccess,
  hasNativeBarcodeDetector,
  PRESSING_FORMATS,
} from "./cameraDecoder";

function fakeVideo(width = 640, height = 480): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  return video;
}
let drawImage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  zxingBrowser.decodeFromCanvas.mockReset();
  zxingBrowser.constructed.mockReset();
  drawImage = vi.fn();
  // jsdom has no canvas implementation; model the 2D context the decoder needs.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("factory camera decoder", () => {
  it("falls back to the bundled ZXing engine when native decoding is absent (iPhone Safari)", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    expect(hasNativeBarcodeDetector()).toBe(false);
    expect(await createNativeCameraDecoder()).toBeNull();
    zxingBrowser.decodeFromCanvas.mockReturnValue({ getText: () => "REF300208" });
    const decoder = await createCameraDecoder();
    expect(decoder?.engine).toBe("zxing");
    expect(zxingBrowser.constructed).toHaveBeenCalledTimes(1);
    const hints = zxingBrowser.constructed.mock.calls[0][0] as Map<number, unknown>;
    expect(hints.get(2)).toEqual([4, 2, 7, 6, 14, 15, 11]);
    expect(hints.get(3)).toBe(false);
    expect(await decoder!.detect(fakeVideo())).toEqual([{ rawValue: "REF300208" }]);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("downscales large frames for the bundled decoder and treats NotFound as no barcode", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    zxingBrowser.decodeFromCanvas.mockImplementation(() => {
      throw new Error("NotFoundException");
    });
    const decoder = await createBundledCameraDecoder();
    expect(await decoder!.detect(fakeVideo(2560, 1440))).toEqual([]);
    const canvas = zxingBrowser.decodeFromCanvas.mock.calls[0][0] as HTMLCanvasElement;
    expect(canvas.width).toBe(1024);
    // Most frames only decode the center band, reducing work on high-res phones.
    expect(canvas.height).toBe(322);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 316, 2560, 806, 0, 0, 1024, 322);
    // A frame without dimensions (video not ready) is skipped, never decoded.
    expect(await decoder!.detect(fakeVideo(0, 0))).toEqual([]);
    expect(zxingBrowser.decodeFromCanvas).toHaveBeenCalledTimes(1);
    decoder!.dispose();
    expect(await decoder!.detect(fakeVideo())).toEqual([]);
  });

  it("occasionally reads the full frame for off-centre barcodes", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    zxingBrowser.decodeFromCanvas.mockReturnValue(null);
    const decoder = await createBundledCameraDecoder();
    const video = fakeVideo(2560, 1440);
    for (let i = 0; i < 5; i++) await decoder!.detect(video);
    expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 2560, 1440, 0, 0, 1024, 576);
    decoder!.dispose();
  });

  it("falls back to ZXing when the native detector only supports QR and cannot read Code 128 labels", async () => {
    class QRDetector {
      static getSupportedFormats = async () => ["qr_code"];
      async detect() {
        return [{ rawValue: "NEVER_USE_QR_ONLY_DETECTOR" }];
      }
    }
    vi.stubGlobal("BarcodeDetector", QRDetector);
    expect(await createNativeCameraDecoder()).toBeNull();
    const decoder = await createCameraDecoder();
    expect(decoder?.engine).toBe("zxing");
    decoder?.dispose();
  });

  it("reports manual-only when neither engine can start", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    zxingBrowser.constructed.mockImplementation(() => {
      throw new Error("decoder bundle unavailable");
    });
    expect(await createCameraDecoder()).toBeNull();
  });

  it("prefers the native detector and only its supported bale formats", async () => {
    const constructor = vi.fn();
    class MockDetector {
      static getSupportedFormats = vi.fn(async () => ["code_128", "qr_code"]);
      constructor(options: { formats?: string[] }) {
        constructor(options);
      }
      async detect() {
        return [{ rawValue: "REF300208" }];
      }
    }
    vi.stubGlobal("BarcodeDetector", MockDetector);
    expect(hasNativeBarcodeDetector()).toBe(true);
    const decoder = await createCameraDecoder();
    expect(decoder?.engine).toBe("native");
    expect(constructor).toHaveBeenCalledWith({ formats: ["code_128", "qr_code"] });
    expect(zxingBrowser.constructed).not.toHaveBeenCalled();
    expect(await decoder!.detect(fakeVideo())).toEqual([{ rawValue: "REF300208" }]);
  });

  it("skips a native detector that exposes no usable formats (desktop Linux Chrome)", async () => {
    class MockDetector {
      static getSupportedFormats = async () => ["invalid-format"];
      constructor() {
        throw new Error("No supported formats");
      }
    }
    vi.stubGlobal("BarcodeDetector", MockDetector);
    zxingBrowser.decodeFromCanvas.mockReturnValue(null);
    expect(await createNativeCameraDecoder()).toBeNull();
    const decoder = await createCameraDecoder();
    expect(decoder?.engine).toBe("zxing");
    expect(PRESSING_FORMATS).toContain("code_128");
  });

  it("detects if mediaDevices are not accessible", () => {
    expect(typeof hasCameraAccess()).toBe("boolean");
  });
});
