// Extracted from ./ContinuousPressingScanner.tsx to keep that module under the source-size cap.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CameraBarcodeDecoder,
  type CameraDecoderEngine,
  createCameraDecoder,
  hasCameraAccess,
} from "./pressing-scanner/cameraDecoder";
import { ContinuousScanGate } from "./pressing-scanner/continuousScanGate";
import { factoryCameraErrorMessage } from "@/factory/scanner/cameraUiErrors";
import { pauseSeasonalEffectsForCamera } from "@/lib/seasonalCameraActivity";
import {
  SCAN_POLL_MS,
  type AudioContextLike,
  type PressingScanCapture,
  type PressingScanOutcome,
  type PressingScannerAssignment,
  type ScanFeedback,
  type ScannerStatus,
  type ScreenWakeLock,
  type ScreenWakeLockNavigator,
  type TorchCapabilities,
  type WebkitAudio,
} from "./ContinuousPressingScannerTypes";

export function useContinuousPressingScannerState({
  assignment,
  active,
  onBarcode,
  simpleControls = false,
}: {
  assignment: PressingScannerAssignment | null;
  active: boolean;
  onBarcode: (capture: PressingScanCapture) => Promise<PressingScanOutcome>;
  simpleControls?: boolean;
}) {
  // The worker's "Open Camera" action mounts this scanner and begins capture.
  // The parent "Close Camera" unmounts it, releasing the camera stream.
  const [requested, setRequested] = useState(simpleControls);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{
    barcode: string;
    at: string;
    outcome: ScanFeedback;
    message: string;
    intervalSeconds: number | null;
    confirmedAt?: string;
    timezoneName?: string;
    weightKg?: string;
    machineName?: string;
    confirmationId?: number;
    productionDate?: string;
    scannedBy?: string;
  } | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [sound, setSound] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [engine, setEngine] = useState<CameraDecoderEngine | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const audioRef = useRef<AudioContextLike | null>(null);
  const gateRef = useRef(new ContinuousScanGate(1500, 3));
  const lastGateAssignmentId = useRef(assignment?.assignmentId);
  useEffect(() => {
    if (lastGateAssignmentId.current !== assignment?.assignmentId) {
      // Switching stations is a new scanning context, unlike a screen-size
      // interruption that should retain the brief duplicate cooldown.
      lastGateAssignmentId.current = assignment?.assignmentId;
      gateRef.current.reset();
    }
  }, [assignment?.assignmentId]);
  // The camera must keep decoding DIFFERENT barcodes during slow HTTP.
  // All captures are persisted individually in IndexedDB before submission.
  const inFlightRef = useRef(0);
  const latestCaptureRef = useRef(0);
  const lastCapturedMsRef = useRef<number | null>(null);
  const onBarcodeRef = useRef(onBarcode);
  const assignmentRef = useRef(assignment);
  const soundRef = useRef(sound);
  const vibrationRef = useRef(vibration);
  onBarcodeRef.current = onBarcode;
  assignmentRef.current = assignment;
  soundRef.current = sound;
  vibrationRef.current = vibration;

  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    const pageHidden = () => setVisible(false);
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", changed);
    };
  }, []);

  const usable = !!assignment?.machineActive && active;
  const running = usable && requested && visible;

  // Audio is initialized as part of an explicit user gesture; browsers that
  // prohibit audio, especially iOS, degrade to the visible feedback.
  const unlockAudio = () => {
    if (audioRef.current) {
      void audioRef.current.resume().catch(() => {});
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as WebkitAudio).webkitAudioContext;
      if (!Ctor) return;
      const context = new Ctor();
      audioRef.current = context;
      void context.resume().catch(() => {});
    } catch {
      /* Visual feedback remains available. */
    }
  };
  const feedback = useCallback((kind: PressingScanOutcome["kind"]) => {
    const frequency = kind === "confirmed" ? 880 : kind === "duplicate" || kind === "rejected" ? 240 : 530;
    const context = audioRef.current;
    if (soundRef.current && context && context.state === "running") {
      try {
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.type = "sine";
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0.001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.135);
        tone.connect(gain);
        gain.connect(context.destination);
        tone.start();
        tone.stop(context.currentTime + 0.14);
      } catch {
        /* Audio feedback is optional. */
      }
    }
    if (vibrationRef.current && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(kind === "duplicate" || kind === "rejected" ? [90, 70, 100] : [45]);
      } catch {
        /* Vibration is not available on all mobile browsers. */
      }
    }
  }, []);

  useEffect(
    () => () => {
      // Closing the tab or unmounting must not leave an AudioContext running.
      void audioRef.current?.close().catch(() => {});
      audioRef.current = null;
    },
    []
  );

  const handleRead = useCallback(
    async (barcode: string, machine: PressingScannerAssignment) => {
      // Cap work in progress to avoid unlimited promise growth on a damaged network.
      // A rejected capacity warning is never presented as a saved or queued scan.
      if (inFlightRef.current >= 32) {
        setLast({
          barcode,
          at: new Date().toISOString(),
          outcome: "rejected",
          message: "Too many reads in progress. Re-present this barcode after pending captures settle.",
          intervalSeconds: null,
        });
        feedback("rejected");
        return;
      }
      inFlightRef.current += 1;
      const sequence = ++latestCaptureRef.current;
      const deviceCapturedAt = new Date().toISOString();
      const now = Date.parse(deviceCapturedAt);
      const intervalSeconds =
        lastCapturedMsRef.current === null ? null : Math.max(0, Math.round((now - lastCapturedMsRef.current) / 1000));
      lastCapturedMsRef.current = now;
      setLast({ barcode, at: deviceCapturedAt, outcome: "processing", message: "Checking barcode…", intervalSeconds });
      try {
        const result = await onBarcodeRef.current({
          barcode,
          deviceCapturedAt,
          assignmentId: machine.assignmentId,
          machineId: machine.machineId,
        });
        if (sequence === latestCaptureRef.current)
          setLast({
            barcode,
            at: deviceCapturedAt,
            outcome: result.kind,
            message: result.message,
            intervalSeconds,
            confirmedAt: result.confirmedAt,
            timezoneName: result.timezoneName,
            weightKg: result.weightKg,
            machineName: result.machineName,
            confirmationId: result.confirmationId,
            productionDate: result.productionDate,
            scannedBy: result.scannedBy,
          });
        feedback(result.kind);
      } catch {
        if (sequence === latestCaptureRef.current)
          setLast({
            barcode,
            at: deviceCapturedAt,
            outcome: "rejected",
            message: "Unable to validate barcode. This item has NOT been confirmed.",
            intervalSeconds,
          });
        feedback("rejected");
      } finally {
        inFlightRef.current -= 1;
      }
    },
    [feedback]
  );

  useEffect(() => {
    // The assignment is read through a ref: the effect re-runs only when the
    // assignment ID changes (dependency below), not on every object identity.
    const currentAssignment = assignmentRef.current;
    const video = videoRef.current;
    const gate = gateRef.current;
    if (!running || !currentAssignment) {
      trackRef.current = null;
      return;
    }
    let canceled = false;
    let stream: MediaStream | null = null;
    let screenLock: ScreenWakeLock | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cameraTrack: MediaStreamTrack | null = null;
    let resumeSeasonalEffects: (() => void) | null = null;
    gateRef.current.suspend();
    setStatus("starting");
    setError(null);
    setTorchAvailable(false);
    setTorchOn(false);
    lastCapturedMsRef.current = null;

    let decoder: CameraBarcodeDecoder | null = null;
    const releaseCamera = () => {
      canceled = true;
      if (timer !== undefined) clearTimeout(timer);
      cameraTrack?.removeEventListener?.("ended", onTrackEnded);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      resumeSeasonalEffects?.();
      resumeSeasonalEffects = null;
      void screenLock?.release().catch(() => {});
      decoder?.dispose();
      decoder = null;
      trackRef.current = null;
      if (video) video.srcObject = null;
      gate.suspend();
    };
    const onTrackEnded = () => {
      if (canceled) return;
      releaseCamera();
      setEngine(null);
      setTorchAvailable(false);
      setTorchOn(false);
      setStatus("error");
      setError("Camera interrupted by a screen change or iOS. Tap Retry camera to restart scanning.");
    };
    // pagehide runs before React cleanup on iOS Safari and in the bfcache.
    const onPageHide = () => releaseCamera();
    const onVisibilitySuspend = () => {
      if (document.hidden) releaseCamera();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilitySuspend);
    const tick = async (detector: CameraBarcodeDecoder) => {
      if (canceled) return;
      const video = videoRef.current;
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          const matches = await detector.detect(video);
          if (canceled) return;
          const value = matches.find((match) => match.rawValue?.trim())?.rawValue ?? null;
          const next = gateRef.current.frame(value, Date.now());
          if (next) void handleRead(next, currentAssignment);
        } catch {
          /* A transient bad frame is not a fatal camera error. */
        }
      }
      if (!canceled) timer = setTimeout(() => void tick(detector), SCAN_POLL_MS[detector.engine]);
    };

    const start = async () => {
      if (!hasCameraAccess()) {
        setStatus("manual");
        setError(
          "Camera access requires a supported browser and a secure (HTTPS) connection. Manual entry stays available."
        );
        return;
      }
      try {
        // Open and focus the camera first. Downloading ZXing on iOS can be
        // slow, but autofocus/preview can start while the decoder loads.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (canceled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        resumeSeasonalEffects = pauseSeasonalEffectsForCamera();
        if (!videoRef.current) throw new Error("Camera preview is not ready");
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (canceled) return;
        const videoTrack = stream.getVideoTracks()[0] ?? null;
        trackRef.current = videoTrack;
        cameraTrack = videoTrack;
        if (videoTrack) {
          videoTrack.addEventListener?.("ended", onTrackEnded);
          const capabilities = videoTrack.getCapabilities?.() as TorchCapabilities | undefined;
          setTorchAvailable(Boolean(capabilities?.torch));
          if (capabilities?.focusMode?.includes("continuous")) {
            void videoTrack
              .applyConstraints({
                advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
              })
              .catch(() => {});
          }
        }
        // Native BarcodeDetector when supported, bundled ZXing on iOS.
        decoder = await createCameraDecoder();
        if (canceled) {
          decoder?.dispose();
          return;
        }
        if (!decoder) {
          stream?.getTracks().forEach((track) => track.stop());
          stream = null;
          resumeSeasonalEffects?.();
          resumeSeasonalEffects = null;
          if (videoRef.current) videoRef.current.srcObject = null;
          setStatus("manual");
          setError("Automatic barcode decoding could not start in this browser. Use manual entry below.");
          return;
        }
        setEngine(decoder.engine);
        setStatus("scanning");
        // Where supported, keep the screen awake during deliberate scanning.
        // Browsers may refuse this request; it is never required for scanning.
        const wakeLock = (navigator as ScreenWakeLockNavigator).wakeLock;
        if (wakeLock && !document.hidden) {
          void wakeLock
            .request("screen")
            .then((lock) => {
              if (canceled) void lock.release().catch(() => {});
              else screenLock = lock;
            })
            .catch(() => {});
        }
        void tick(decoder);
      } catch (cause) {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        resumeSeasonalEffects?.();
        resumeSeasonalEffects = null;
        if (!canceled) {
          setStatus("error");
          setError(factoryCameraErrorMessage(cause));
        }
      }
    };
    void start();
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilitySuspend);
      releaseCamera();
      setEngine(null);
    };
    // Restart only on assignment, explicit start/stop, tab or browser visibility.
    // Callback is read through a ref so status updates never restart the stream.
  }, [running, assignment?.assignmentId, handleRead, retryAttempt]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track || !torchAvailable) return;
    try {
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
      setTorchOn(false);
    }
  };
  const submitManual = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assignment || !running) return;
    const barcode = gateRef.current.manual(manualCode, Date.now());
    if (!barcode) return;
    setManualCode("");
    void handleRead(barcode, assignment);
  };

  const activeStatus = running ? status : "idle";
  const badgeColor =
    last?.outcome === "confirmed"
      ? "bg-emerald-100 text-emerald-900 border-emerald-400"
      : last?.outcome === "rejected" || last?.outcome === "duplicate"
        ? "bg-red-100 text-red-900 border-red-400"
        : "bg-slate-100 text-slate-900 border-slate-400 dark:bg-slate-800 dark:text-slate-100";
  return {
    activeStatus,
    assignment,
    badgeColor,
    engine,
    error,
    last,
    manualCode,
    requested,
    running,
    setLast,
    setManualCode,
    setRequested,
    setRetryAttempt,
    setSound,
    setVibration,
    simpleControls,
    sound,
    submitManual,
    toggleTorch,
    torchAvailable,
    torchOn,
    unlockAudio,
    usable,
    vibration,
    videoRef,
    visible,
  };
}
