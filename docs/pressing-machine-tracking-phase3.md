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

## Browser compatibility limitation

This branch contains NO cross-platform bundled barcode decoder yet. Native `BarcodeDetector` is browser-dependent, and camera support also requires a secure context. On browsers without it (which can include Safari/iPhone), the interface does **not** pretend automatic decoding works: it exposes a visible manual-entry fallback. For reliable automatic scanning on all intended Android and iOS devices, add and pin a supported local decoding library (e.g. ZXing), update the npm lockfile, and exercise a physical device matrix before deployment. Do not load decoder scripts from an unpinned remote CDN.

The camera can continue while the page is in the foreground. Operating systems may suspend browser cameras in the background or when the phone locks. Where available, Screen Wake Lock is requested to reduce screen sleeps, but cannot override OS restrictions.

## Verification

Added tests:
- `client/src/pages/factory/pressing-scanner/continuousScanGate.test.ts`: suppression, re-arm, different-bale acceptance, manual entry and reset.
- `client/src/pages/factory/pressing-scanner/cameraDecoder.test.ts`: unsupported detector, format selection and graceful fallback.
- `tests/pressing-machine-phase3-source.test.ts`: camera-loop, tab cleanup, status, and no unintended stock mutations.

Run on a checked-out branch:
```sh
npm run check
npm run test:frontend -- client/src/pages/factory/pressing-scanner/continuousScanGate.test.ts client/src/pages/factory/pressing-scanner/cameraDecoder.test.ts
npx vitest run tests/pressing-machine-phase3-source.test.ts
```

Then manually verify on physical Android Chrome, iOS Safari, and at least one older device:
camera permissions denied/allowed; switch tabs; send device to background; return; scan two different barcodes quickly; leave the same barcode in view; torch absent/present; low light; no vibration or Web Audio support; no duplicate barcode event and no false production confirmation.

## Next step

Phase 4 implements the authoritative pressing confirmation server endpoint and exact server timestamp, validated against the active machine/assignment/session, unique request ID and bale status. Phase 5 implements durable offline queuing and retry. Both keep Factory stock finalization entirely separate.
