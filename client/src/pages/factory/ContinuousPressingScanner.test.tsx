import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraBarcodeDecoder } from "./pressing-scanner/cameraDecoder";

const camera = vi.hoisted(() => ({
  frames: [] as string[],
  dispose: vi.fn(),
  decoder: null as CameraBarcodeDecoder | null,
}));
vi.mock("./pressing-scanner/cameraDecoder", () => ({
  hasCameraAccess: () => true,
  createCameraDecoder: async () => camera.decoder,
}));

import { ContinuousPressingScanner, type PressingScanOutcome } from "./ContinuousPressingScanner";

const assignment = {
  assignmentId: 4,
  machineId: 2,
  machineCode: "PRESS-02",
  machineName: "Press 02",
  machineActive: true,
};
let stopTrack: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  camera.frames = [];
  camera.dispose.mockReset();
  camera.decoder = {
    engine: "zxing",
    detect: async () => {
      const value = camera.frames.shift();
      return value ? [{ rawValue: value }] : [];
    },
    dispose: camera.dispose,
  };
  stopTrack = vi.fn();
  const track = { stop: stopTrack, getCapabilities: () => ({ torch: true }), applyConstraints: vi.fn(async () => {}) };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 2 });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => vi.restoreAllMocks());

async function startScanner(
  onBarcode = vi.fn(async (): Promise<PressingScanOutcome> => ({
    kind: "confirmed",
    message: "Pressing completed and saved",
    confirmedAt: "2026-10-27T09:26:15.000Z",
    timezoneName: "UTC",
  }))
) {
  const view = render(<ContinuousPressingScanner assignment={assignment} active onBarcode={onBarcode} />);
  fireEvent.click(screen.getByRole("button", { name: /start scanner/i }));
  await waitFor(() => expect(screen.getByText("Camera live")).toBeInTheDocument());
  return { ...view, onBarcode };
}

describe("ContinuousPressingScanner camera lifecycle", () => {
  it("keeps the camera open across reads, submits each different barcode once and shows the engine", async () => {
    const { onBarcode } = await startScanner();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pressing-decoder-engine")).toHaveTextContent("bundled ZXing");
    camera.frames.push("REF300208", "REF300208", "REF300208", "REF300209");
    await waitFor(() => expect(onBarcode).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(onBarcode.mock.calls.map(([c]) => c.barcode)).toEqual(["REF300208", "REF300209"]);
    expect(onBarcode.mock.calls[0][0]).toMatchObject({ assignmentId: 4, machineId: 2 });
    expect(Date.parse(onBarcode.mock.calls[0][0].deviceCapturedAt)).not.toBeNaN();
    // The stream was never torn down between the two reads.
    expect(stopTrack).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Pressing completed and saved")).toBeInTheDocument());
    expect(screen.getByText(/Server confirmed:/)).toBeInTheDocument();
    expect(screen.getByText(/Time since previous read: \d+ seconds/)).toBeInTheDocument();
  });

  it("releases the camera and decoder when the page goes to the background and on unmount", async () => {
    const { unmount } = await startScanner();
    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));
    expect(camera.dispose).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Paused in background")).toBeInTheDocument();
    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    unmount();
    expect(stopTrack).toHaveBeenCalledTimes(2);
    expect(camera.dispose).toHaveBeenCalledTimes(2);
  });

  it("stops the camera when the tab is no longer active and when the scanner is stopped", async () => {
    const onBarcode = vi.fn(async (): Promise<PressingScanOutcome> => ({
      kind: "queued",
      message: "Saved on this device",
    }));
    const { rerender } = render(<ContinuousPressingScanner assignment={assignment} active onBarcode={onBarcode} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanner/i }));
    await waitFor(() => expect(screen.getByText("Camera live")).toBeInTheDocument());
    rerender(<ContinuousPressingScanner assignment={assignment} active={false} onBarcode={onBarcode} />);
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));
    rerender(<ContinuousPressingScanner assignment={assignment} active onBarcode={onBarcode} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /stop scanner/i }));
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Camera stopped")).toBeInTheDocument();
  });

  it("falls back to manual entry when no decoder can start, and manual reads still submit", async () => {
    camera.decoder = null;
    const onBarcode = vi.fn(async (): Promise<PressingScanOutcome> => ({
      kind: "rejected",
      message: "This reference is not an active factory bale",
    }));
    render(<ContinuousPressingScanner assignment={assignment} active onBarcode={onBarcode} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanner/i }));
    await waitFor(() => expect(screen.getByText("Manual mode")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Use manual entry below");
    fireEvent.change(screen.getByLabelText("Manual bale barcode"), { target: { value: "  ref300210 " } });
    fireEvent.click(screen.getByRole("button", { name: /read barcode/i }));
    await waitFor(() => expect(onBarcode).toHaveBeenCalledTimes(1));
    expect(onBarcode.mock.calls[0][0].barcode).toBe("ref300210");
    await waitFor(() => expect(screen.getByText("This reference is not an active factory bale")).toBeInTheDocument());
  });

  it("does not show a confirmation for a queued or rejected outcome", async () => {
    const onBarcode = vi.fn(async (): Promise<PressingScanOutcome> => ({
      kind: "queued",
      message: "Saved on this device. Waiting for server confirmation — NOT yet counted.",
    }));
    await startScanner(onBarcode);
    camera.frames.push("REF300300");
    await waitFor(() => expect(screen.getByText(/NOT yet counted/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText(/Server confirmed:/)).not.toBeInTheDocument();
  });
});
