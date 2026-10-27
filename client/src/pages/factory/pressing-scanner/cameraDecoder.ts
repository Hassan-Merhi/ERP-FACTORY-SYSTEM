/**
 * Native browser barcode detector (same API currently used in Retail POS).
 * No external scripts, remote CDN, or unversioned runtime dependency.
 * Unsupported browsers are shown an explicit manual-entry fallback.
 */
export const PRESSING_FORMATS = [
  "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code",
] as const;

interface BrowserDetectedBarcode { rawValue: string }
interface BrowserBarcodeDetector {
  detect(source: CanvasImageSource): Promise<BrowserDetectedBarcode[]>;
}
type DetectorConstructor = {
  new(options?: { formats?: string[] }): BrowserBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

export function hasCameraAccess(): boolean {
  return typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
}
export function hasNativeBarcodeDetector(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector === "function";
}
export async function createCameraDecoder(): Promise<BrowserBarcodeDetector | null> {
  if (!hasNativeBarcodeDetector()) return null;
  const Detector = (window as unknown as { BarcodeDetector: DetectorConstructor }).BarcodeDetector;
  try {
    // Runtime support can be narrower than the global interface advertises.
    const supportedFormats = Detector.getSupportedFormats
      ? await Detector.getSupportedFormats()
      : [...PRESSING_FORMATS];
    const selected = PRESSING_FORMATS.filter(format => supportedFormats.includes(format));
    if (!selected.length) return null;
    return new Detector({ formats: selected });
  } catch {
    return null;
  }
}
