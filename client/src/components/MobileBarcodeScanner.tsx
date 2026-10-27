import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  createCameraDecoder,
  hasCameraAccess,
  type CameraBarcodeDecoder,
} from "@/pages/factory/pressing-scanner/cameraDecoder";
import { ContinuousScanGate } from "@/pages/factory/pressing-scanner/continuousScanGate";

interface MobileBarcodeScannerProps {
  onScan: (barcode: string) => void;
  disabled?: boolean;
  /** A page's existing manual/hardware handler is always the authority. */
  className?: string;
}

/**
 * Shared barcode reader for ERP and Factory. Nothing is saved here: camera
 * reads travel through exactly the same page-specific handler as manual scans.
 * The decoder is native when supported, with lazily loaded ZXing for iOS Safari.
 */
export function MobileBarcodeScanner({ onScan, disabled = false, className }: MobileBarcodeScannerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDetected, setLastDetected] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanHandler = useRef(onScan);
  const disabledRef = useRef(disabled);
  scanHandler.current = onScan;
  disabledRef.current = disabled;

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | undefined;
    let decoder: CameraBarcodeDecoder | null = null;
    // Re-presenting the same retail item should count again after a brief removal;
    // suppress duplicate frames while leaving different barcodes immediately scannable.
    const gate = new ContinuousScanGate(1200, 2);

    const tick = async () => {
      if (canceled) return;
      // Pause reads during existing page mutations without stopping the stream
      // or consuming a barcode that has not yet been submitted.
      if (disabledRef.current) {
        timeout = setTimeout(() => void tick(), 220);
        return;
      }
      const video = videoRef.current;
      if (video?.readyState && video.readyState >= 2 && decoder) {
        try {
          const matches = await decoder.detect(video);
          if (canceled) return;
          const code = gate.frame(matches.find((match) => match.rawValue?.trim())?.rawValue, Date.now());
          if (code) {
            setLastDetected(code);
            scanHandler.current(code);
          }
        } catch {
          // A blurry or incomplete frame is normal; try the next frame.
        }
      } else {
        gate.frame(null, Date.now());
      }
      if (!canceled) timeout = setTimeout(() => void tick(), 220);
    };

    const start = async () => {
      if (!hasCameraAccess()) {
        setError("Camera access requires HTTPS and a supported browser. Use the existing manual scanner.");
        return;
      }
      try {
        decoder = await createCameraDecoder();
        if (canceled) return;
        if (!decoder) {
          setError("Barcode decoding is unavailable on this device. Enter the barcode manually.");
          return;
        }
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (canceled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        const video = videoRef.current;
        if (!video) throw new Error("Camera preview could not open.");
        video.srcObject = acquired;
        await video.play();
        if (!canceled) void tick();
      } catch (cause) {
        if (canceled) return;
        const name = cause instanceof DOMException ? cause.name : "";
        setError(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Camera permission denied. Allow access in your browser settings or enter the code manually."
            : name === "NotFoundError"
              ? "No camera was found on this device. Use manual entry."
              : cause instanceof Error ? cause.message : "Unable to open camera. Use manual entry.",
        );
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) setOpen(false);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void start();
    return () => {
      canceled = true;
      if (timeout) clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      decoder?.dispose();
      gate.reset();
    };
  }, [open]);

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={disabled}
        className={className}
        title="Scan with phone camera"
        aria-label="Scan with camera"
        data-testid="button-mobile-camera-scan"
        onClick={() => {
          setError(null);
          setLastDetected("");
          setOpen(true);
        }}
      >
        <Camera className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>Scan with camera</DialogTitle>
            <DialogDescription>Point the rear camera at a barcode. The camera stays open for the next item.</DialogDescription>
          </DialogHeader>
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label="Live barcode camera"
              className="aspect-[4/3] w-full object-cover"
            />
            <div className="pointer-events-none absolute inset-[18%] rounded-md border-2 border-emerald-400/80" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {lastDetected && <p role="status" className="break-all text-sm">Last detected: {lastDetected}</p>}
          <p className="text-xs text-muted-foreground">Close this window to stop the camera. Manual and hardware scanners still work.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
