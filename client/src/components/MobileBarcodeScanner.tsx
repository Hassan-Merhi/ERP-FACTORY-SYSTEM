import { AlertTriangle, Camera, CheckCircle2, Flashlight, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { translateCameraScanTitle } from "@/i18n/mobileCameraScanTranslations";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMobileBarcodeScannerState, type MobileBarcodeScannerProps } from "./useMobileBarcodeScannerState";
export type { CameraScanFeedback } from "./useMobileBarcodeScannerState";

/**
 * Shared barcode reader for ERP and Factory. Nothing is saved here: camera
 * reads travel through exactly the same page-specific handler as manual scans.
 * The decoder is native when supported, with lazily loaded ZXing for iOS Safari.
 */
export function MobileBarcodeScanner({
  onScan,
  disabled = false,
  className,
  feedback = null,
}: MobileBarcodeScannerProps) {
  const {
    language,
    setOpen,
    open,
    setRetryAttempt,
    setError,
    error,
    setLastDetected,
    lastDetected,
    setVisibleFeedback,
    visibleFeedback,
    seenFeedbackRef,
    setTorchAvailable,
    torchAvailable,
    setTorchOn,
    torchOn,
    videoRef,
    toggleTorch,
  } = useMobileBarcodeScannerState({ onScan, disabled, feedback });

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
          setVisibleFeedback(null);
          seenFeedbackRef.current = feedback;
          setTorchOn(false);
          setTorchAvailable(false);
          setOpen(true);
        }}
      >
        <Camera className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>Scan with camera</DialogTitle>
            <DialogDescription>
              Point the rear camera at a barcode. The camera stays open for the next item.
            </DialogDescription>
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
            {visibleFeedback && (
              <div
                className="pointer-events-none absolute inset-x-2 bottom-2 z-10"
                role="status"
                aria-live="polite"
                data-testid="camera-scan-result-popup"
              >
                <div
                  className={`rounded-xl border-2 p-3 text-white shadow-2xl ${
                    visibleFeedback.type === "success"
                      ? "border-emerald-300 bg-emerald-700"
                      : visibleFeedback.type === "duplicate"
                        ? "border-red-300 bg-red-700"
                        : visibleFeedback.type === "warn"
                          ? "border-amber-200 bg-amber-500 text-amber-950"
                          : "border-red-300 bg-red-700"
                  }`}
                >
                  <div className="flex items-center gap-2 text-base font-black uppercase tracking-wide">
                    {visibleFeedback.type === "success" ? (
                      <CheckCircle2 className="h-6 w-6 shrink-0" />
                    ) : visibleFeedback.type === "warn" ? (
                      <AlertTriangle className="h-6 w-6 shrink-0" />
                    ) : (
                      <XCircle className="h-6 w-6 shrink-0" />
                    )}
                    <span>{translateCameraScanTitle(visibleFeedback.type, language)}</span>
                  </div>
                  <div className="mt-1 break-all font-mono text-sm font-semibold">
                    {visibleFeedback.referenceNumber}
                  </div>
                  <div className="mt-1 text-sm font-medium leading-snug">{visibleFeedback.message}</div>
                </div>
              </div>
            )}
          </div>
          {torchAvailable && !error && (
            <Button type="button" variant="outline" size="sm" onClick={() => void toggleTorch()}>
              <Flashlight className="mr-2 h-4 w-4" />
              {torchOn ? "Turn off light" : "Turn on light"}
            </Button>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => {
                  setError(null);
                  setTorchAvailable(false);
                  setTorchOn(false);
                  setRetryAttempt((attempt) => attempt + 1);
                }}
                data-testid="button-mobile-camera-retry"
              >
                Retry camera
              </Button>
            </div>
          )}
          {lastDetected && (
            <p role="status" className="break-all text-sm">
              Last detected: {lastDetected}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Close this window to stop the camera. Manual and hardware scanners still work.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
