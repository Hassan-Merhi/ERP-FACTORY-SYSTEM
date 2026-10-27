import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Flashlight, FlashlightOff, Keyboard, RotateCcw, Volume2, VolumeX, Vibrate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createCameraDecoder, hasCameraAccess, type CameraBarcodeDecoder, type CameraDecoderEngine } from "./pressing-scanner/cameraDecoder";
import { ContinuousScanGate } from "./pressing-scanner/continuousScanGate";

export type PressingScanCapture = {
  barcode: string;
  deviceCapturedAt: string;
  assignmentId: number;
  machineId: number;
};
export type PressingScanOutcome = {
  kind: "confirmed" | "duplicate" | "rejected" | "queued" | "preview";
  message: string;
  confirmedAt?: string;
  confirmationId?: number;
  referenceNumber?: string;
  productionDate?: string;
  timezoneName?: string;
  weightKg?: string;
  machineName?: string;
};
export type PressingScannerAssignment = {
  assignmentId: number;
  machineId: number;
  machineCode: string;
  machineName: string;
  machineActive: boolean;
};
type ScanFeedback = PressingScanOutcome["kind"] | "processing";
type ScannerStatus = "idle" | "starting" | "scanning" | "manual" | "error";

type AudioContextLike = AudioContext & { close(): Promise<void> };
type WebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };
type ScreenWakeLock = { release(): Promise<void> };
type ScreenWakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<ScreenWakeLock> } };

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };

const SCAN_POLL_MS = 220;
function capturedTime(iso: string, timeZone?: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
}
function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission denied. Allow camera access in browser settings, then retry.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No compatible rear camera was found. You can enter a barcode manually.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Camera is already in use by another app. Close it and retry.";
  }
  return error instanceof Error ? error.message : "Camera unavailable. Try manual entry.";
}

export function ContinuousPressingScanner({
  assignment, active, onBarcode,
}: {
  assignment: PressingScannerAssignment | null;
  active: boolean;
  onBarcode: (capture: PressingScanCapture) => Promise<PressingScanOutcome>;
}) {
  const [requested, setRequested] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{
    barcode: string; at: string; outcome: ScanFeedback; message: string; intervalSeconds: number | null;
    confirmedAt?: string; timezoneName?: string; weightKg?: string; machineName?: string;
    confirmationId?: number; productionDate?: string;
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
  const gateRef = useRef(new ContinuousScanGate());
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
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
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
    } catch { /* Visual feedback remains available. */ }
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
      } catch { /* Audio feedback is optional. */ }
    }
    if (vibrationRef.current && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(kind === "duplicate" || kind === "rejected" ? [90, 70, 100] : [45]); }
      catch { /* Vibration is not available on all mobile browsers. */ }
    }
  }, []);

  useEffect(() => () => {
    // Closing the tab or unmounting must not leave an AudioContext running.
    void audioRef.current?.close().catch(() => {});
    audioRef.current = null;
  }, []);

  const handleRead = useCallback(async (barcode: string, machine: PressingScannerAssignment) => {
    // Cap work in progress to avoid unlimited promise growth on a damaged network.
    // A rejected capacity warning is never presented as a saved or queued scan.
    if (inFlightRef.current >= 32) {
      setLast({
        barcode, at: new Date().toISOString(), outcome: "rejected",
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
    const intervalSeconds = lastCapturedMsRef.current === null ? null
      : Math.max(0, Math.round((now - lastCapturedMsRef.current) / 1000));
    lastCapturedMsRef.current = now;
    setLast({ barcode, at: deviceCapturedAt, outcome: "processing", message: "Checking barcode…", intervalSeconds });
    try {
      const result = await onBarcodeRef.current({
        barcode, deviceCapturedAt, assignmentId: machine.assignmentId, machineId: machine.machineId,
      });
      if (sequence === latestCaptureRef.current) setLast({
        barcode, at: deviceCapturedAt, outcome: result.kind, message: result.message, intervalSeconds,
        confirmedAt: result.confirmedAt, timezoneName: result.timezoneName, weightKg: result.weightKg,
        machineName: result.machineName, confirmationId: result.confirmationId,
        productionDate: result.productionDate,
      });
      feedback(result.kind);
    } catch {
      if (sequence === latestCaptureRef.current) setLast({
        barcode, at: deviceCapturedAt, outcome: "rejected",
        message: "Unable to validate barcode. This bale has NOT been confirmed.", intervalSeconds,
      });
      feedback("rejected");
    } finally {
      inFlightRef.current -= 1;
    }
  }, [feedback]);

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
    gateRef.current.reset();
    setStatus("starting");
    setError(null);
    setTorchAvailable(false);
    setTorchOn(false);
    lastCapturedMsRef.current = null;

    let decoder: CameraBarcodeDecoder | null = null;
    const tick = async (detector: CameraBarcodeDecoder) => {
      if (canceled) return;
      const video = videoRef.current;
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          const matches = await detector.detect(video);
          if (canceled) return;
          const value = matches.find(match => match.rawValue?.trim())?.rawValue ?? null;
          const next = gateRef.current.frame(value, Date.now());
          if (next) void handleRead(next, currentAssignment);
        } catch { /* A transient bad frame is not a fatal camera error. */ }
      }
      if (!canceled) timer = setTimeout(() => void tick(detector), SCAN_POLL_MS);
    };

    const start = async () => {
      if (!hasCameraAccess()) {
        setStatus("manual");
        setError("Camera access requires a supported browser and a secure (HTTPS) connection. Manual entry stays available.");
        return;
      }
      // Native BarcodeDetector where it works; otherwise the bundled ZXing
      // decoder (iPhone Safari and other browsers without native support).
      decoder = await createCameraDecoder();
      if (canceled) { decoder?.dispose(); return; }
      if (!decoder) {
        setStatus("manual");
        setError("Automatic barcode decoding could not start in this browser. Use manual entry below.");
        return;
      }
      setEngine(decoder.engine);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (canceled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        if (!videoRef.current) throw new Error("Camera preview is not ready");
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (canceled) return;
        const videoTrack = stream.getVideoTracks()[0] ?? null;
        trackRef.current = videoTrack;
        if (videoTrack) {
          const capabilities = videoTrack.getCapabilities?.() as TorchCapabilities | undefined;
          setTorchAvailable(Boolean(capabilities?.torch));
          if (capabilities?.focusMode?.includes("continuous")) {
            void videoTrack.applyConstraints({
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            }).catch(() => {});
          }
        }
        setStatus("scanning");
        // Where supported, keep the screen awake during deliberate scanning.
        // Browsers may refuse this request; it is never required for scanning.
        const wakeLock = (navigator as ScreenWakeLockNavigator).wakeLock;
        if (wakeLock && !document.hidden) {
          void wakeLock.request("screen").then(lock => {
            if (canceled) void lock.release().catch(() => {});
            else screenLock = lock;
          }).catch(() => {});
        }
        void tick(decoder);
      } catch (cause) {
        stream?.getTracks().forEach(track => track.stop());
        stream = null;
        if (!canceled) {
          setStatus("error");
          setError(cameraErrorMessage(cause));
        }
      }
    };
    void start();
    return () => {
      canceled = true;
      if (timer !== undefined) clearTimeout(timer);
      stream?.getTracks().forEach(track => track.stop());
      void screenLock?.release().catch(() => {});
      decoder?.dispose();
      decoder = null;
      trackRef.current = null;
      if (video) video.srcObject = null;
      gate.reset();
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
  const badgeColor = last?.outcome === "confirmed" ? "bg-emerald-100 text-emerald-900 border-emerald-400"
    : last?.outcome === "rejected" || last?.outcome === "duplicate"
      ? "bg-red-100 text-red-900 border-red-400"
      : "bg-amber-100 text-amber-950 border-amber-400";

  return (
    <Card className="overflow-hidden" data-testid="continuous-pressing-scanner">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Camera className="h-5 w-5" /> Continuous Camera Scanner
          </CardTitle>
          <Badge variant={activeStatus === "scanning" ? "default" : "secondary"}>
            {activeStatus === "scanning" ? "Camera live" : activeStatus === "starting" ? "Starting" :
              activeStatus === "manual" ? "Manual mode" : requested && !visible ? "Paused in background" : "Camera stopped"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {assignment ? "Scans are recorded under your logged-in user" : "Pressing access not initialized"}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!usable && (
          <p className="rounded-md border border-amber-400/50 bg-amber-500/10 p-3 text-sm" role="status">
            {assignment?.machineActive === false ? "Pressing access is inactive." :
              "Open Pressing Scan with an authorized Factory account."}
          </p>
        )}
        {running && activeStatus !== "manual" && activeStatus !== "error" && (
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} muted playsInline autoPlay
              aria-label="Rear camera barcode preview"
              className="aspect-[4/3] max-h-[440px] w-full object-cover" />
            <div className="pointer-events-none absolute inset-[16%] rounded-md border-2 border-emerald-300/85" aria-hidden="true">
              <div className="absolute left-0 right-0 top-1/2 border-t border-emerald-400/70" />
            </div>
            {activeStatus === "starting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white">
                Connecting to phone camera…
              </div>
            )}
          </div>
        )}
        {error && running && <p role="alert" className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{error}</p>}
        {running && (
          <form onSubmit={submitManual} className="flex flex-wrap items-center gap-2">
            <Keyboard className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input aria-label="Manual bale barcode" placeholder="Manual barcode entry" autoComplete="off"
              className="min-w-[150px] flex-1" maxLength={120}
              value={manualCode} onChange={event => setManualCode(event.target.value)} />
            <Button type="submit" variant="secondary" disabled={!manualCode.trim()}>
              Read barcode
            </Button>
          </form>
        )}
        <div className="flex flex-wrap gap-2">
          {!requested ? (
            <Button type="button" disabled={!usable} onClick={() => {
              unlockAudio();
              setLast(null);
              setRequested(true);
            }}><Camera className="mr-2 h-4 w-4" />Start scanner</Button>
          ) : (
            <Button type="button" variant="destructive" onClick={() => setRequested(false)}>
              <CameraOff className="mr-2 h-4 w-4" />Stop scanner
            </Button>
          )}
          {requested && (activeStatus === "error" || activeStatus === "manual") && (
            <Button type="button" variant="outline" onClick={() => setRetryAttempt(n => n + 1)}>
              <RotateCcw className="mr-2 h-4 w-4" />Retry camera
            </Button>
          )}
          {requested && torchAvailable && (
            <Button type="button" variant="outline" onClick={() => void toggleTorch()}>
              {torchOn ? <FlashlightOff className="mr-2 h-4 w-4" /> : <Flashlight className="mr-2 h-4 w-4" />}
              {torchOn ? "Light off" : "Light on"}
            </Button>
          )}
          <Button type="button" variant="outline" aria-label={sound ? "Disable scanner sound" : "Enable scanner sound"}
            onClick={() => { if (!sound) unlockAudio(); setSound(v => !v); }}>
            {sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>
          <Button type="button" variant="outline" aria-label={vibration ? "Disable scanner vibration" : "Enable scanner vibration"}
            onClick={() => setVibration(v => !v)}>
            <Vibrate className={vibration ? "h-4 w-4" : "h-4 w-4 opacity-40"} />
          </Button>
        </div>
        {last && (
          <div role="status" aria-live="polite" className={`rounded-lg border p-3 ${badgeColor}`}>
            <div className="flex flex-wrap justify-between gap-1">
              <strong className="break-all">{last.barcode}</strong>
              <span className="font-mono text-sm">
                {last.confirmedAt
                  ? capturedTime(last.confirmedAt, last.timezoneName)
                  : capturedTime(last.at)}
              </span>
            </div>
            <p className="text-sm">{last.message}</p>
            {last.confirmedAt && (
              <p className="text-xs">
                Server confirmed: {last.productionDate} {capturedTime(last.confirmedAt, last.timezoneName)}
                {last.timezoneName ? " (" + last.timezoneName + ")" : ""}
                {last.weightKg ? " · " + last.weightKg + " KG" : ""}
                
                {last.confirmationId ? " · Record #" + last.confirmationId : ""}
              </p>
            )}
            {last.intervalSeconds !== null && (
              <p className="text-xs">Time since previous read: {last.intervalSeconds} seconds</p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The camera stays open between reads. Move each bale's barcode into view;
          repeated frames will not submit the same code again. Leaving this tab,
          locking the phone, or stopping the scanner releases camera access.
        </p>
        <p className="text-xs text-muted-foreground">
          A green confirmation means the server has saved physical pressing completion with the
          machine, operator, and exact timestamp. Stock finalization is a separate workflow.
          Offline scans stay amber until they receive server confirmation. Permanent history and filters are below.
        </p>
        {running && engine && (
          <p className="text-xs text-muted-foreground" data-testid="pressing-decoder-engine">
            Decoder: {engine === "native" ? "browser native BarcodeDetector" : "bundled ZXing (cross-platform)"}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
