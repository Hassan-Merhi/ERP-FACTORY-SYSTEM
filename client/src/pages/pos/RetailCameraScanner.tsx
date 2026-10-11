import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

/** True when the browser can decode barcodes from the camera (Chrome/Edge on Android, recent desktop Chrome). */
export function cameraScanningSupported(): boolean {
  return (
    typeof window !== "undefined" && Boolean(getBarcodeDetector()) && Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * Secondary scanner input using the phone camera. Hardware scanners remain the
 * primary path; this only calls `onScan` with the decoded text, exactly like a
 * hardware scan, so the same lookup and cart rules apply.
 */
export function RetailCameraScanner({ onScan }: { onScan: (barcode: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const Detector = getBarcodeDetector();
    if (!Detector) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const detector = new Detector({ formats: ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "qr_code"] });

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes.find((code) => code.rawValue?.trim())?.rawValue.trim();
            if (value) {
              setOpen(false);
              onScan(value);
              return;
            }
          } catch {
            // Frame not ready yet.
          }
          timer = window.setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Camera unavailable");
      }
    };
    void start();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [open, onScan]);

  if (!cameraScanningSupported()) return null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Scan with camera"
        title="Scan with camera"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Camera className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Scan with camera</DialogTitle>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <video ref={videoRef} className="aspect-4/3 w-full rounded-md bg-black object-cover" muted playsInline />
          )}
          <p className="text-xs text-muted-foreground" data-i18n-ui>
            Hold the label steady inside the frame.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
