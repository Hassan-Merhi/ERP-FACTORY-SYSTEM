import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { hasCameraAccess } from "@/pages/factory/pressing-scanner/cameraDecoder";

/** Native Android detection OR bundled ZXing on iPhone Safari. */
export const cameraScanningSupported = hasCameraAccess;

/** Kept as a compatibility alias for existing Retail POS screens. */
export function RetailCameraScanner({ onScan }: { onScan: (barcode: string) => void }) {
  return <MobileBarcodeScanner onScan={onScan} />;
}
