import { afterEach, describe, expect, it, vi } from "vitest";
import { createCameraDecoder, hasCameraAccess, hasNativeBarcodeDetector, PRESSING_FORMATS } from "./cameraDecoder";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("factory camera decoder", () => {
  it("provides a safe manual-entry fallback if native decoding is absent", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    expect(hasNativeBarcodeDetector()).toBe(false);
    expect(await createCameraDecoder()).toBeNull();
  });

  it("supports Code 128 bale labels when exposed by the browser", async () => {
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
    expect(decoder).not.toBeNull();
    expect(constructor).toHaveBeenCalledWith({ formats: ["code_128", "qr_code"] });
    expect(await decoder!.detect(document.createElement("video"))).toEqual([{ rawValue: "REF300208" }]);
  });

  it("does not request unsupported barcode formats", async () => {
    class MockDetector {
      static getSupportedFormats = async () => ["invalid-format"];
      constructor() { throw new Error("No supported formats"); }
    }
    vi.stubGlobal("BarcodeDetector", MockDetector);
    expect(await createCameraDecoder()).toBeNull();
    expect(PRESSING_FORMATS).toContain("code_128");
  });

  it("detects if mediaDevices are not accessible", () => {
    const accessible = hasCameraAccess();
    expect(typeof accessible).toBe("boolean");
  });
});
