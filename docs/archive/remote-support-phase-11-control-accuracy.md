# Remote support Phase 11 — control accuracy

## Scope

Phase 11 makes remote clicks land where the controller aimed instead of where
the employee's viewport happens to be when the command executes. It does not
expand control beyond the authenticated ERP tab and does not weaken any
existing permission, password, sensitive-action, rollout, or audit protection.

## Clicks mapped against the captured frame

Controller coordinates remain normalized from `0` to `1`, but a normalized
point is only meaningful against the viewport it was aimed at. When the
employee scrolls, resizes, or zooms between frame capture and command
execution, the old live-viewport mapping silently landed clicks on whatever
control had moved under the pointer.

- Both screen viewers stamp the displayed frame's captured scroll/viewport
  snapshot onto the screen image as `data-frame-viewport-*` attributes.
- The mouse controller overlay reads that snapshot and attaches it as
  `frameViewport` to click and scroll commands. Pointer movement is
  display-only and carries no snapshot.
- The server sanitizes and forwards the snapshot (`width`, `height`,
  `scrollX`, `scrollY`, `visualScale`); a malformed snapshot is dropped, not
  rejected, so legacy controllers keep working.
- The target tab compares the snapshot against its live viewport before hit
  testing. Clicks and scrolls whose frame has scrolled, resized, or zoomed
  beyond a tight tolerance (2 px, 0.01 scale) are ignored with reason
  `stale-frame-viewport` instead of activating the wrong control.
- The controller sees "The screen changed since this frame was captured. Wait
  for a fresh frame and try again." and retries against the next frame.

## Fresher frames

The adaptive capture gap spaces renders by a multiple of what the previous
render actually cost. The duty-cycle multiplier is reduced from 4 to 2, so a
900 ms render now schedules the next capture after ~1.8 s instead of ~3.6 s.
Fresher frames directly mean fewer stale-frame rejections and more accurate
control, while heavy ERP screens still avoid back-to-back full-page renders.

## Explicitly reviewed safe controls

The following read-only controls are annotated with
`data-remote-control-safe="true"` after review. Each one only navigates to a
read-only detail view, opens a read-only dialog, or toggles a local display
mode — none of them mutates server state:

- Customer invoices → invoice detail navigation (`CustomerInvoices.tsx`)
- Deleted-items read-only detail dialog (`DeletedItems.tsx`)
- Container detail navigation (`ActiveContainersTable.tsx`, `ContainerSpView.tsx`)
- Sold-container detail navigation (`SoldContainers.tsx`)
- Invoice profitability dialog (`CustomerInvoiceDetail.tsx`)
- Daybook detailed/condensed view toggles (`Daybook.tsx`, sessionStorage only)
- Stock entry history view toggles (`StockEntryHistory.tsx`)
- Show-all-months display toggles (`LocationMonthlySummary.tsx`, `LocationVouchers.tsx`)

The annotation cannot override existing protections: blocked elements (forms,
inputs, disabled controls), dangerous-action text, sensitive routes, and the
keyboard-field classifier still fail closed first. Verified by focused tests.

## Preserved protections

This phase does not change:

- controller ownership and exact-tab binding;
- password-confirmation requirements;
- runtime and rollout flags;
- command rate limits;
- sensitive-route blocking;
- protected-element and action allowlists;
- keyboard-field safety;
- command auditing.

## Verification

Focused coverage verifies:

- fresh-frame clicks execute; scrolled, resized, or zoomed frames are ignored
  with `stale-frame-viewport`;
- pointer movement skips the stale-frame check;
- legacy commands without a snapshot keep the previous behavior;
- viewer-dataset snapshot parsing, including partial-snapshot fallback;
- safe annotations cannot override dangerous text or blocked elements;
- server snapshot sanitization, forwarding, and malformed-snapshot tolerance;
- the reduced duty-cycle multiplier keeps frames fresher without changing the
  adaptive-gap contract.

No SQL or schema migration is required.
