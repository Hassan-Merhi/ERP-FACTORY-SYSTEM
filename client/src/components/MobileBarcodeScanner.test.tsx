import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({
  frames: [] as string[],
  dispose: vi.fn(),
  available: true,
}));
vi.mock("@/pages/factory/pressing-scanner/cameraDecoder", () => ({
  hasCameraAccess: () => camera.available,
  createCameraDecoder: async () => ({
    engine: "zxing",
    detect: async () => {
      const code = camera.frames.shift();
      return code ? [{ rawValue: code }] : [];
    },
    dispose: camera.dispose,
  }),
}));

import { MobileBarcodeScanner } from "./MobileBarcodeScanner";

let stopTrack: ReturnType<typeof vi.fn>;

beforeEach(() => {
  camera.frames = [];
  camera.available = true;
  camera.dispose.mockReset();
  stopTrack = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 2 });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MobileBarcodeScanner", () => {
  it("keeps the camera alive between different barcodes and suppresses repeated frames", async () => {
    const onScan = vi.fn();
    render(<MobileBarcodeScanner onScan={onScan} />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    camera.frames.push("REF300208", "REF300208", "REF300209");
    await waitFor(() => expect(onScan).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(onScan.mock.calls.map(([code]) => code)).toEqual(["REF300208", "REF300209"]);
    expect(stopTrack).not.toHaveBeenCalled();
    expect(screen.getByText(/Last detected: REF300209/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));
    expect(camera.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases camera access when hidden or unmounted", async () => {
    render(<MobileBarcodeScanner onScan={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));
  });

  it("keeps disabled camera controls disabled and shows a clear camera fallback", async () => {
    const { rerender } = render(<MobileBarcodeScanner onScan={vi.fn()} disabled />);
    expect(screen.getByRole("button", { name: /scan with camera/i })).toBeDisabled();
    rerender(<MobileBarcodeScanner onScan={vi.fn()} />);
    camera.available = false;
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/HTTPS and a supported browser/);
  });
});
