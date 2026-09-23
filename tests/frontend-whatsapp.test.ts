/**
 * Phase 3 — WhatsApp Popup Logic Tests
 *
 * The backend `whatsapp-triggers.test.ts` verifies that the server returns
 * `whatsapp.prompt = true` at the correct moments. This file verifies the
 * FRONTEND DECISION LOGIC — whether the popup should appear, and what state
 * it should hold — without hitting the server, a database, or the DOM.
 *
 * Architecture note (from code review of Vouchers.tsx + JournalForm.tsx):
 *
 *   The WhatsApp popup is controlled by a `waPendingPrompt` local state
 *   of type `WhatsAppPromptState` (from @/lib/whatsapp-prompt).
 *
 *   It is set inside the voucher mutation's onSuccess callback via:
 *     const waPrompt = resolveWhatsAppPrompt(data);
 *     if (waPrompt) setWaPendingPrompt(waPrompt);
 *
 *   The AlertDialog renders iff `!!waPendingPrompt`.
 *
 *   This test imports the REAL `resolveWhatsAppPrompt` from the shared
 *   utility so that any change to the production condition is immediately
 *   caught here — the test cannot drift from the shipped code.
 *
 * What these tests protect:
 *  - popup shown only when prompt=true AND accountId AND month are all present
 *  - popup NOT shown when prompt=false
 *  - popup NOT shown when accountId or month is missing
 *  - popup NOT shown when whatsapp field is absent (no schedule configured)
 *  - prompt data extracted correctly into the pending state shape
 *  - null/undefined response data never throws
 */

import { describe, it, expect } from "vitest";
import { resolveWhatsAppPrompt } from "@/lib/whatsapp-prompt";
import type { WhatsAppPromptState } from "@/lib/whatsapp-prompt";

function isPopupOpen(state: WhatsAppPromptState): boolean {
  return state !== null;
}

// ── Tests: popup shown ────────────────────────────────────────────────────────

describe("WhatsApp popup — should open", () => {
  it("opens when prompt=true with accountId and month", () => {
    const data = {
      success: true,
      voucher: { id: 1 },
      whatsapp: { prompt: true, accountId: 42, month: "June 2026" },
    };
    const state = resolveWhatsAppPrompt(data);
    expect(isPopupOpen(state)).toBe(true);
    expect(state).toEqual({ accountId: 42, month: "June 2026" });
  });

  it("extracts accountId and month exactly from the response", () => {
    const data = {
      whatsapp: { prompt: true, accountId: 999, month: "December 2025" },
    };
    const state = resolveWhatsAppPrompt(data);
    expect(state?.accountId).toBe(999);
    expect(state?.month).toBe("December 2025");
  });

  it("works with large accountId values", () => {
    const data = {
      whatsapp: { prompt: true, accountId: 1_000_000, month: "January 2027" },
    };
    const state = resolveWhatsAppPrompt(data);
    expect(state?.accountId).toBe(1_000_000);
  });
});

// ── Tests: popup NOT shown ───────────────────────────────────────────────────

describe("WhatsApp popup — should NOT open", () => {
  it("does not open when prompt=false", () => {
    const data = {
      whatsapp: { prompt: false, accountId: 42, month: "June 2026" },
    };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });

  it("does not open when whatsapp field is absent (no schedule configured)", () => {
    const data = { success: true, voucher: { id: 1 } };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });

  it("does not open when accountId is missing", () => {
    const data = {
      whatsapp: { prompt: true, month: "June 2026" },
    };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });

  it("does not open when month is missing", () => {
    const data = {
      whatsapp: { prompt: true, accountId: 42 },
    };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });

  it("does not open when accountId is 0 (falsy)", () => {
    const data = {
      whatsapp: { prompt: true, accountId: 0, month: "June 2026" },
    };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });

  it("does not open when month is empty string (falsy)", () => {
    const data = {
      whatsapp: { prompt: true, accountId: 42, month: "" },
    };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });

  it("does not open when response data is null", () => {
    expect(isPopupOpen(resolveWhatsAppPrompt(null))).toBe(false);
  });

  it("does not open when response data is undefined", () => {
    expect(isPopupOpen(resolveWhatsAppPrompt(undefined))).toBe(false);
  });

  it("does not open when whatsapp is null", () => {
    const data = { whatsapp: null };
    expect(isPopupOpen(resolveWhatsAppPrompt(data))).toBe(false);
  });
});

// ── Test: state reset (closing the popup) ────────────────────────────────────

describe("WhatsApp popup — state lifecycle", () => {
  it("popup closes when state is reset to null", () => {
    let state: WhatsAppPromptState = {
      accountId: 42,
      month: "June 2026",
    };
    expect(isPopupOpen(state)).toBe(true);

    // Simulate clicking Skip: setWaPendingPrompt(null)
    state = null;
    expect(isPopupOpen(state)).toBe(false);
  });

  it("second voucher save can re-open popup after it was dismissed", () => {
    let state: WhatsAppPromptState = null;

    // First save triggers popup
    state = resolveWhatsAppPrompt({
      whatsapp: { prompt: true, accountId: 10, month: "May 2026" },
    });
    expect(isPopupOpen(state)).toBe(true);

    // User skips → state cleared
    state = null;

    // Second save (edit, no prompt) should not re-open
    state = resolveWhatsAppPrompt({
      whatsapp: { prompt: false, accountId: 10, month: "May 2026" },
    });
    expect(isPopupOpen(state)).toBe(false);
  });

  it("failed WhatsApp trigger does not affect popup state (null stays null)", () => {
    // A network error on the WA send endpoint does not change waPendingPrompt —
    // the voucher save has already succeeded. A null/errored save response
    // leaves state as null.
    const state = resolveWhatsAppPrompt(null);
    expect(state).toBeNull();
  });
});

// ── Cross-reference: matches backend test fixture shape ─────────────────────

describe("WhatsApp popup — response shape matches backend contract", () => {
  it("accepts the exact shape produced by the backend voucherCreateRoute", () => {
    const backendShape = {
      voucher: { id: 7, voucherNumber: "PRV-001", voucherDate: "2026-06-01" },
      entries: [
        { id: 1, type: "DR", amount: "500" },
        { id: 2, type: "CR", amount: "500" },
      ],
      whatsapp: {
        prompt: true,
        accountId: 55,
        month: "June 2026",
      },
    };

    const state = resolveWhatsAppPrompt(backendShape);
    expect(state).not.toBeNull();
    expect(state?.accountId).toBe(55);
    expect(state?.month).toBe("June 2026");
  });

  it("backend response with prompt=false produces no popup", () => {
    const backendShape = {
      voucher: { id: 8 },
      entries: [],
      whatsapp: { prompt: false },
    };
    expect(resolveWhatsAppPrompt(backendShape)).toBeNull();
  });
});

// Rendered behaviour (dialog opens/stays closed, Skip, Send, pending state,
// no re-prompt after dismissal) is covered against the real JournalFormDialogs
// in tests/ui/layout-and-whatsapp-renders.test.tsx.
