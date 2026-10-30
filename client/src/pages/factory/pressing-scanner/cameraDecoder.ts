/**
 * Continuous camera barcode decoding with two engines:
 *
 * 1. The browser's native `BarcodeDetector` (Android Chrome, some desktops),
 *    which is hardware accelerated and used when it reports usable formats.
 * 2. A bundled, version-pinned ZXing decoder (`@zxing/browser`), loaded on
 *    demand for browsers without native support — notably iOS Safari — so
 *    automatic scanning works cross-platform. No remote CDN script is used.
 *
 * When neither engine can run, the scanner shows an explicit manual-entry
 * fallback; it never pretends automatic decoding is active.
 */
export const PRESSING_FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"] as const;
export type PressingBarcodeFormat = (typeof PRESSING_FORMATS)[number];
export type CameraDecoderEngine = "native" | "zxing";

export interface DetectedBarcode {
  rawValue: string;
}
export interface CameraBarcodeDecoder {
  readonly engine: CameraDecoderEngine;
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
  dispose(): void;
}

interface BrowserBarcodeDetector {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type DetectorConstructor = {
  new (options?: { formats?: string[] }): BrowserBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

/** Longest edge handed to the bundled decoder; larger frames cost CPU without helping 1D reads. */
const ZXING_MAX_EDGE = 1024;

export function hasCameraAccess(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}
export function hasNativeBarcodeDetector(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector === "function";
}

export async function createNativeCameraDecoder(): Promise<CameraBarcodeDecoder | null> {
  if (!hasNativeBarcodeDetector()) return null;
  const Detector = (window as unknown as { BarcodeDetector: DetectorConstructor }).BarcodeDetector;
  try {
    // Runtime support can be narrower than the global interface advertises
    // (desktop Linux Chrome exposes the class but no formats).
    const supportedFormats = Detector.getSupportedFormats
      ? await Detector.getSupportedFormats()
      : [...PRESSING_FORMATS];
    const selected = PRESSING_FORMATS.filter((format) => supportedFormats.includes(format));
    // Some browsers report a native detector that only understands QR codes.
    // Factory labels are Code 128, so using that QR-only detector would make
    // every bale scan appear to hang forever rather than trying ZXing.
    if (!selected.includes("code_128")) return null;
    const detector = new Detector({ formats: selected });
    return {
      engine: "native",
      detect: (source) => detector.detect(source),
      dispose: () => {},
    };
  } catch {
    return null;
  }
}

/**
 * Bundled ZXing decoder. The library is imported dynamically so the main
 * bundle does not pay for it on devices with a native detector.
 */
export async function createBundledCameraDecoder(): Promise<CameraBarcodeDecoder | null> {
  if (typeof document === "undefined") return null;
  try {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
      import("@zxing/browser"),
      import("@zxing/library"),
    ]);
    const formats = [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.QR_CODE,
    ];
    const hints = new Map<unknown, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    // TRY_HARDER roughly doubles decode time per frame; the continuous loop
    // already retries every poll, so prefer responsiveness.
    hints.set(DecodeHintType.TRY_HARDER, false);
    const reader = new BrowserMultiFormatReader(hints as Map<never, never>);
    let canvas: HTMLCanvasElement | null = document.createElement("canvas");
    let attempts = 0;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    return {
      engine: "zxing",
      async detect(video) {
        if (!canvas) return [];
        const width = video.videoWidth,
          height = video.videoHeight;
        if (!width || !height) return [];
        // Barcode labels are normally held inside the visible targeting box.
        // Decode its middle band on most frames (far fewer pixels to process),
        // but periodically scan the full image so off-centre codes still work.
        const fullFrame = ++attempts % 5 === 0;
        const top = fullFrame ? 0 : Math.floor(height * 0.22);
        const captureHeight = fullFrame ? height : Math.max(1, Math.floor(height * 0.56));
        const scale = Math.min(1, ZXING_MAX_EDGE / Math.max(width, captureHeight));
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(captureHeight * scale));
        if (canvas.width !== targetWidth) canvas.width = targetWidth;
        if (canvas.height !== targetHeight) canvas.height = targetHeight;
        context.drawImage(video, 0, top, width, captureHeight, 0, 0, targetWidth, targetHeight);
        try {
          const result = reader.decodeFromCanvas(canvas);
          const text = result?.getText?.();
          return text ? [{ rawValue: text }] : [];
        } catch {
          // ZXing throws NotFoundException for frames without a barcode.
          return [];
        }
      },
      dispose() {
        canvas = null;
      },
    };
  } catch {
    return null;
  }
}

export async function createCameraDecoder(): Promise<CameraBarcodeDecoder | null> {
  return (await createNativeCameraDecoder()) ?? (await createBundledCameraDecoder());
}
