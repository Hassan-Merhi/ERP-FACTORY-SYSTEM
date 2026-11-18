import {
  Camera,
  CameraOff,
  Flashlight,
  FlashlightOff,
  Keyboard,
  RotateCcw,
  Volume2,
  VolumeX,
  Vibrate,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";
import { factoryLocalDateFromInstant } from "@shared/factoryLocalDate";
import type {
  PressingScanCapture,
  PressingScanOutcome,
  PressingScannerAssignment,
} from "./ContinuousPressingScannerTypes";
import { useContinuousPressingScannerState } from "./useContinuousPressingScannerState";
export type {
  PressingScanCapture,
  PressingScanOutcome,
  PressingScannerAssignment,
} from "./ContinuousPressingScannerTypes";
function capturedTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: PRESSING_TIME_ZONE,
  });
}
function capturedDate(iso: string): string {
  return factoryLocalDateFromInstant(iso) ?? "—";
}

export function ContinuousPressingScanner(props: {
  assignment: PressingScannerAssignment | null;
  active: boolean;
  onBarcode: (capture: PressingScanCapture) => Promise<PressingScanOutcome>;
  simpleControls?: boolean;
}) {
  const {
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
  } = useContinuousPressingScannerState(props);

  return (
    <Card className="overflow-hidden" data-testid="continuous-pressing-scanner">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Camera className="h-5 w-5" /> Continuous Camera Scanner
          </CardTitle>
          <Badge variant={activeStatus === "scanning" ? "default" : "secondary"}>
            {activeStatus === "scanning"
              ? "Camera live"
              : activeStatus === "starting"
                ? "Starting"
                : activeStatus === "manual"
                  ? "Manual mode"
                  : requested && !visible
                    ? "Paused in background"
                    : "Camera stopped"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!usable && (
          <p className="rounded-md border border-amber-400/50 bg-amber-500/10 p-3 text-sm" role="status">
            {assignment?.machineActive === false
              ? "Pressing access is inactive."
              : "Open Pressing Scan with an authorized Factory account."}
          </p>
        )}
        {running && activeStatus !== "manual" && activeStatus !== "error" && (
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              aria-label="Rear camera barcode preview"
              className="aspect-[4/3] max-h-[440px] w-full object-cover"
            />
            <div
              className={
                "pointer-events-none absolute inset-[16%] rounded-md border-2 " +
                (last?.outcome === "confirmed"
                  ? "border-emerald-400"
                  : last?.outcome === "duplicate" || last?.outcome === "rejected"
                    ? "border-red-500"
                    : "border-white/70")
              }
              aria-hidden="true"
            >
              <div className="absolute left-0 right-0 top-1/2 border-t border-white/50" />
            </div>
            {activeStatus === "starting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white">
                Connecting to phone camera…
              </div>
            )}
          </div>
        )}
        {error && running && (
          <p role="alert" className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            {simpleControls && activeStatus === "manual"
              ? "Camera scanning is unavailable on this device. Close and reopen the camera, or allow camera access in your browser."
              : error}
          </p>
        )}
        {simpleControls && requested && running && (activeStatus === "error" || activeStatus === "manual") && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setRetryAttempt((attempt) => attempt + 1)}
            data-testid="button-pressing-simple-camera-retry"
          >
            <RotateCcw className="mr-2 h-4 w-4" /> Retry camera
          </Button>
        )}
        {!simpleControls && running && (
          <form onSubmit={submitManual} className="flex flex-wrap items-center gap-2">
            <Keyboard className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              aria-label="Manual item barcode"
              placeholder="Manual barcode entry"
              autoComplete="off"
              className="min-w-[150px] flex-1"
              maxLength={120}
              value={manualCode}
              onChange={(event) => setManualCode(event.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={!manualCode.trim()}>
              Read barcode
            </Button>
          </form>
        )}
        {!simpleControls && (
          <div className="flex flex-wrap gap-2">
            {!requested ? (
              <Button
                type="button"
                disabled={!usable}
                onClick={() => {
                  unlockAudio();
                  setLast(null);
                  setRequested(true);
                }}
              >
                <Camera className="mr-2 h-4 w-4" />
                Start scanner
              </Button>
            ) : (
              <Button type="button" variant="destructive" onClick={() => setRequested(false)}>
                <CameraOff className="mr-2 h-4 w-4" />
                Stop scanner
              </Button>
            )}
            {requested && (activeStatus === "error" || activeStatus === "manual") && (
              <Button type="button" variant="outline" onClick={() => setRetryAttempt((n) => n + 1)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Retry camera
              </Button>
            )}
            {requested && torchAvailable && (
              <Button type="button" variant="outline" onClick={() => void toggleTorch()}>
                {torchOn ? <FlashlightOff className="mr-2 h-4 w-4" /> : <Flashlight className="mr-2 h-4 w-4" />}
                {torchOn ? "Light off" : "Light on"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              aria-label={sound ? "Disable scanner sound" : "Enable scanner sound"}
              onClick={() => {
                if (!sound) unlockAudio();
                setSound((v) => !v);
              }}
            >
              {sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-label={vibration ? "Disable scanner vibration" : "Enable scanner vibration"}
              onClick={() => setVibration((v) => !v)}
            >
              <Vibrate className={vibration ? "h-4 w-4" : "h-4 w-4 opacity-40"} />
            </Button>
          </div>
        )}
        {last && (
          <div role="status" aria-live="polite" className={`rounded-lg border p-3 ${badgeColor}`}>
            <div className="flex flex-wrap justify-between gap-1">
              <strong className="break-all">{last.barcode}</strong>
              <span className="font-mono text-sm" title={"Time in " + PRESSING_TIME_ZONE}>
                {last.confirmedAt ? capturedTime(last.confirmedAt) : capturedTime(last.at)}
              </span>
            </div>
            <p className="text-base font-bold" data-testid="pressing-camera-scan-status">
              {last.outcome === "duplicate"
                ? "ALREADY SCANNED"
                : last.outcome === "confirmed"
                  ? "SCAN CONFIRMED"
                  : last.outcome === "queued"
                    ? "WAITING FOR SERVER"
                    : last.outcome === "processing"
                      ? "CHECKING…"
                      : last.outcome === "rejected"
                        ? "SCAN REJECTED"
                        : "SCAN PREVIEW"}
            </p>
            {last.outcome === "duplicate" && last.scannedBy && (
              <p className="text-base font-semibold" data-testid="pressing-duplicate-user">
                Scanned by: {last.scannedBy}
              </p>
            )}
            {last.outcome !== "duplicate" && <p className="text-sm">{last.message}</p>}
            {last.outcome === "duplicate" && !last.scannedBy && <p className="text-sm">{last.message}</p>}
            {last.confirmedAt && (
              <p className="text-xs">
                Server confirmed: {capturedDate(last.confirmedAt)} {capturedTime(last.confirmedAt)}
                {" (" + PRESSING_TIME_ZONE + ")"}
                {last.weightKg ? " · " + last.weightKg + " KG" : ""}
                {last.confirmationId ? " · Record #" + last.confirmationId : ""}
              </p>
            )}
            {last.intervalSeconds !== null && (
              <p className="text-xs">Time since previous read: {last.intervalSeconds} seconds</p>
            )}
          </div>
        )}
        {!simpleControls && running && engine && (
          <p className="text-xs text-muted-foreground" data-testid="pressing-decoder-engine">
            Decoder: {engine === "native" ? "browser native BarcodeDetector" : "bundled ZXing (cross-platform)"}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
