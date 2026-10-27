# Pressing Machines — Phase 3: Continuous Phone-Camera Scanner

Branch: `feature/pressing-machine-tracking`  
No merge, deploy, or production database changes in this phase.

## Delivered source changes

- `client/src/pages/factory/ContinuousPressingScanner.tsx`: machine-assignment-scoped camera panel with one-tap start, continuous video and recognition loop, proper stop on tab change/unmount/background, safe restart on foreground return, optional Wake Lock and torch/continuous autofocus where available.
- `client/src/pages/factory/pressing-scanner/cameraDecoder.ts`: detection using the same native `BarcodeDetector` API currently used by Retail POS, supporting Code 128, Code 39, EAN, UPC and QR when browser-supported.
- `client/src/pages/factory/pressing-scanner/continuousScanGate.ts`: suppress multiple readings of a single visible barcode, re-arm only once it leaves view, add short cooldown against blurry-frame repeats, accept the next *different* bale immediately.
- `PressingMachineManagement.tsx` shows an assigned machine's scanner, with local device timestamp down to seconds, elapsed seconds between reads, and optional audio/haptic feedback.
- `BaleStockEntry.tsx` passes active tab visibility to guarantee the camera stops when leaving Pressing Machines.
- Manual entry remains usable when permission, camera, autofocus, torch, or native decoding is unsupported.

## Precise scanner lifecycle

1. Operator opens Factory → Stock Entry → Pressing Machines and has an ACTIVE assigned machine.
2. Operator presses Start scanner. The app requests a rear camera on HTTPS and begins a looping decoder. It DOES NOT close after a successful barcode read.
3. Duplicate camera frames are suppressed on-device. The next different barcode is accepted immediately. Server-side one-lifetime-confirmation protection remains required in Phase 4.
4. The worker gets a local read timestamp in HH:mm:ss format, barcode, status and elapsed seconds from the last read.
5. Operator can stop explicitly, or the browser stops on tab switch, background/lock, unmount, or loss of assigned machine.
6. Return to foreground resumes when the operator had explicitly started the scanner; browsers may re-prompt for access.
7. Optional Web Audio tones and vibration vary by the outcome returned from the future server submission method; failures degrade gracefully to visible status messages.

## Phase boundary: **Do not misrepresent preview scans as completed pressing**

Phase 3 uses a `PressingScanCapture` / `PressingScanOutcome` contract suitable for the Phase 4 handler, but the current parent sends a preview-only outcome. NO Phase 3 barcode reading is saved or posted to the server. The UI specifically says `NOT yet confirmed or saved`; green “Pressing Completed” is reserved for Phase 4's successfully accepted and committed transaction. No inventory or accounting API is invoked.

## Decoder engines and browser compatibility

`cameraDecoder.ts` exposes one `CameraBarcodeDecoder` interface with two engines:

1. **Native `BarcodeDetector`** — used when the browser exposes it *and* reports at least one usable bale format (Android Chrome, some desktop browsers). Desktop Linux Chrome exposes the class with no formats and is skipped.
2. **Bundled ZXing** (`@zxing/browser` 0.2.1 + `@zxing/library` 0.23.0, pinned, loaded on demand as its own Vite chunk) — used everywhere else, notably **iPhone Safari**, which does not ship `BarcodeDetector`. Each camera frame is drawn to a reusable canvas capped at 1280px on its longest edge and decoded for Code 128, Code 39, EAN-13/8, UPC-A/E and QR with `TRY_HARDER` off, so the 220ms polling loop stays responsive on phones.

The scanner shows which engine is active ("Decoder: browser native BarcodeDetector" or "bundled ZXing"). When neither engine can start (no secure context, no camera, or the decoder chunk fails to load) the panel switches to **Manual mode** with an explicit message and the manual-entry form; it never pretends automatic decoding is active. No remote CDN script is loaded.

The camera continues while the page is in the foreground. Operating systems may suspend browser cameras in the background or when the phone locks; the scanner stops the stream on background/tab change/unmount and restarts it on return. Where available, Screen Wake Lock is requested, but cannot override OS restrictions.

**Not verified here:** physical Android and iOS devices were not available in the verification environment. Engine selection, frame handling, duplicate suppression, cleanup and manual fallback are covered by unit and render tests (jsdom); real-camera recognition quality, torch, autofocus, vibration and audio on specific handsets still need a device pass before rollout.

## Verification

Added tests:
- `client/src/pages/factory/pressing-scanner/continuousScanGate.test.ts`: suppression, re-arm, different-bale acceptance, manual entry and reset.
- `client/src/pages/factory/pressing-scanner/cameraDecoder.test.ts`: native-first selection, ZXing fallback when native is absent or reports no formats, frame downscaling, NotFound handling, manual-only when neither engine starts.
- `client/src/pages/factory/ContinuousPressingScanner.test.tsx`: stream stays open across reads, repeated frames of one barcode submit once, camera and decoder released on background/tab change/stop/unmount, manual entry submits, queued/rejected outcomes never render as confirmations.
- `tests/pressing-machine-phase3-source.test.ts`: camera-loop, tab cleanup, status, and no unintended stock mutations.

Run on a checked-out branch:
```sh
npm run check
npm run test:frontend -- client/src/pages/factory/pressing-scanner client/src/pages/factory/ContinuousPressingScanner.test.tsx
npx vitest run tests/pressing-machine-phase3-source.test.ts
```

Then manually verify on physical Android Chrome, iOS Safari, and at least one older device:
camera permissions denied/allowed; switch tabs; send device to background; return; scan two different barcodes quickly; leave the same barcode in view; torch absent/present; low light; no vibration or Web Audio support; no duplicate barcode event and no false production confirmation.

## Next step

Phase 4 implements the authoritative pressing confirmation server endpoint and exact server timestamp, validated against the active machine/assignment/session, unique request ID and bale status. Phase 5 implements durable offline queuing and retry. Both keep Factory stock finalization entirely separate.
