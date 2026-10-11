/**
 * Phase 29: a voucher edit refused with 409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD
 * offers a Reverse action that posts POST /api/vouchers/:id/reverse.
 * (Phases 23–29 integration: behavioural replacement of the source-text pin
 * the phase 29 backend test carried.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastMock.mockReset();
});

describe("closed-period refusal", () => {
  it("keeps the code and the voucher id on the API error", async () => {
    const { apiRequest } = await import("@/lib/queryClient");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD",
              message: "The voucher is in a closed period. Reverse it instead.",
              voucherId: 42,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    await expect(apiRequest("GET", "/api/vouchers/42")).rejects.toMatchObject({
      status: 409,
      code: "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD",
      voucherId: 42,
    });
  });

  it("offers Reverse only for that refusal, and the action posts the reversal with the reason", async () => {
    const queryClientModule = await import("@/lib/queryClient");
    const apiRequest = vi.spyOn(queryClientModule, "apiRequest").mockResolvedValue(new Response("{}", { status: 200 }));
    vi.spyOn(queryClientModule.queryClient, "invalidateQueries").mockResolvedValue(undefined);
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "posted in the wrong month")
    );
    const { offerReverseInstead, isClosedPeriodReverseInstead } = await import("@/components/voucherReverseInstead");

    const refusal = { code: "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD", message: "Closed", voucherId: 42 };
    expect(isClosedPeriodReverseInstead(refusal)).toBe(true);
    expect(offerReverseInstead({ code: "OTHER" }, 42)).toBe(false);
    expect(offerReverseInstead(refusal, null)).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();

    expect(offerReverseInstead(refusal, 42)).toBe(true);
    const shown = toastMock.mock.calls[0][0] as { action: { props: { onClick: () => void } } };
    shown.action.props.onClick();
    await vi.waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/vouchers/42/reverse", {
        reason: "posted in the wrong month",
      })
    );
  });
});
