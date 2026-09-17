# Remote support Phase 12 — usable allowlists

## Scope

Phase 12 makes remote control usable in practice without widening trust. It does not expand control beyond the authenticated ERP browser tab, does not add new capabilities, and does not weaken password, rollout, sensitive-action, or audit protections.

Three operator-reported problems are fixed:

- **"clicks do nothing"** — safe controls were gated by fragile text heuristics or a generic `data-remote-control-safe` flag with no registry and no distinct feedback.
- **"can't type"** — the keyboard capture input lost focus to window blurs, pointer interactions, or browser focus management, and had no IME support.
- **Generic error banners** — blocked vs ignored commands reused the same message, so operators could not tell a protected control from a stale frame or an unallowlisted action.

No SQL or schema migration is required.

## Generated `data-remote-control-action` registry

A centralized, generated allowlist replaces the scattered text heuristic as the primary usable gate.

- New module `client/src/hooks/remote-control-action-registry.ts` is the source of truth. It exports `REMOTE_CONTROL_ALLOWED_ACTIONS` (24 vetted values), `isRegisteredRemoteControlAction`, and `getRemoteControlAction`. Every value was reviewed as read-only or navigation-safe; adding a new allowlisted control requires adding its action here first.
- `client/src/hooks/remote-mouse-control-policy.ts` now:
  - imports the registry,
  - extends `CLICKABLE_SELECTOR` with `[data-remote-control-action]`,
  - checks `data-remote-control-action` first. If the attribute is present, the element is allowed **only** when its trimmed value is in the registry — an unregistered action is `action-not-allowlisted` even if its visible text would otherwise match the heuristic. The registry check never overrides blocked/dangerous checks, which fail closed first.
  - otherwise falls back to `data-remote-control-safe`, tab/summary, same-origin navigation, and the `SAFE_ACTION_TEXT` heuristic for backward compatibility.
- Existing safe controls are annotated with both `data-remote-control-safe="true"` (kept for compat) and the new `data-remote-control-action`:
  - `view-invoice` (CustomerInvoices), `view-profitability` (CustomerInvoiceDetail), `view-details` (DeletedItems), `view-container` (ActiveContainersTable, ContainerSpView), `view` (SoldContainers), `toggle-view` (Daybook detailed/condensed, StockEntryHistory, LocationMonthlySummary, LocationVouchers).
- Generator/verifier pair:
  - `scripts/generate-remote-control-action-registry.mjs` scans `client/src` for `data-remote-control-action="…"` usages, compares them to the registry, and with `--write` regenerates the file sorted. Without flags it verifies and exits 1 on unregistered values.
  - `scripts/verify-remote-control-action-registry.mjs` is a thin alias for CI. Registered-but-unused values are warned, not failed, to allow forward registration.
  - `package.json` exposes `verify:remote-control-registry` and `generate:remote-control-registry`.

Verified by the existing mouse safety suite plus new `remote-control-action-registry.test.ts`, which covers registry membership, trimming, presence-gated allowlisting, heuristic fallback, and the fail-closed override for dangerous/blocked surfaces.

## Re-focus the keyboard capture input

Operators reported "can't type" when the hidden capture `<input>` lost focus.

- `RemoteKeyboardControllerOverlay` now aggressively re-focuses while `keyboardActive`:
  - initial focus on activation and after password confirmation,
  - `blur` → `setTimeout(refocus)`,
  - `window focus` and `visibilitychange` → refocus,
  - `pointerdown` anywhere in the document (outside the capture input) → refocus, without stealing focus from the password confirmation field.
  - The input also refocuses on its own `onBlur` and clears the error banner on `onFocus` so the operator sees the result of the last command, not a stale error.

## IME support

The capture input previously handled only `keyDown` with `event.key.length === 1`, so CJK and other IME compositions produced no input.

- Added `isComposingRef` and `onCompositionStart` / `onCompositionEnd` handlers. `onCompositionEnd` reads `(event as any).data` or the input's current value, clears the DOM value, and queues the composed string via the existing `queueText` batching (45 ms window, 32 code-point batches).
- Added `onInput` fallback for mobile autocomplete/predictive text and IME fallbacks that bypass `keyDown`: when not composing and the input's value is non-empty, it is cleared and queued.
- `onKeyDown` now early-returns while composing and handles `Unidentified` keys (some IME surfaces).
- The input is now `autoCorrect="off" autoCapitalize="off" spellCheck={false}` to avoid browser rewriting of composed text.

## Distinct error reasons

Both controller overlays previously showed a single generic blocked message, making "clicks do nothing" and "can't type" undebuggable.

- `RemoteKeyboardControllerOverlay` now maps each terminal reason to a distinct message via `getKeyboardErrorForReason`:
  - `local-user-active` → "Employee is actively typing — remote typing paused…"
  - `no-safe-editable-focus` → "No safe field focused — click a safe search, filter or approved field…"
  - `text-not-supported`, `field-length-limit`, `invalid-text`, `invalid-key`, `form-submit-blocked`, `select-key-blocked`, `checkbox-key-blocked`, `selection-not-supported`, `vertical-key-not-supported`, `number-step-blocked`, `nothing-to-delete`, `delete-failed`, `no-adjacent-field`, `stale-command`, `duplicate-command`, plus a generic fallback. `blocked` and `ignored` both surface a message; `executed` clears the error.
- `RemoteMouseControllerOverlay` now uses `getMouseErrorForReason`:
  - `protected-element` → protected banner,
  - `action-not-allowlisted` → "This control isn't on the allowlist — it needs a data-remote-control-action from the registry.",
  - `stale-frame-viewport` → fresh-frame hint,
  - `invalid-coordinates`, `no-target`, `no-clickable-target`, `click-failed`, `empty-scroll`, `command-timeout`, `duplicate-command`, and a `status: reason` fallback. `executed` clears the banner.
- The target-side policies already returned distinct `reason` codes (`protected-element`, `action-not-allowlisted`, `no-safe-editable-focus`, etc.); this phase surfaces them faithfully instead of collapsing to one string.

## Preserved protections

Phase 12 does not change:

- controller ownership and exact-tab binding;
- password-confirmation and 5-minute authorization windows;
- runtime and rollout flags;
- command rate limits;
- sensitive-route and sensitive-field blocking;
- protected-element and dangerous-text fail-closed checks (registry never overrides them);
- command auditing and metadata-only results.

## Verification

- `remote-control-action-registry.test.ts`: registry membership, trimming, presence-gated allowlisting, heuristic fallback, blocked/dangerous override.
- Existing mouse/keyboard policy suites still pass; the registry test exercises the new primary allowlist path.
- Manual verification: enable mouse → clicks on allowlisted controls execute, clicks elsewhere show "isn't on the allowlist"; enable keyboard → capture input stays focused after blur/window switch, CJK composition inserts via IME, and each blocked/ignored reason shows its distinct banner.
- `node scripts/verify-remote-control-action-registry.mjs` passes (6 discovered actions, 18 forward-registered warnings).
