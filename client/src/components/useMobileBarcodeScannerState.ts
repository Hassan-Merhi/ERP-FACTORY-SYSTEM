// Extracted from ./MobileBarcodeScanner.tsx
import { useEffect, useRef, useState } from "react";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import {
  createCameraDecoder,
  hasCameraAccess,
  type CameraBarcodeDecoder,
} from "@/pages/factory/pressing-scanner/cameraDecoder";
import { ContinuousScanGate } from "@/pages/factory/pressing-scanner/continuousScanGate";
import { pauseSeasonalEffectsForCamera } from "@/lib/seasonalCameraActivity";

export interface CameraScanFeedback {
  type: "success" | "duplicate" | "warn" | "error";
  referenceNumber: string;
  message: string;
}

export interface MobileBarcodeScannerProps {
  /** Server-confirmed result, displayed above the camera preview. */
  feedback?: CameraScanFeedback | null;
  onScan: (barcode: string) => void;
  disabled?: boolean;
  /** A page's existing manual/hardware handler is always the authority. */
  className?: string;
}

export function useMobileBarcodeScannerState({
  onScan,
  disabled = false,
  feedback = null,
}: Pick<MobileBarcodeScannerProps, "onScan" | "disabled" | "feedback">) {
  // Shared scanner: tolerate rendering outside the language provider.
  const language = useOptionalApplicationLanguage()?.language ?? "en";
  const [open, setOpen] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastDetected, setLastDetected] = useState("");
  const [visibleFeedback, setVisibleFeedback] = useState<CameraScanFeedback | null>(null);
  const seenFeedbackRef = useRef<CameraScanFeedback | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanHandler = useRef(onScan);
  const disabledRef = useRef(disabled);
  scanHandler.current = onScan;
  disabledRef.current = disabled;

  // Page-level banners/toasts sit behind the camera dialog. Surface the latest
  // server result inside that dialog, without closing or pausing the camera.
  // An old result from manual scanning is never replayed when the camera opens.
  useEffect(() => {
    if (!open || !feedback || seenFeedbackRef.current === feedback) return;
    seenFeedbackRef.current = feedback;
    setVisibleFeedback(feedback);
    const timer = setTimeout(() => setVisibleFeedback(null), 2700);
    return () => clearTimeout(timer);
  }, [open, feedback]);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | undefined;
    let decoder: CameraBarcodeDecoder | null = null;
    let cameraTrack: MediaStreamTrack | null = null;
    let resumeSeasonalEffects: (() => void) | null = null;
    const videoElement = videoRef.current;
    const onTrackEnded = () => {
      if (canceled) return;
      // iOS may end the camera track after a fold/orientation change while
      // the page stays visible. Pause reads until an explicit retry.
      canceled = true;
      if (timeout) clearTimeout(timeout);
      decoder?.dispose();
      decoder = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      trackRef.current = null;
      resumeSeasonalEffects?.();
      resumeSeasonalEffects = null;
      if (videoElement) videoElement.srcObject = null;
      setTorchAvailable(false);
      setTorchOn(false);
      setError("Camera interrupted by the browser or screen change. Tap Retry camera to reopen it.");
    };
    // Re-presenting the same retail item should count again after a brief removal;
    // suppress duplicate frames while leaving different barcodes immediately scannable.
    const gate = new ContinuousScanGate(1200, 2);

    const tick = async () => {
      if (canceled) return;
      // Pause reads during existing page mutations without stopping the stream
      // or consuming a barcode that has not yet been submitted.
      if (disabledRef.current) {
        timeout = setTimeout(() => void tick(), 90);
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
      // Schedule only AFTER this decode completes: never overlap expensive
      // ZXing calls, but avoid adding a quarter-second delay to every frame.
      if (!canceled) timeout = setTimeout(() => void tick(), decoder?.engine === "native" ? 70 : 90);
    };

    const start = async () => {
      if (!hasCameraAccess()) {
        setError("Camera access requires HTTPS and a supported browser. Use the existing manual scanner.");
        return;
      }
      try {
        // Start the video BEFORE importing the ZXing fallback. On iPhones the
        // lazy-loaded decoder can take time to download, but camera preview
        // and automatic focusing can already begin in the meantime.
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (canceled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        resumeSeasonalEffects = pauseSeasonalEffectsForCamera();
        const video = videoRef.current;
        if (!video) throw new Error("Camera preview could not open.");
        video.srcObject = acquired;
        await video.play();
        if (canceled) return;
        const track = acquired.getVideoTracks?.()[0];
        if (track) {
          trackRef.current = track;
          cameraTrack = track;
          cameraTrack.addEventListener?.("ended", onTrackEnded);
          try {
            const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
            setTorchAvailable(capabilities?.torch === true);
          } catch {
            /* Flashlight capability is not available on all mobile browsers. */
          }
          if (typeof track.applyConstraints === "function") {
            // Unsupported advanced focus hints are harmless; let the browser
            // retain its current camera settings instead of delaying reads.
            void track
              .applyConstraints({
                advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
              })
              .catch(() => {});
          }
        }
        decoder = await createCameraDecoder();
        if (canceled) {
          decoder?.dispose();
          return;
        }
        if (!decoder) {
          acquired.getTracks().forEach((cameraTrack) => cameraTrack.stop());
          resumeSeasonalEffects?.();
          resumeSeasonalEffects = null;
          setError("Barcode decoding is unavailable on this device. Enter the barcode manually.");
          return;
        }
        void tick();
      } catch (cause) {
        resumeSeasonalEffects?.();
        resumeSeasonalEffects = null;
        if (canceled) return;
        const name = cause instanceof DOMException ? cause.name : "";
        setError(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Camera permission denied. Allow access in your browser settings or enter the code manually."
            : name === "NotFoundError"
              ? "No camera was found on this device. Use manual entry."
              : cause instanceof Error
                ? cause.message
                : "Unable to open camera. Use manual entry."
        );
      }
    };
    const release = () => {
      canceled = true;
      if (timeout) clearTimeout(timeout);
      cameraTrack?.removeEventListener?.("ended", onTrackEnded);
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      trackRef.current = null;
      resumeSeasonalEffects?.();
      resumeSeasonalEffects = null;
      if (videoElement) videoElement.srcObject = null;
      decoder?.dispose();
      decoder = null;
      gate.reset();
    };
    const onSuspend = () => {
      // pagehide can freeze Safari before React effects run. Release the track
      // synchronously, including on back-forward cache transitions.
      release();
      setOpen(false);
    };
    const onVisibilityChange = () => {
      if (document.hidden) onSuspend();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onSuspend);
    void start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onSuspend);
      release();
    };
  }, [open, retryAttempt]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track || typeof track.applyConstraints !== "function") return;
    try {
      const next = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };
  return {
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
  };
}
